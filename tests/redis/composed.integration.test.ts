import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApiRuntime, type ApiRuntime } from '../../apps/api/src/server.js'
import { createObserverRuntime } from '../../apps/queue-observer/src/index.js'
import {
  BoundedRedisConnection,
  createSuggestionCacheWriter,
  serializeSuggestionIndex,
} from '../../packages/cache/src/index.js'
import { parseServerEnvironment } from '../../packages/config/src/index.js'
import {
  database,
  migrateToLatest,
  readPublishedSuggestionIndex,
  assertOutsideTransaction,
  type Database,
} from '../../packages/database/src/index.js'
import { asterQuayContentPack } from '../../packages/database/dist/content/fixtures/aster-quay.js'
import { importContentPack } from '../../packages/database/dist/content/index.js'
import { createCaptureTelemetry } from '../../packages/observability/src/index.js'
import {
  createWarmProducer,
  WARM_POLICY,
  warmJobId,
  createWarmWorker,
} from '../../packages/queue/src/index.js'

const Redis = createRequire(
  new URL('../../packages/cache/package.json', import.meta.url),
)('ioredis')
const { Queue } = createRequire(
  new URL('../../packages/queue/package.json', import.meta.url),
)('bullmq')
const redisUrl = process.env.LOREMASTER_TEST_REDIS_URL!
const pgUrl = process.env.LOREMASTER_TEST_DATABASE_URL!
const runtimeUrl = process.env.LOREMASTER_TEST_RUNTIME_DATABASE_URL!
const container = process.env.LOREMASTER_TEST_REDIS_CONTAINER!
if (!redisUrl || !pgUrl || !runtimeUrl || !container)
  throw new Error('Run pnpm test:s7:integration')
const redis = new Redis(redisUrl)
redis.on('error', () => undefined)
const passwords = new Map<string, string>()
const children = new Set<ChildProcess>()
const output: string[] = []
const apis: ApiRuntime[] = []
const telemetry = createCaptureTelemetry()
const origin = 'http://localhost:5173'
let db: Database, revision: string, workerDbUrl: string, producerDbUrl: string
let worker: ChildProcess
let observer: ReturnType<typeof createObserverRuntime>
let producer: ReturnType<typeof createWarmProducer>
let observerPort: number
let ownedPath: string,
  ownedCookie: string,
  ownedCsrf: string,
  ownedAttempt: string
const prefix = 'loremaster:v1:queue:loremaster-warm-v1'
function roleUrl(role: string): string {
  const url = new URL(redisUrl)
  url.username = role
  url.password = passwords.get(role)!
  return url.toString()
}
async function eventually(work: () => Promise<boolean>, milliseconds = 15000) {
  const end = Date.now() + milliseconds
  while (Date.now() < end) {
    try {
      if (await work()) return
    } catch {
      /* dependency may still be recovering */
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('Composed condition did not recover')
}
async function provisionPg(role: string): Promise<string> {
  const login = `s7_${randomUUID().replaceAll('-', '')}`
  const password = randomUUID()
  const sql = await db.query(
    "SELECT format('CREATE ROLE %I LOGIN PASSWORD %L NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE', $1::text, $2::text) AS sql",
    [login, password],
  )
  await db.query(sql.rows[0].sql)
  const grant = await db.query(
    "SELECT format('GRANT %I TO %I', $1::text, $2::text) AS sql",
    [role, login],
  )
  await db.query(grant.rows[0].sql)
  const url = new URL(pgUrl)
  url.username = login
  url.password = password
  return url.toString()
}
function startWorker(): ChildProcess {
  const child = spawn(process.execPath, ['apps/worker/dist/index.js'], {
    windowsHide: true,
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      LOREMASTER_WORKER_REDIS_URL: roleUrl('loremaster_worker'),
      LOREMASTER_WORKER_CACHE_REDIS_URL: roleUrl('loremaster_worker_cache'),
      LOREMASTER_WORKER_DATABASE_URL: workerDbUrl,
      LOREMASTER_WORKER_CONCURRENCY: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout!.on('data', (value) => output.push(String(value)))
  child.stderr!.on('data', (value) => output.push(String(value)))
  children.add(child)
  return child
}
async function kill(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve())
    child.kill('SIGKILL')
  })
  children.delete(child)
}
async function publish(day: string) {
  const marker = randomUUID().replaceAll('-', '')
  const closes = new Date(`${day}T00:00:00Z`)
  closes.setUTCDate(closes.getUTCDate() + 1)
  const result = await importContentPack(
    db,
    {
      ...structuredClone(asterQuayContentPack),
      caseId: `s7-${marker}`,
      stableKey: `s7-${marker}`,
      slotId: day,
      opensAt: `${day}T00:00:00Z`,
      closesAt: closes.toISOString(),
    },
    'PUBLISH',
  )
  if (!result.ok) throw new Error('Fixture publish failed')
  return result.revisionId
}
function config() {
  return parseServerEnvironment({
    LOREMASTER_API_MODE: 'local',
    DATABASE_URL: runtimeUrl,
    LOREMASTER_API_ORIGIN: origin,
    LOREMASTER_API_CURSOR_ACTIVE_VERSION: 's7',
    LOREMASTER_API_CURSOR_ACTIVE_KEY: randomBytes(32).toString('base64url'),
  })
}
beforeAll(async () => {
  db = database(pgUrl)
  await migrateToLatest(db)
  const policy = JSON.parse(readFileSync('ops/redis/acl-policy.json', 'utf8'))
  const inventory = JSON.parse(
    readFileSync('ops/redis/bullmq-script-inventory.json', 'utf8'),
  )
  for (const [role, policyRole] of Object.entries(policy.roles) as [
    string,
    { commands: string[]; patterns: string[]; bullmqRole?: string },
  ][]) {
    const password = randomBytes(24).toString('base64url')
    passwords.set(role, password)
    const commands = new Set([
      'auth',
      'hello',
      'ping',
      'quit',
      'client|setname',
      'client|setinfo',
      ...policyRole.commands,
    ])
    if (policyRole.bullmqRole)
      for (const script of Object.values(inventory.scripts) as {
        roles: string[]
        commands: string[]
      }[])
        if (script.roles.includes(policyRole.bullmqRole))
          for (const command of script.commands) commands.add(command)
    await redis.call(
      'ACL',
      'SETUSER',
      role,
      'reset',
      'on',
      `>${password}`,
      ...policyRole.patterns,
      ...[...commands].map((value) => `+${value}`),
    )
  }
  workerDbUrl = await provisionPg('loremaster_cache_worker')
  producerDbUrl = await provisionPg('loremaster_cache_producer')
  const day = (
    await db.query(
      "SELECT (clock_timestamp() AT TIME ZONE 'UTC')::date::text AS day",
    )
  ).rows[0].day
  revision = await publish(day)
  observer = createObserverRuntime({
    redisUrl: roleUrl('loremaster_observer'),
    port: 0,
  })
  observerPort = await observer.start()
  producer = createWarmProducer(roleUrl('loremaster_producer'), {
    currentRevision: async () => revision,
  })
  worker = startWorker()
  await eventually(
    async () =>
      (await fetch('http://127.0.0.1:3001/health/ready')).status === 200,
  )
}, 30000)
afterAll(async () => {
  await producer?.stop()
  await observer?.stop()
  await Promise.all(apis.map((api) => api.stop()))
  await Promise.all([...children].map(kill))
  redis.disconnect()
  await db?.end()
})

describe('S7 composed PostgreSQL/API/Redis/worker/observer gate', () => {
  it('keeps two-guest API responses and database rows identical on cold/hit/corrupt/restart/off paths', async () => {
    const api = createApiRuntime({
      config: config(),
      database: database(runtimeUrl),
      listenPort: 0,
      telemetry,
      redis: {
        enabled: true,
        cacheUrl: roleUrl('loremaster_api_cache'),
        limiterUrl: roleUrl('loremaster_api_limiter'),
        producerUrl: roleUrl('loremaster_producer'),
        producerDatabaseUrl: producerDbUrl,
        limiterHmacKey: randomBytes(32),
        limiterHmacVersion: 'composed',
      },
    })
    apis.push(api)
    const base = `http://127.0.0.1:${await api.start()}`
    const actor = async () => {
      const agent = request.agent(base)
      const created = await agent
        .post('/api/v1/session')
        .set('Origin', origin)
        .send({})
        .expect(201)
      const cookies = created.headers['set-cookie'] as unknown as string[]
      const csrf = cookies
        .map((value) => /^loremaster_local_csrf=([^;]+)/u.exec(value)?.[1])
        .find(Boolean)!
      const cookie = cookies.map((value) => value.split(';')[0]).join('; ')
      const result = await agent
        .post('/api/v1/cases/current/attempt')
        .set('Origin', origin)
        .set('X-CSRF-Token', csrf)
        .set('Idempotency-Key', randomUUID())
        .send({})
        .expect(200)
      return { agent, csrf, cookie, attempt: result.body.data.attempt }
    }
    const first = await actor(),
      second = await actor()
    const attemptId = first.attempt.attemptId
    const path = `/api/v1/attempts/${attemptId}/suggestions?q=a`
    ownedPath = path
    ownedCookie = first.cookie
    ownedCsrf = first.csrf
    ownedAttempt = attemptId
    await second.agent
      .post(`/api/v1/attempts/${second.attempt.attemptId}/commands`)
      .set('Origin', origin)
      .set('X-CSRF-Token', second.csrf)
      .set('Idempotency-Key', 'second-evidence')
      .send({ expectedVersion: 0, command: { kind: 'REVEAL' } })
      .expect(200)
    // Warm/cache data is shared; attempt authorization remains separate for each guest.
    const key = `loremaster:v1:revision:${revision}:suggestions`
    await redis.del(key)
    const cold = (await first.agent.get(path).expect(200)).body
    const before = (
      await db.query('SELECT * FROM loremaster.attempts ORDER BY id')
    ).rows
    await producer.reconcile()
    await eventually(async () => (await redis.exists(key)) === 1)
    expect((await first.agent.get(path).expect(200)).body).toEqual(cold)
    await second.agent.get(path).expect(404)
    await redis.set(key, '{"version":999,"secret":"POISON_HTTP_BODY"}')
    expect((await first.agent.get(path).expect(200)).body).toEqual(cold)
    await second.agent.get(path).expect(404)
    execFileSync('docker', ['restart', container], { stdio: 'pipe' })
    await eventually(async () => (await redis.ping()) === 'PONG')
    // ACLs are ephemeral operator policy; reprovision after an actual server restart.
    for (const role of passwords.keys()) {
      const policy = JSON.parse(
        readFileSync('ops/redis/acl-policy.json', 'utf8'),
      ).roles[role]
      const inv = JSON.parse(
        readFileSync('ops/redis/bullmq-script-inventory.json', 'utf8'),
      )
      const commands = new Set([
        'auth',
        'hello',
        'ping',
        'quit',
        'client|setname',
        'client|setinfo',
        ...policy.commands,
      ])
      if (policy.bullmqRole)
        for (const script of Object.values(inv.scripts) as {
          roles: string[]
          commands: string[]
        }[])
          if (script.roles.includes(policy.bullmqRole))
            script.commands.forEach((value) => commands.add(value))
      await redis.call(
        'ACL',
        'SETUSER',
        role,
        'reset',
        'on',
        `>${passwords.get(role)}`,
        ...policy.patterns,
        ...[...commands].map((value) => `+${value}`),
      )
    }
    expect((await first.agent.get(path).expect(200)).body).toEqual(cold)
    await eventually(
      async () =>
        (await fetch('http://127.0.0.1:3001/health/ready')).status === 200,
    )
    const off = createApiRuntime({
      config: config(),
      database: database(runtimeUrl),
      listenPort: 0,
    })
    apis.push(off)
    const offBase = `http://127.0.0.1:${await off.start()}`
    expect(
      (await request(offBase).get(path).set('Cookie', first.cookie).expect(200))
        .body,
    ).toEqual(cold)
    await request(offBase).get(path).set('Cookie', second.cookie).expect(404)
    expect(
      (await db.query('SELECT * FROM loremaster.attempts ORDER BY id')).rows,
    ).toEqual(before)
    const metrics = await fetch(
      `http://127.0.0.1:${observerPort}/metrics`,
    ).then((response) => response.text())
    await producer.reconcile()
    await eventually(
      async () => (await redis.get(key))?.startsWith('{"version":1,') === true,
    )
    const stored = await redis.get(key)
    const job = await redis.hgetall(`${prefix}:${warmJobId(revision)}`)
    expect(JSON.parse(job.data)).toEqual({ version: 1, revisionId: revision })
    expect(
      metrics +
        telemetry.logs.serialize() +
        output.join('') +
        stored +
        JSON.stringify(job),
    ).not.toMatch(
      new RegExp(
        [
          attemptId,
          first.csrf,
          'POISON_HTTP_BODY',
          new URL(workerDbUrl).password,
        ].join('|'),
        'u',
      ),
    )
  }, 45000)

  it('survives real OOM and PG loss, keeps liveness, and resumes after dependencies recover', async () => {
    const connection = new BoundedRedisConnection(
      roleUrl('loremaster_worker_cache'),
      'worker',
    )
    try {
      const index = await readPublishedSuggestionIndex(db, revision)
      expect(index).toBeDefined()
      await redis.call('CONFIG', 'SET', 'maxmemory', '1')
      await expect(
        createSuggestionCacheWriter(connection, {
          assertOutsideTransaction,
        }).set(index!),
      ).rejects.toThrow()
      expect((await fetch('http://127.0.0.1:3001/health/live')).status).toBe(
        200,
      )
    } finally {
      await redis.call('CONFIG', 'SET', 'maxmemory', '134217728')
      connection.close()
    }
    const login = new URL(workerDbUrl).username
    await db.query(`ALTER ROLE ${login} NOLOGIN`)
    await db.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename=$1 AND pid<>pg_backend_pid()',
      [new URL(workerDbUrl).username],
    )
    try {
      await eventually(
        async () =>
          (await fetch('http://127.0.0.1:3001/health/ready')).status === 503,
      )
      expect((await fetch('http://127.0.0.1:3001/health/live')).status).toBe(
        200,
      )
    } finally {
      await db.query(`ALTER ROLE ${login} LOGIN`)
    }
    await eventually(
      async () =>
        (await fetch('http://127.0.0.1:3001/health/ready')).status === 200,
    )
  }, 20000)

  it('retries safely after worker kill with an active PostgreSQL read and never exposes a partial value', async () => {
    const client = await db.connect()
    const key = `loremaster:v1:revision:${revision}:suggestions`
    try {
      await client.query('BEGIN')
      await client.query(
        'LOCK TABLE loremaster.case_entities IN ACCESS EXCLUSIVE MODE',
      )
      await redis.del(key)
      await producer.reconcile()
      await eventually(async () => (await redis.llen(`${prefix}:active`)) === 1)
      await kill(worker)
      expect(await redis.get(key)).toBeNull()
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
    worker = startWorker()
    await eventually(async () => (await redis.exists(key)) === 1, 30000)
    const expected = await readPublishedSuggestionIndex(db, revision)
    expect(await redis.get(key)).toBe(serializeSuggestionIndex(expected!))
  }, 45000)

  it('persists only bounded transient reasons and terminally handles excessive retry options', async () => {
    await kill(worker)
    const queue = new Queue('loremaster-warm-v1', {
      prefix: 'loremaster:v1:queue',
      connection: redis,
    })
    const id = randomUUID()
    try {
      await queue.add(
        'warm-current-revision-v1',
        { version: 1, revisionId: id },
        { jobId: warmJobId(id), attempts: 999, stackTraceLimit: 999 },
      )
      worker = startWorker()
      await eventually(
        async () =>
          (await queue.getJob(warmJobId(id)))
            ?.getState()
            .then((state: string) => state === 'failed') ?? false,
      )
      const job = await queue.getJob(warmJobId(id))
      expect(job.attemptsMade).toBe(1)
      expect(job.failedReason).toBe('Invalid warm options')
      expect(job.stacktrace).toEqual([])
      expect(output.join('')).not.toMatch(/Error:|postgresql:|redis:\/\/| at /u)
    } finally {
      await queue.close()
    }
  }, 20000)

  it('enforces one healthy ceiling across API replicas and local fallback during Redis loss', async () => {
    const seconds = Number((await redis.time())[0]) % 60
    if (seconds > 35)
      await new Promise((resolve) => setTimeout(resolve, (61 - seconds) * 1000))
    const hmac = randomBytes(32)
    const replicas: string[] = []
    for (let n = 0; n < 2; n++) {
      const api = createApiRuntime({
        config: config(),
        database: database(runtimeUrl),
        listenPort: 0,
        redis: {
          enabled: true,
          cacheUrl: roleUrl('loremaster_api_cache'),
          limiterUrl: roleUrl('loremaster_api_limiter'),
          producerUrl: roleUrl('loremaster_producer'),
          producerDatabaseUrl: producerDbUrl,
          limiterHmacKey: hmac,
          limiterHmacVersion: 'replicas',
        },
      })
      apis.push(api)
      replicas.push(`http://127.0.0.1:${await api.start()}`)
    }
    const healthy: number[] = []
    for (let n = 0; n < 12; n++)
      healthy.push(
        (
          await request(replicas[n % 2]!)
            .post('/api/v1/session')
            .set('Origin', origin)
            .send({})
        ).status,
      )
    expect(healthy.filter((code) => code === 201)).toHaveLength(10)
    expect(healthy.filter((code) => code === 429)).toHaveLength(2)
    execFileSync('docker', ['pause', container], { stdio: 'pipe' })
    try {
      await request(replicas[0]!).get('/health/ready').expect(200)
      expect((await fetch('http://127.0.0.1:3001/health/live')).status).toBe(
        200,
      )
      expect((await fetch('http://127.0.0.1:3001/health/ready')).status).toBe(
        503,
      )
      expect(
        (await fetch(`http://127.0.0.1:${observerPort}/health/ready`)).status,
      ).toBe(503)
      expect(
        (await fetch(`http://127.0.0.1:${observerPort}/health/live`)).status,
      ).toBe(200)
      await request(replicas[0]!)
        .get(ownedPath)
        .set('Cookie', ownedCookie)
        .expect(200)
      const commandPath = `/api/v1/attempts/${ownedAttempt}/commands`
      const command = await request(replicas[0]!)
        .post(commandPath)
        .set('Cookie', ownedCookie)
        .set('Origin', origin)
        .set('X-CSRF-Token', ownedCsrf)
        .set('Idempotency-Key', 'redis-outage-reveal')
        .send({ expectedVersion: 0, command: { kind: 'REVEAL' } })
        .expect(200)
      expect(command.body.data.replayed).toBe(false)
      const rows = (
        await db.query('SELECT * FROM loremaster.attempts WHERE id=$1', [
          ownedAttempt,
        ])
      ).rows
      const replay = await request(replicas[1]!)
        .post(commandPath)
        .set('Cookie', ownedCookie)
        .set('Origin', origin)
        .set('X-CSRF-Token', ownedCsrf)
        .set('Idempotency-Key', 'redis-outage-reveal')
        .send({ expectedVersion: 0, command: { kind: 'REVEAL' } })
        .expect(200)
      expect(replay.body.data.replayed).toBe(true)
      expect(
        (
          await db.query('SELECT * FROM loremaster.attempts WHERE id=$1', [
            ownedAttempt,
          ])
        ).rows,
      ).toEqual(rows)
      for (const base of replicas) {
        for (let n = 0; n < 4; n++)
          await request(base)
            .post('/api/v1/session')
            .set('Origin', origin)
            .send({})
            .expect(201)
        await request(base)
          .post('/api/v1/session')
          .set('Origin', origin)
          .send({})
          .expect(429)
      }
    } finally {
      execFileSync('docker', ['unpause', container], { stdio: 'pipe' })
    }
    await eventually(
      async () =>
        (await fetch('http://127.0.0.1:3001/health/ready')).status === 200,
    )
  }, 60000)

  it('repairs the PostgreSQL-selected current revision after an outage spanning a UTC slot change', async () => {
    const next = new Date()
    next.setUTCDate(next.getUTCDate() + 1)
    const nextDay = next.toISOString().slice(0, 10)
    const nextRevision = await publish(nextDay)
    const producerDb = database(producerDbUrl)
    const { readCurrentPublishedRevision } =
      await import('../../packages/database/src/index.js')
    const recovery = createWarmProducer(roleUrl('loremaster_producer'), {
      currentRevision: (signal) =>
        readCurrentPublishedRevision(producerDb, {
          deadlineAt: Date.now() + 1000,
          now: Date.now,
          signal,
        }),
    })
    const original = (
      await db.query(
        'SELECT id,opens_at,closes_at FROM loremaster.case_revisions WHERE id=ANY($1::uuid[])',
        [[nextRevision, revision]],
      )
    ).rows
    const constraints = (
      await db.query(
        "SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='loremaster.case_revisions'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%opens_at%'",
      )
    ).rows
    // Simulate a slot boundary only in this disposable database; restore all temporal invariants below.
    for (const constraint of constraints)
      await db.query(
        `ALTER TABLE loremaster.case_revisions DROP CONSTRAINT ${constraint.conname}`,
      )
    execFileSync('docker', ['pause', container], { stdio: 'pipe' })
    try {
      await recovery.reconcile()
      // Disposable database only: shift tomorrow's slot onto current server time.
      await db.query(
        'ALTER TABLE loremaster.case_revisions DISABLE TRIGGER USER',
      )
      try {
        await db.query(
          "UPDATE loremaster.case_revisions SET closes_at=clock_timestamp()-interval '1 second' WHERE id=$1",
          [revision],
        )
        await db.query(
          "UPDATE loremaster.case_revisions SET opens_at=clock_timestamp()-interval '1 second' WHERE id=$1",
          [nextRevision],
        )
      } finally {
        await db.query(
          'ALTER TABLE loremaster.case_revisions ENABLE TRIGGER USER',
        )
      }
    } finally {
      execFileSync('docker', ['unpause', container], { stdio: 'pipe' })
    }
    try {
      await eventually(
        async () =>
          (await redis.exists(
            `loremaster:v1:revision:${nextRevision}:suggestions`,
          )) === 1,
      )
      expect(await readCurrentPublishedRevision(producerDb)).toBe(nextRevision)
      expect(
        await redis.ttl(`loremaster:v1:revision:${revision}:suggestions`),
      ).toBeGreaterThan(0)
    } finally {
      await recovery.stop()
      await producerDb.end()
      await db.query(
        'ALTER TABLE loremaster.case_revisions DISABLE TRIGGER USER',
      )
      try {
        for (const id of [nextRevision, revision]) {
          const row = original.find((value) => value.id === id)!
          await db.query(
            'UPDATE loremaster.case_revisions SET opens_at=$2,closes_at=$3 WHERE id=$1',
            [id, row.opens_at, row.closes_at],
          )
        }
        for (const constraint of constraints)
          await db.query(
            `ALTER TABLE loremaster.case_revisions ADD CONSTRAINT ${constraint.conname} ${constraint.definition}`,
          )
      } finally {
        await db.query(
          'ALTER TABLE loremaster.case_revisions ENABLE TRIGGER USER',
        )
      }
    }
  }, 30000)

  it('scrubs large secret-bearing transient errors from stored BullMQ hashes', async () => {
    await kill(worker)
    const queue = new Queue('loremaster-warm-v1', {
      prefix: 'loremaster:v1:queue',
      connection: redis,
    })
    const transient = createWarmWorker(roleUrl('loremaster_worker'), 1, {
      readIndex: async () => {
        throw new Error('PRIVATE_TOKEN_SENTINEL' + 'x'.repeat(20000))
      },
      writeIndex: async () => undefined,
    })
    const id = randomUUID()
    try {
      await transient.start()
      await queue.add(
        'warm-current-revision-v1',
        { version: 1, revisionId: id },
        { jobId: warmJobId(id), attempts: 3, stackTraceLimit: 0 },
      )
      await eventually(
        async () =>
          (await queue.getJob(warmJobId(id)))
            ?.getState()
            .then((state: string) => state === 'failed') ?? false,
      )
      const job = await queue.getJob(warmJobId(id))
      expect(job.attemptsMade).toBe(3)
      expect(job.failedReason).toBe('Warm dependency unavailable')
      expect(
        JSON.stringify(await redis.hgetall(`${prefix}:${warmJobId(id)}`)),
      ).not.toContain('PRIVATE_TOKEN_SENTINEL')
    } finally {
      await transient.stop()
      await queue.close()
      worker = startWorker()
    }
  }, 20000)

  it('measures full namespace admission overhead with at least 64 MiB instance headroom', async () => {
    // Disposable admin-only measurement uses exact keys and actual MEMORY USAGE.
    const keys: string[] = []
    for (let n = 0; n < 15; n++) {
      const key = `loremaster:v1:revision:budget-${n}:suggestions`
      keys.push(key)
      await redis.set(key, 'x'.repeat(512 * 1024), 'EX', 60)
    }
    let cacheBytes = 0
    for (const key of keys)
      cacheBytes += Number(await redis.call('MEMORY', 'USAGE', key))
    expect(cacheBytes).toBeLessThan(16 * 1024 * 1024)
    await redis.del(...keys)
    const queueKeys: string[] = []
    for (let n = 0; n < 384; n++) {
      const key = `${prefix}:budget-${n}`
      queueKeys.push(key)
      await redis.hset(
        key,
        'data',
        'x'.repeat(WARM_POLICY.maximumStoredJobBytes),
      )
    }
    let queueBytes = 0
    for (const key of queueKeys)
      queueBytes += Number(await redis.call('MEMORY', 'USAGE', key))
    expect(queueBytes).toBeLessThan(32 * 1024 * 1024)
    await redis.del(...queueKeys)
    const limiterKeys: string[] = []
    const registry = 'loremaster:v1:limit:capacity'
    for (let offset = 0; offset < 19998; offset += 500) {
      const batch = redis.pipeline()
      for (let n = offset; n < Math.min(offset + 500, 19998); n++) {
        const key = `loremaster:v1:limit:budget:99999999:autocomplete:guest:${n.toString(16).padStart(64, '0')}`
        limiterKeys.push(key)
        batch.set(key, '1', 'EX', 61)
        batch.zadd(registry, Date.now() + 61000, key)
      }
      await batch.exec()
    }
    let limiterBytes = Number(await redis.call('MEMORY', 'USAGE', registry))
    for (let offset = 0; offset < limiterKeys.length; offset += 500) {
      const batch = redis.pipeline()
      limiterKeys
        .slice(offset, offset + 500)
        .forEach((key) => batch.call('MEMORY', 'USAGE', key))
      for (const [error, value] of await batch.exec()) {
        expect(error).toBeNull()
        limiterBytes += Number(value ?? 0)
      }
    }
    expect(limiterBytes).toBeLessThan(16 * 1024 * 1024)
    const info = await redis.info('memory')
    const used = Number(/^used_memory:(\d+)/mu.exec(info)?.[1])
    expect(cacheBytes + queueBytes + used).toBeLessThan(64 * 1024 * 1024)
    process.stdout.write(
      `S7 admission measurement: cache=${cacheBytes}, queue=${queueBytes}, limiter=${limiterBytes}, combined-with-instance=${cacheBytes + queueBytes + used}\n`,
    )
    await redis.del(...limiterKeys, registry)
  }, 30000)

  it('cleans terminal poison history to the frozen retention and bounded event stream', async () => {
    await eventually(
      async () =>
        (await fetch('http://127.0.0.1:3001/health/ready')).status === 200,
    )
    const queue = new Queue('loremaster-warm-v1', {
      prefix: 'loremaster:v1:queue',
      connection: redis,
    })
    try {
      let lastId = ''
      for (let n = 0; n < 140; n++) {
        const id = randomUUID()
        lastId = warmJobId(id)
        await queue.add(
          'warm-current-revision-v1',
          { version: 1, revisionId: id, extra: 'poison' },
          { jobId: lastId, attempts: 3, stackTraceLimit: 0 },
        )
      }
      await eventually(
        async () =>
          (await queue.getJob(lastId))
            ?.getState()
            .then((state: string) => state === 'failed') ?? false,
      )
      expect(await redis.zcard(`${prefix}:failed`)).toBeLessThanOrEqual(
        WARM_POLICY.removeOnFail.count,
      )
      expect(await redis.xlen(`${prefix}:events`)).toBeLessThanOrEqual(
        WARM_POLICY.maximumEvents,
      )
    } finally {
      await queue.close()
    }
  }, 20000)
})
