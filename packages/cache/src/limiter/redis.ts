import { createHmac, createHash } from 'node:crypto'
import { Buffer } from 'node:buffer'
import type {
  SharedLimiter,
  SharedLimitRequest,
  SharedLimitDecision,
} from '../limiter-contract.js'
import { SHARED_LIMIT_POLICY } from '../limiter-contract.js'
import type { BoundedRedisConnection } from '../redis-connection.js'

/** One reviewed operation. TIME, both identity checks, capacity and increments are atomic. */
export const LIMITER_V1_LUA = `
local now = redis.call('TIME')
local second = tonumber(now[1])
local bucket = math.floor(second / 60)
local prefix = 'loremaster:v1:limit:' .. ARGV[1] .. ':' .. bucket .. ':' .. ARGV[2] .. ':'
local ip = prefix .. 'ip:' .. ARGV[3]
local guest = nil
if ARGV[4] ~= '' then guest = prefix .. 'guest:' .. ARGV[4] end
local capacity = 'loremaster:v1:limit:capacity:' .. ARGV[1]
local nowMs = second * 1000 + math.floor(tonumber(now[2]) / 1000)
local reset = 60 - (second % 60)
local currentIp = tonumber(redis.call('GET', ip) or '0')
local currentGuest = guest and tonumber(redis.call('GET', guest) or '0') or 0
if currentIp >= tonumber(ARGV[5]) or (guest and currentGuest >= tonumber(ARGV[6])) then
  return {0, reset}
end
local needed = (currentIp == 0 and 1 or 0) + (guest and currentGuest == 0 and 1 or 0)
redis.call('ZREMRANGEBYSCORE', capacity, '-inf', nowMs)
local allocated = redis.call('ZCARD', capacity)
if allocated + needed > tonumber(ARGV[7]) then return {0, reset} end
redis.call('INCR', ip)
redis.call('PEXPIRE', ip, 61000)
redis.call('ZADD', capacity, nowMs + 61000, ip)
if guest then
  redis.call('INCR', guest)
  redis.call('PEXPIRE', guest, 61000)
  redis.call('ZADD', capacity, nowMs + 61000, guest)
end
redis.call('PEXPIRE', capacity, 61000)
return {1, 0}
`.trim()
export const LIMITER_V1_SHA256 = createHash('sha256')
  .update(LIMITER_V1_LUA)
  .digest('hex')

export function digestLimitIdentity(
  key: Uint8Array,
  scope: 'ip' | 'guest',
  identity: string,
): string {
  if (
    key.byteLength < 32 ||
    key.byteLength > 64 ||
    Buffer.byteLength(identity, 'utf8') >
      SHARED_LIMIT_POLICY.maximumIdentityBytes ||
    identity.length === 0
  )
    throw new Error('Invalid limiter identity')
  return createHmac('sha256', key)
    .update(`${scope}\0${identity}`, 'utf8')
    .digest('hex')
}

export function createRedisSharedLimiter(
  connection: BoundedRedisConnection,
  version: string,
): SharedLimiter {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,15}$/u.test(version))
    throw new Error('Invalid limiter version')
  return {
    async consume(
      request: SharedLimitRequest,
      signal?: AbortSignal,
    ): Promise<SharedLimitDecision> {
      const { counter, ipDigest, guestDigest } = request
      if (
        !['session', 'autocomplete', 'mutation'].includes(counter) ||
        !/^[0-9a-f]{64}$/u.test(ipDigest) ||
        (counter === 'session'
          ? guestDigest !== undefined
          : !guestDigest || !/^[0-9a-f]{64}$/u.test(guestDigest))
      )
        throw new Error('Invalid limiter request')
      const limits = SHARED_LIMIT_POLICY[counter]
      try {
        const result = await connection.run(
          (redis) =>
            redis.eval(
              LIMITER_V1_LUA,
              0,
              version,
              counter,
              ipDigest,
              guestDigest ?? '',
              String(limits.ip),
              String('guest' in limits ? limits.guest : 0),
              String(SHARED_LIMIT_POLICY.maximumKeys - 2),
            ),
          signal,
        )
        if (
          !Array.isArray(result) ||
          result.length !== 2 ||
          (result[0] !== 0 && result[0] !== 1) ||
          !Number.isInteger(result[1])
        )
          return { state: 'degraded', retryAfterSeconds: 0 }
        if (result[0] === 0)
          return {
            state: 'denied',
            retryAfterSeconds: Math.max(1, Math.min(60, result[1] as number)),
          }
        return { state: 'allowed', retryAfterSeconds: 0 }
      } catch {
        return { state: 'degraded', retryAfterSeconds: 0 }
      }
    },
  }
}
