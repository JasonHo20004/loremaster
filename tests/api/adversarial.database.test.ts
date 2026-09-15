import { createHash, randomUUID } from 'node:crypto'

import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createApiRuntime, type ApiRuntime } from '../../apps/api/src/server.js'
import { parseServerEnvironment } from '../../packages/config/src/index.js'
import { asterQuayContentPack } from '../../packages/database/dist/content/fixtures/aster-quay.js'
import { importContentPack } from '../../packages/database/dist/content/index.js'
import {
  closeDatabase,
  database,
  type Database,
} from '../../packages/database/dist/index.js'
import { createCaptureTelemetry } from '../../packages/observability/src/index.js'

const migrationUrl = process.env.LOREMASTER_TEST_DATABASE_URL
const runtimeUrl = process.env.LOREMASTER_TEST_RUNTIME_DATABASE_URL
if (migrationUrl === undefined || runtimeUrl === undefined) {
  throw new Error(
    'Database URLs are required; run this file with `pnpm test:api:database`',
  )
}

const origin = 'http://localhost:5173'
const telemetry = createCaptureTelemetry()
let admin: Database
let runtime: ApiRuntime
let baseUrl: string
let slotId: string

interface Actor {
  readonly agent: ReturnType<typeof request.agent>
  readonly authenticationToken: string
  readonly cookie: string
  readonly csrfToken: string
  readonly guestId: string
}

function config() {
  return parseServerEnvironment({
    LOREMASTER_API_MODE: 'local',
    DATABASE_URL: runtimeUrl,
    LOREMASTER_API_ORIGIN: origin,
    LOREMASTER_API_CURSOR_ACTIVE_VERSION: 'attack-v1',
    LOREMASTER_API_CURSOR_ACTIVE_KEY: Buffer.alloc(32, 0x44).toString(
      'base64url',
    ),
  })
}

function cookies(response: request.Response): string[] {
  const header = response.headers['set-cookie']
  if (!Array.isArray(header)) throw new Error('session cookies are missing')
  return header
}

function cookieValue(values: readonly string[], name: string): string {
  const value = values
    .map((item) => new RegExp(`^${name}=([^;]+)`, 'u').exec(item)?.[1])
    .find((item) => item !== undefined)
  if (value === undefined) throw new Error(`${name} cookie is missing`)
  return value
}

async function bootstrap(): Promise<Actor> {
  const agent = request.agent(baseUrl)
  const created = await agent
    .post('/api/v1/session')
    .set('Origin', origin)
    .send({})
    .expect(201)
  const values = cookies(created)
  const authenticationToken = cookieValue(values, 'loremaster_local_session')
  const csrfToken = cookieValue(values, 'loremaster_local_csrf')
  const tokenHash = createHash('sha256')
    .update(authenticationToken, 'utf8')
    .digest()
  const guest = await admin.query<{ guest_id: string }>(
    `SELECT guest_id::text FROM loremaster.guest_sessions
     WHERE token_hash=$1`,
    [tokenHash],
  )
  const guestId = guest.rows[0]?.guest_id
  if (guestId === undefined) throw new Error('created guest is missing')
  return {
    agent,
    authenticationToken,
    csrfToken,
    guestId,
    cookie: `loremaster_local_session=${authenticationToken}; loremaster_local_csrf=${csrfToken}`,
  }
}

async function start(actor: Actor, key = randomUUID()) {
  const response = await actor.agent
    .post('/api/v1/cases/current/attempt')
    .set('Origin', origin)
    .set('Idempotency-Key', key)
    .set('X-CSRF-Token', actor.csrfToken)
    .send({})
    .expect(200)
  return response.body.data.attempt as {
    attemptId: string
    suggestions: Array<{ entityId: string }>
    version: number
  }
}

function command(actor: Actor, attemptId: string, key: string, body: unknown) {
  return actor.agent
    .post(`/api/v1/attempts/${attemptId}/commands`)
    .set('Origin', origin)
    .set('Idempotency-Key', key)
    .set('X-CSRF-Token', actor.csrfToken)
    .send(body)
}

beforeAll(async () => {
  admin = database(migrationUrl)
  slotId = (
    await admin.query<{ slot: string }>(
      "SELECT (clock_timestamp() AT TIME ZONE 'UTC')::date::text AS slot",
    )
  ).rows[0]!.slot
  const close = new Date(`${slotId}T00:00:00.000Z`)
  close.setUTCDate(close.getUTCDate() + 1)
  const marker = randomUUID().replaceAll('-', '')
  const published = await importContentPack(
    admin,
    {
      ...structuredClone(asterQuayContentPack),
      caseId: `api-attack-${marker}`,
      stableKey: `api-attack-${marker}`,
      slotId,
      opensAt: `${slotId}T00:00:00.000Z`,
      closesAt: close.toISOString(),
    },
    'PUBLISH',
  )
  if (!published.ok) throw new Error('adversarial fixture publication failed')
  runtime = createApiRuntime({
    config: config(),
    database: database(runtimeUrl),
    listenPort: 0,
    telemetry,
  })
  baseUrl = `http://127.0.0.1:${await runtime.start()}`
})

afterAll(async () => {
  await runtime.stop()
  await closeDatabase(admin)
})

describe('S5.7 composed adversarial transport', () => {
  it('rejects malformed transport inputs before mutation or receipt creation', async () => {
    const actor = await bootstrap()
    const attempt = await start(actor, 'matrix-start')
    const before = await admin.query<{ receipts: string; version: number }>(
      `SELECT
         (SELECT count(*)::text FROM loremaster.command_receipts
          WHERE guest_id=$1) AS receipts,
         (SELECT version FROM loremaster.attempts WHERE id=$2) AS version`,
      [actor.guestId, attempt.attemptId],
    )
    const path = `/api/v1/attempts/${attempt.attemptId}/commands`
    const validHeaders = {
      Origin: origin,
      'Idempotency-Key': 'invalid-matrix',
      'X-CSRF-Token': actor.csrfToken,
    }
    const cases = [
      actor.agent
        .post(path)
        .set(validHeaders)
        .set('Content-Type', 'application/json')
        .send(
          '{"expectedVersion":0,"expectedVersion":1,"command":{"kind":"REVEAL"}}',
        ),
      actor.agent
        .post(path)
        .set(validHeaders)
        .set('Content-Type', 'application/json')
        .send('{"expectedVersion":'),
      actor.agent
        .post(path)
        .set(validHeaders)
        .send({ expectedVersion: 0, command: { kind: 'REVEAL' }, extra: true }),
      actor.agent
        .post(path)
        .set(validHeaders)
        .send({
          expectedVersion: 0,
          command: { kind: 'GUESS', entityId: 'x'.repeat(81) },
        }),
      actor.agent
        .post(path)
        .set(validHeaders)
        .send({ expectedVersion: '0', command: { kind: 'REVEAL' } }),
      actor.agent
        .post(path)
        .set({
          Origin: origin,
          'Idempotency-Key': ['duplicate-a', 'duplicate-b'],
          'X-CSRF-Token': actor.csrfToken,
        })
        .send({ expectedVersion: 0, command: { kind: 'REVEAL' } }),
      actor.agent
        .post(path)
        .set(validHeaders)
        .set('Content-Type', 'text/plain')
        .send('{}'),
      actor.agent
        .post(path)
        .set({ ...validHeaders, Origin: 'https://attacker.invalid' })
        .send({ expectedVersion: 0, command: { kind: 'REVEAL' } }),
      actor.agent
        .post(path)
        .set({
          Origin: origin,
          'Idempotency-Key': 'missing-csrf',
        })
        .send({ expectedVersion: 0, command: { kind: 'REVEAL' } }),
      actor.agent
        .post(path)
        .set(validHeaders)
        .send({ padding: 'x'.repeat(16 * 1024) }),
    ]
    const responses = await Promise.all(cases)
    expect(responses.map((response) => response.status)).toEqual([
      400, 400, 400, 400, 400, 400, 415, 403, 403, 413,
    ])
    await actor.agent
      .get(`/api/v1/attempts/${attempt.attemptId}/suggestions?q=a&q=b`)
      .expect(400)
    await actor.agent
      .get(`/api/v1/attempts/%2F${attempt.attemptId}`)
      .expect(400)

    const after = await admin.query<{ receipts: string; version: number }>(
      `SELECT
         (SELECT count(*)::text FROM loremaster.command_receipts
          WHERE guest_id=$1) AS receipts,
         (SELECT version FROM loremaster.attempts WHERE id=$2) AS version`,
      [actor.guestId, attempt.attemptId],
    )
    expect(after.rows[0]).toEqual(before.rows[0])
  })

  it('gives unknown, foreign, and terminal attempt contexts one disclosure shape', async () => {
    const owner = await bootstrap()
    const foreign = await bootstrap()
    const attempt = await start(owner, 'guest-scoped-start')
    const foreignAttempt = await start(foreign, 'guest-scoped-start')
    expect(foreignAttempt.attemptId).not.toBe(attempt.attemptId)
    const unknown = randomUUID()

    const unknownRead = await foreign.agent
      .get(`/api/v1/attempts/${unknown}`)
      .expect(404)
    const foreignRead = await foreign.agent
      .get(`/api/v1/attempts/${attempt.attemptId}`)
      .expect(404)
    expect(foreignRead.body.error.code).toBe(unknownRead.body.error.code)

    const ownerGuess = {
      expectedVersion: 0,
      command: { kind: 'GUESS', entityId: 'oren-pell' },
    }
    await command(owner, attempt.attemptId, 'guest-scoped-command', ownerGuess)
      .expect(200)
      .expect((response) => {
        expect(response.body.data.replayed).toBe(false)
      })
    await command(
      foreign,
      attempt.attemptId,
      'guest-scoped-command',
      ownerGuess,
    ).expect(404)
    await command(owner, attempt.attemptId, 'guest-scoped-command', ownerGuess)
      .expect(200)
      .expect((response) => {
        expect(response.body.data.replayed).toBe(true)
      })

    const ownerProfile = await owner.agent.get('/api/v1/profile').expect(200)
    const foreignProfile = await foreign.agent
      .get('/api/v1/profile')
      .expect(200)
    expect(ownerProfile.body.data.currentStreak).toBe(1)
    expect(foreignProfile.body.data.currentStreak).toBe(0)

    await owner.agent
      .get(`/api/v1/attempts/${attempt.attemptId}/suggestions?q=mira`)
      .expect(200)
    const unknownSuggestion = await foreign.agent
      .get(`/api/v1/attempts/${unknown}/suggestions?q=mira`)
      .expect(404)
    const foreignSuggestion = await foreign.agent
      .get(`/api/v1/attempts/${attempt.attemptId}/suggestions?q=mira`)
      .expect(404)
    await command(owner, attempt.attemptId, 'give-up', {
      expectedVersion: 1,
      command: { kind: 'GIVE_UP' },
    }).expect(200)
    const terminalSuggestion = await owner.agent
      .get(`/api/v1/attempts/${attempt.attemptId}/suggestions?q=mira`)
      .expect(404)
    expect([
      unknownSuggestion.body.error.code,
      foreignSuggestion.body.error.code,
      terminalSuggestion.body.error.code,
    ]).toEqual([
      'RESOURCE_NOT_FOUND',
      'RESOURCE_NOT_FOUND',
      'RESOURCE_NOT_FOUND',
    ])
  })

  it('proves canonical replay, changed-key conflict, and a same-version race', async () => {
    const actor = await bootstrap()
    const attempt = await start(actor, 'replay-start')
    const replayedStart = await actor.agent
      .post('/api/v1/cases/current/attempt')
      .set('Origin', origin)
      .set('Idempotency-Key', 'replay-start')
      .set('X-CSRF-Token', actor.csrfToken)
      .send({})
      .expect(200)
    expect(replayedStart.body.data.replayed).toBe(true)

    const first = await command(actor, attempt.attemptId, 'canonical-command', {
      expectedVersion: 0,
      command: { kind: 'REVEAL' },
    }).expect(200)
    const replay = await command(
      actor,
      attempt.attemptId,
      'canonical-command',
      {
        expectedVersion: 0,
        command: { kind: 'REVEAL' },
      },
    ).expect(200)
    expect(first.body.data.replayed).toBe(false)
    expect(replay.body.data.replayed).toBe(true)
    const conflict = await command(
      actor,
      attempt.attemptId,
      'canonical-command',
      {
        expectedVersion: 1,
        command: { kind: 'GIVE_UP' },
      },
    ).expect(409)
    expect(conflict.body.error.code).toBe('IDEMPOTENCY_CONFLICT')

    const raced = await bootstrap()
    const racedAttempt = await start(raced)
    const responses = await Promise.all([
      command(raced, racedAttempt.attemptId, 'race-a', {
        expectedVersion: 0,
        command: { kind: 'REVEAL' },
      }),
      command(raced, racedAttempt.attemptId, 'race-b', {
        expectedVersion: 0,
        command: { kind: 'REVEAL' },
      }),
    ])
    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 409,
    ])
    expect(
      responses.find((response) => response.status === 409)?.body.error.code,
    ).toBe('STALE_VERSION')
  })

  it('rolls back a held-lock timeout and safely recovers with the same key', async () => {
    const actor = await bootstrap()
    const attempt = await start(actor)
    const lock = await admin.connect()
    try {
      await lock.query('BEGIN')
      await lock.query(
        'SELECT 1 FROM loremaster.guests WHERE id=$1 FOR UPDATE',
        [actor.guestId],
      )
      const timedOut = await command(
        actor,
        attempt.attemptId,
        'timeout-recovery',
        { expectedVersion: 0, command: { kind: 'REVEAL' } },
      ).expect(504)
      expect(timedOut.body.error.code).toBe('REQUEST_TIMEOUT')
      const receipt = await admin.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM loremaster.command_receipts
         WHERE guest_id=$1 AND idempotency_key='timeout-recovery'`,
        [actor.guestId],
      )
      expect(receipt.rows[0]?.count).toBe('0')
      await lock.query('ROLLBACK')
      await command(actor, attempt.attemptId, 'timeout-recovery', {
        expectedVersion: 0,
        command: { kind: 'REVEAL' },
      }).expect(200)
    } finally {
      await lock.query('ROLLBACK').catch(() => undefined)
      lock.release()
    }
  })

  it('rejects forged forwarding and enforces bounded guest autocomplete identities', async () => {
    const first = await bootstrap()
    const second = await bootstrap()
    const firstAttempt = await start(first)
    const secondAttempt = await start(second)
    const limitedConfig = {
      ...config(),
      limiter: { ...config().limiter, guestCapacity: 1 },
    } as ReturnType<typeof config>
    const limited = createApiRuntime({
      config: limitedConfig,
      database: database(runtimeUrl),
      listenPort: 0,
    })
    const limitedUrl = `http://127.0.0.1:${await limited.start()}`
    try {
      await request(limitedUrl)
        .get(`/api/v1/attempts/${firstAttempt.attemptId}/suggestions?q=mira`)
        .set('Cookie', first.cookie)
        .set('X-Forwarded-For', '203.0.113.8')
        .expect(403)
      await request(limitedUrl)
        .get(`/api/v1/attempts/${firstAttempt.attemptId}/suggestions?q=mira`)
        .set('Cookie', first.cookie)
        .expect(200)
      const limitedResponse = await request(limitedUrl)
        .get(`/api/v1/attempts/${secondAttempt.attemptId}/suggestions?q=mira`)
        .set('Cookie', second.cookie)
        .expect(429)
      expect(limitedResponse.headers['retry-after']).toMatch(/^\d+$/u)
    } finally {
      await limited.stop()
    }
  })

  it('captures no tokens, guesses, raw URLs, SQL, or high-cardinality metric labels', () => {
    const captured = `${telemetry.logs.serialize()}\n${telemetry.metrics.serialize()}`
    expect(captured).not.toContain('loremaster_local_session=')
    expect(captured).not.toContain('loremaster_local_csrf=')
    expect(captured).not.toContain('canonical-command')
    expect(captured).not.toContain('timeout-recovery')
    expect(captured).not.toContain('mira-vale')
    expect(captured).not.toContain(asterQuayContentPack.briefing)
    expect(captured).not.toContain('SELECT ')
    expect(captured).not.toContain('?q=mira')
    for (const point of telemetry.metrics.points) {
      expect(Object.keys(point.labels).sort()).toEqual([
        'operation',
        'statusClass',
      ])
      expect(point.labels.operation).toMatch(
        /^(?:createSession|getCurrentCase|getOwnedAttempt|getProfile|runGameplayCommand|startCurrentAttempt|getSuggestions|unmatched)$/u,
      )
    }
  })
})
