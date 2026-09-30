import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  BoundedRedisConnection,
  createRedisSharedLimiter,
  createSuggestionCacheReader,
  createSuggestionCacheWriter,
  digestLimitIdentity,
  type SuggestionIndex,
} from '../../packages/cache/src/index.js'
import {
  createWarmProducer,
  createWarmWorker,
  warmJobId,
} from '../../packages/queue/src/index.js'

const require = createRequire(
  new URL('../../packages/cache/package.json', import.meta.url),
)
const Redis = require('ioredis')
const { Queue } = createRequire(
  new URL('../../packages/queue/package.json', import.meta.url),
)('bullmq')
const adminUrl = process.env.LOREMASTER_TEST_REDIS_URL
if (!adminUrl) throw new Error('Run with node scripts/redis-test.mjs')
const admin = new Redis(adminUrl)
const inventory = JSON.parse(
  readFileSync(
    new URL('../../ops/redis/bullmq-script-inventory.json', import.meta.url),
    'utf8',
  ),
)
const aclPolicy = JSON.parse(
  readFileSync(
    new URL('../../ops/redis/acl-policy.json', import.meta.url),
    'utf8',
  ),
) as {
  roles: Record<
    string,
    {
      patterns: string[]
      commands: string[]
      bullmqRole?: 'producer' | 'worker'
    }
  >
}
const revisionId = '12345678-1234-1234-1234-123456789abc'
const index: SuggestionIndex = { version: 1, revisionId, entities: [] }
const cacheKey = `loremaster:v1:revision:${revisionId}:suggestions`
const connections: BoundedRedisConnection[] = []
const credentials = new Map<string, string>()

function roleUrl(name: string): string {
  const url = new URL(adminUrl!)
  url.username = name
  url.password = credentials.get(name)!
  return url.toString()
}
async function user(
  name: string,
  patterns: string[],
  commands: string[],
): Promise<void> {
  const password = randomBytes(24).toString('base64url')
  credentials.set(name, password)
  await admin.call(
    'ACL',
    'SETUSER',
    name,
    'reset',
    'on',
    `>${password}`,
    ...patterns,
    ...commands.map((command) => `+${command}`),
  )
}
function connection(
  name: string,
  profile: 'api-cache' | 'api-limiter' | 'worker',
): BoundedRedisConnection {
  const client = new BoundedRedisConnection(roleUrl(name), profile)
  connections.push(client)
  return client
}
async function eventually(check: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('Redis integration condition did not become true')
}

beforeAll(async () => {
  const common = [
    'auth',
    'hello',
    'ping',
    'quit',
    'client|setname',
    'client|setinfo',
  ]
  for (const [name, role] of Object.entries(aclPolicy.roles)) {
    const commands = new Set([...common, ...role.commands])
    if (role.bullmqRole)
      for (const script of Object.values(inventory.scripts) as {
        roles: string[]
        commands: string[]
      }[])
        if (script.roles.includes(role.bullmqRole))
          for (const command of script.commands) commands.add(command)
    await user(name, role.patterns, [...commands])
  }
})
afterAll(async () => {
  for (const client of connections) client.close()
  admin.disconnect()
})

describe('real Redis role and runtime gate', () => {
  it('atomically writes a canonical index with TTL and refuses wrong-role commands', async () => {
    const writer = createSuggestionCacheWriter(
      connection('loremaster_worker_cache', 'worker'),
      { assertOutsideTransaction: () => undefined },
    )
    const reader = createSuggestionCacheReader(
      connection('loremaster_api_cache', 'api-cache'),
      { assertOutsideTransaction: () => undefined },
    )
    await writer.set(index)
    expect(await reader.get(revisionId)).toEqual(index)
    expect(await admin.ttl(cacheKey)).toBeGreaterThan(172_790)
    const wrong = new Redis(roleUrl('loremaster_api_cache'))
    try {
      await expect(wrong.set(cacheKey, 'poison')).rejects.toThrow(/NOPERM/u)
      await expect(wrong.call('KEYS', '*')).rejects.toThrow(/NOPERM/u)
    } finally {
      wrong.disconnect()
    }
    await admin.set(cacheKey, '{"version":2}')
    expect(await reader.get(revisionId)).toBeUndefined()
    await writer.set(index)
  })

  it('shares one atomic ceiling across concurrent clients and rotates HMAC namespaces', async () => {
    const key = randomBytes(32)
    const digest = digestLimitIdentity(key, 'ip', '198.51.100.4')
    const first = createRedisSharedLimiter(
      connection('loremaster_api_limiter', 'api-limiter'),
      'v1',
    )
    const second = createRedisSharedLimiter(
      connection('loremaster_api_limiter', 'api-limiter'),
      'v1',
    )
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        (index % 2 ? first : second).consume({
          counter: 'session',
          ipDigest: digest,
        }),
      ),
    )
    expect(results.filter((result) => result.state === 'allowed')).toHaveLength(
      10,
    )
    expect(results.filter((result) => result.state === 'denied')).toHaveLength(
      10,
    )
    const rotated = createRedisSharedLimiter(
      connection('loremaster_api_limiter', 'api-limiter'),
      'v2',
    )
    expect(
      await rotated.consume({ counter: 'session', ipDigest: digest }),
    ).toMatchObject({ state: 'allowed' })
  })

  it('warms one deterministic job, safely replays it, and keeps ACL roles separate', async () => {
    let warmed = 0
    const events: string[] = []
    const writer = createSuggestionCacheWriter(
      connection('loremaster_worker_cache', 'worker'),
      { assertOutsideTransaction: () => undefined },
    )
    const producer = createWarmProducer(roleUrl('loremaster_producer'), {
      currentRevision: async () => revisionId,
      onEvent: (code) => events.push(code),
    })
    const worker = createWarmWorker(roleUrl('loremaster_worker'), 1, {
      readIndex: async () => index,
      writeIndex: async (value) => writer.set(value as SuggestionIndex),
      onEvent: (code) => {
        events.push(code)
        if (code === 'warmed') warmed++
      },
    })
    try {
      await worker.start()
      await producer.reconcile()
      expect(events).not.toContain('unavailable')
      await eventually(async () => warmed >= 1)
      expect(JSON.parse(await admin.get(cacheKey))).toEqual(index)
      await eventually(
        async () =>
          (await admin.zscore(
            'loremaster:v1:queue:loremaster-warm-v1:completed',
            warmJobId(revisionId),
          )) !== null,
      )
      await producer.reconcile()
      expect(events).not.toContain('unavailable')
      expect(events.at(-1)).toBe('scheduled')
      await eventually(async () => warmed >= 2)
      const wrong = new Redis(roleUrl('loremaster_producer'))
      try {
        await expect(wrong.get(cacheKey)).rejects.toThrow(/NOPERM/u)
      } finally {
        wrong.disconnect()
      }
    } finally {
      await producer.stop()
      await worker.stop()
    }
  }, 20_000)

  it('fails poison once and bounds transient retries to three attempts', async () => {
    const queueRedis = new Redis(adminUrl)
    const queue = new Queue('loremaster-warm-v1', {
      prefix: 'loremaster:v1:queue',
      connection: queueRedis,
    })
    const events: string[] = []
    const transientId = '44444444-4444-4444-8444-444444444444'
    const worker = createWarmWorker(roleUrl('loremaster_worker'), 1, {
      readIndex: async () => {
        throw new Error('database unavailable')
      },
      writeIndex: async () => undefined,
      onEvent: (code) => events.push(code),
    })
    try {
      await worker.start()
      await queue.add(
        'warm-current-revision-v1',
        { version: 1, revisionId, extra: 'poison' },
        {
          jobId: 'warm-v1-55555555-5555-4555-8555-555555555555',
          attempts: 3,
          stackTraceLimit: 0,
        },
      )
      const poisonId = 'warm-v1-55555555-5555-4555-8555-555555555555'
      await eventually(
        async () =>
          (await queue.getJob(poisonId))
            ?.getState()
            .then((state: string) => state === 'failed') ?? false,
      )
      expect((await queue.getJob(poisonId))?.attemptsMade).toBe(1)
      expect(events.filter((code) => code === 'poison')).toHaveLength(1)
      await queue.add(
        'warm-current-revision-v1',
        { version: 1, revisionId: transientId },
        {
          jobId: warmJobId(transientId),
          attempts: 3,
          backoff: { type: 'exponential', delay: 100 },
          stackTraceLimit: 0,
        },
      )
      await eventually(
        async () =>
          (await queue.getJob(warmJobId(transientId)))
            ?.getState()
            .then((state: string) => state === 'failed') ?? false,
      )
      expect((await queue.getJob(warmJobId(transientId)))?.attemptsMade).toBe(3)
      expect(events.filter((code) => code === 'transient')).toHaveLength(3)
    } finally {
      await worker.stop()
      await queue.close()
      queueRedis.disconnect()
    }
  }, 20_000)

  it('recovers from a producer connection outage and selects the newly current revision', async () => {
    let current = '66666666-6666-4666-8666-666666666666'
    const events: string[] = []
    const producer = createWarmProducer(roleUrl('loremaster_producer'), {
      currentRevision: async () => current,
      onEvent: (code) => events.push(code),
    })
    await admin.call('ACL', 'SETUSER', 'loremaster_producer', 'off')
    try {
      await producer.reconcile()
      expect(events).toContain('unavailable')
      current = '77777777-7777-4777-8777-777777777777'
      await admin.call('ACL', 'SETUSER', 'loremaster_producer', 'on')
      await eventually(async () => events.includes('scheduled'))
      expect(
        await admin.exists(
          `loremaster:v1:queue:loremaster-warm-v1:${warmJobId(current)}`,
        ),
      ).toBe(1)
      expect(
        await admin.exists(
          'loremaster:v1:queue:loremaster-warm-v1:warm-v1-66666666-6666-4666-8666-666666666666',
        ),
      ).toBe(0)
    } finally {
      await admin.call('ACL', 'SETUSER', 'loremaster_producer', 'on')
      await producer.stop()
    }
  }, 20_000)

  it('admits at most fifteen suggestion keys plus its registry', async () => {
    const writer = createSuggestionCacheWriter(
      connection('loremaster_worker_cache', 'worker'),
      { assertOutsideTransaction: () => undefined },
    )
    for (let number = 1; number <= 14; number++) {
      const id = `00000000-0000-4000-8000-${number.toString().padStart(12, '0')}`
      await writer.set({ version: 1, revisionId: id, entities: [] })
    }
    const overflow = '00000000-0000-4000-8000-000000000015'
    await expect(
      writer.set({ version: 1, revisionId: overflow, entities: [] }),
    ).rejects.toMatchObject({ reason: 'capacity' })
    expect(
      await admin.exists(`loremaster:v1:revision:${overflow}:suggestions`),
    ).toBe(0)
  })

  it('denies new limiter identities at the registry bound and recovers after capacity returns', async () => {
    const registry = 'loremaster:v1:limit:capacity:cap'
    const items: (string | number)[] = []
    for (let number = 0; number < 19_998; number++)
      items.push(Date.now() + 60_000, `reserved-${number}`)
    await admin.zadd(registry, ...items)
    const limiter = createRedisSharedLimiter(
      connection('loremaster_api_limiter', 'api-limiter'),
      'cap',
    )
    const digest = digestLimitIdentity(randomBytes(32), 'ip', '203.0.113.9')
    expect(
      await limiter.consume({ counter: 'session', ipDigest: digest }),
    ).toMatchObject({ state: 'denied' })
    await admin.del(registry)
    expect(
      await limiter.consume({ counter: 'session', ipDigest: digest }),
    ).toMatchObject({ state: 'allowed' })
  })

  it('coalesces multi-replica producer ticks and rejects a full outstanding queue', async () => {
    const id = '22222222-2222-4222-8222-222222222222'
    const first = createWarmProducer(roleUrl('loremaster_producer'), {
      currentRevision: async () => id,
    })
    const second = createWarmProducer(roleUrl('loremaster_producer'), {
      currentRevision: async () => id,
    })
    const waitKey = 'loremaster:v1:queue:loremaster-warm-v1:wait'
    const before = await admin.llen(waitKey)
    try {
      await Promise.all([first.reconcile(), second.reconcile()])
      expect(await admin.llen(waitKey)).toBe(before + 1)
    } finally {
      await first.stop()
      await second.stop()
    }
    const events: string[] = []
    const blocked = createWarmProducer(roleUrl('loremaster_producer'), {
      currentRevision: async () => '33333333-3333-4333-8333-333333333333',
      onEvent: (code) => events.push(code),
    })
    try {
      await admin.lpush(
        waitKey,
        ...Array.from({ length: 127 - before }, (_, n) => `fill-${n}`),
      )
      await blocked.reconcile()
      expect(events).toContain('capacity')
      expect(await admin.llen(waitKey)).toBe(128)
    } finally {
      await blocked.stop()
    }
  })
})
