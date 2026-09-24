import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import process from 'node:process'
import { URL } from 'node:url'

import { parseServerEnvironment } from '../packages/config/dist/index.js'
import {
  closeDatabase,
  createGuestSession,
  database,
  executeGameplayCommand,
  startCurrentAttempt,
} from '../packages/database/dist/index.js'
import { createComposedApplication } from '../apps/api/dist/server.js'

const adminUrl = new URL(process.env.LOREMASTER_E2E_ADMIN_DATABASE_URL ?? '')
const isDisposableDatabase =
  process.env.LOREMASTER_E2E_DISPOSABLE === 'true' &&
  ['127.0.0.1', 'localhost', '[::1]'].includes(adminUrl.hostname) &&
  adminUrl.pathname === '/loremaster_e2e'
if (!isDisposableDatabase) {
  throw new Error('E2E controls require the disposable loopback database')
}

const config = parseServerEnvironment(process.env)
const runtimeUrl = new URL(config.databaseUrl)
const runtimeMatchesDisposable =
  config.mode === 'local' &&
  runtimeUrl.protocol === adminUrl.protocol &&
  runtimeUrl.hostname === adminUrl.hostname &&
  runtimeUrl.port === adminUrl.port &&
  runtimeUrl.pathname === adminUrl.pathname &&
  runtimeUrl.username.startsWith('loremaster_e2e_')
if (!runtimeMatchesDisposable) {
  throw new Error('E2E runtime must use the disposable loopback database')
}
const runtimeDatabase = database(config.databaseUrl)
const adminDatabase = database(adminUrl.href)
const controlToken = process.env.LOREMASTER_E2E_CONTROL_TOKEN
if (controlToken === undefined || controlToken.length < 32) {
  throw new Error('LOREMASTER_E2E_CONTROL_TOKEN is required')
}
const application = createComposedApplication({
  config,
  database: runtimeDatabase,
})

function json(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  })
  response.end(JSON.stringify(body))
}

async function rollover() {
  const client = await adminDatabase.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      'ALTER TABLE loremaster.case_revisions DISABLE TRIGGER USER',
    )
    const temporalChecks = await client.query(
      `SELECT format(
         'ALTER TABLE loremaster.case_revisions DROP CONSTRAINT %I',
         conname
       ) AS statement
       FROM pg_constraint
       WHERE conrelid = 'loremaster.case_revisions'::regclass
         AND contype = 'c'
         AND (
           pg_get_constraintdef(oid) LIKE '%opens_at%'
           OR pg_get_constraintdef(oid) LIKE '%closes_at%'
           OR pg_get_constraintdef(oid) LIKE '%slot_id%'
         )`,
    )
    if (temporalChecks.rowCount === 0)
      throw new Error('Temporal case revision checks were not found')
    for (const { statement } of temporalChecks.rows) {
      await client.query(statement)
    }
    await client.query(
      'ALTER TABLE loremaster.case_revisions DROP CONSTRAINT published_case_windows_do_not_overlap',
    )
    await client.query(
      `UPDATE loremaster.case_revisions
       SET opens_at = CASE WHEN slot_id = $1::date THEN clock_timestamp() - interval '1 day' ELSE clock_timestamp() - interval '1 second' END,
           closes_at = CASE WHEN slot_id = $1::date THEN clock_timestamp() ELSE clock_timestamp() + interval '1 day' END`,
      [process.env.LOREMASTER_E2E_FIRST_SLOT],
    )
    await client.query(
      'ALTER TABLE loremaster.case_revisions ENABLE TRIGGER USER',
    )
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

async function expireSessions() {
  const client = await adminDatabase.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      'ALTER TABLE loremaster.guest_sessions DISABLE TRIGGER USER',
    )
    await client.query(
      `UPDATE loremaster.guest_sessions
       SET created_at = clock_timestamp() - interval '29 days',
           expires_at = clock_timestamp() - interval '1 second'`,
    )
    await client.query(
      'ALTER TABLE loremaster.guest_sessions ENABLE TRIGGER USER',
    )
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

async function injectRawHostileText() {
  const marker = process.env.LOREMASTER_E2E_RAW_HOSTILE_MARKER
  if (marker === undefined) throw new Error('Raw hostile marker is required')
  const client = await adminDatabase.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      'ALTER TABLE loremaster.case_revisions DISABLE TRIGGER USER',
    )
    const updated = await client.query(
      `UPDATE loremaster.case_revisions
       SET briefing = briefing || ' ' || $1::text
       WHERE slot_id <> $2::date`,
      [marker, process.env.LOREMASTER_E2E_FIRST_SLOT],
    )
    if (updated.rowCount !== 1)
      throw new Error('Raw hostile fixture was not unique')
    await client.query(
      'ALTER TABLE loremaster.case_revisions ENABLE TRIGGER USER',
    )
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

async function seedLeaderboard() {
  const count = await adminDatabase.query(
    `SELECT count(*)::integer AS count
     FROM loremaster.leaderboard_entries
     WHERE slot_id = $1::date`,
    [process.env.LOREMASTER_E2E_FIRST_SLOT],
  )
  const missing = Math.max(0, 26 - (count.rows[0]?.count ?? 0))
  for (let index = 0; index < missing; index += 1) {
    const session = await createGuestSession(runtimeDatabase)
    const started = await startCurrentAttempt(runtimeDatabase, {
      guestId: session.guestId,
      sessionId: session.sessionId,
      idempotencyKey: randomUUID(),
    })
    if (!started.ok)
      throw new Error(`leaderboard start failed: ${started.code}`)
    const solved = await executeGameplayCommand(runtimeDatabase, {
      guestId: session.guestId,
      sessionId: session.sessionId,
      attemptId: started.projection.attemptId,
      expectedVersion: started.projection.version,
      idempotencyKey: randomUUID(),
      command: { kind: 'GUESS', entityId: 'mira-vale' },
    })
    if (!solved.ok) throw new Error(`leaderboard solve failed: ${solved.code}`)
  }
}

const server = createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/__e2e/ready') {
    json(response, 200, { ready: true })
    return
  }
  const controls = {
    '/__e2e/expire-sessions': expireSessions,
    '/__e2e/inject-hostile': injectRawHostileText,
    '/__e2e/rollover': rollover,
    '/__e2e/seed-leaderboard': seedLeaderboard,
  }
  const control =
    request.method === 'POST' &&
    request.headers.authorization === `Bearer ${controlToken}`
      ? controls[request.url]
      : undefined
  if (control !== undefined) {
    void control().then(
      () => json(response, 200, { ok: true }),
      (error) => {
        process.stderr.write(
          `E2E control failed: ${error instanceof Error ? error.message : String(error)}\n`,
        )
        json(response, 500, { ok: false })
      },
    )
    return
  }
  application(request, response)
})

server.listen(config.port, '127.0.0.1', () => {
  process.stdout.write(
    `Loremaster E2E API listening on 127.0.0.1:${config.port}\n`,
  )
})

let stopping = false
async function stop() {
  if (stopping) return
  stopping = true
  await new Promise((resolve) => server.close(resolve))
  await Promise.all([
    closeDatabase(runtimeDatabase),
    closeDatabase(adminDatabase),
  ])
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    void stop().finally(() => process.exit())
  })
}
