import { expect, it } from 'vitest'
import {
  createRedisSharedLimiter,
  digestLimitIdentity,
  LIMITER_V1_LUA,
} from '../../packages/cache/src/index.js'
import type { BoundedRedisConnection } from '../../packages/cache/src/index.js'

const key = new Uint8Array(32).fill(7)
it('separates IP and guest digests and does not embed raw identities in the Redis operation', async () => {
  const ip = digestLimitIdentity(key, 'ip', '198.51.100.7')
  const guest = digestLimitIdentity(key, 'guest', '198.51.100.7')
  expect(ip).not.toBe(guest)
  expect(ip).toMatch(/^[0-9a-f]{64}$/u)
  expect(() => digestLimitIdentity(key, 'ip', 'x'.repeat(129))).toThrow()
  const calls: unknown[][] = []
  const connection = {
    run: (work: (redis: object) => Promise<unknown>) =>
      work({
        eval: async (...args: unknown[]) => {
          calls.push(args)
          return [1, 0]
        },
      }),
  } as unknown as BoundedRedisConnection
  const limiter = createRedisSharedLimiter(connection, 'v1')
  expect(
    await limiter.consume({
      counter: 'autocomplete',
      ipDigest: ip,
      guestDigest: guest,
    }),
  ).toEqual({ state: 'allowed', retryAfterSeconds: 0 })
  expect(calls[0]?.[0]).toBe(LIMITER_V1_LUA)
  expect(JSON.stringify(calls)).not.toContain('198.51.100.7')
})

it('uses healthy denial and degrades on Redis failure', async () => {
  const digest = digestLimitIdentity(key, 'ip', '127.0.0.1')
  const denied = {
    run: async () => [0, 42],
  } as unknown as BoundedRedisConnection
  const failed = {
    run: async () => {
      throw new Error('redis unavailable')
    },
  } as unknown as BoundedRedisConnection
  expect(
    await createRedisSharedLimiter(denied, 'v1').consume({
      counter: 'session',
      ipDigest: digest,
    }),
  ).toEqual({ state: 'denied', retryAfterSeconds: 42 })
  expect(
    await createRedisSharedLimiter(failed, 'v1').consume({
      counter: 'session',
      ipDigest: digest,
    }),
  ).toEqual({ state: 'degraded', retryAfterSeconds: 0 })
})
