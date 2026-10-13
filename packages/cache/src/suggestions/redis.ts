import { createHash } from 'node:crypto'
import type {
  CacheAdapterPolicy,
  SuggestionCacheReader,
  SuggestionCacheWriter,
  SuggestionIndex,
} from '../suggestions.js'
import {
  parseSuggestionIndex,
  serializeSuggestionIndex,
  suggestionCacheKey,
  SUGGESTION_CACHE_TTL_SECONDS,
} from '../suggestions.js'
import type { BoundedRedisConnection } from '../redis-connection.js'
import { redisFailure, RedisOperationError } from '../redis-connection.js'
import { REDIS_NAMESPACE_BUDGETS } from '../profiles.js'

/** Registry and exact key replacement are one atomic, reviewed worker operation. */
export const CACHE_SET_V1_LUA = `#!lua
local now = redis.call('TIME')
local nowMs = tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', nowMs)
local known = redis.call('ZSCORE', KEYS[2], KEYS[1])
if not known and redis.call('ZCARD', KEYS[2]) >= ${REDIS_NAMESPACE_BUDGETS.cache.maximumKeys - 1} then return 0 end
redis.call('ZADD', KEYS[2], nowMs + ${SUGGESTION_CACHE_TTL_SECONDS * 1000}, KEYS[1])
redis.call('PEXPIRE', KEYS[2], ${SUGGESTION_CACHE_TTL_SECONDS * 1000})
redis.call('SET', KEYS[1], ARGV[1], 'EX', ${SUGGESTION_CACHE_TTL_SECONDS})
return 1
`.trim()
export const CACHE_SET_V1_SHA256 = createHash('sha256')
  .update(CACHE_SET_V1_LUA)
  .digest('hex')
const CACHE_REGISTRY_KEY = 'loremaster:v1:revision:admission'

export function createSuggestionCacheReader(
  connection: BoundedRedisConnection,
  policy: CacheAdapterPolicy,
): SuggestionCacheReader {
  return {
    async get(revisionId, signal) {
      policy.assertOutsideTransaction()
      const key = suggestionCacheKey(revisionId)
      try {
        const raw = await connection.run((redis) => redis.get(key), signal)
        if (raw === null) {
          policy.onEvent?.('miss')
          return undefined
        }
        try {
          const index = parseSuggestionIndex(raw)
          if (index.revisionId !== revisionId)
            throw new Error('revision mismatch')
          return index
        } catch {
          policy.onEvent?.('corrupt')
          return undefined
        }
      } catch (error) {
        policy.onEvent?.(redisFailure(error))
        return undefined
      }
    },
  }
}

export function createSuggestionCacheWriter(
  connection: BoundedRedisConnection,
  policy: CacheAdapterPolicy,
): SuggestionCacheWriter {
  return {
    async set(index: SuggestionIndex, signal?: AbortSignal) {
      policy.assertOutsideTransaction()
      const key = suggestionCacheKey(index.revisionId)
      const value = serializeSuggestionIndex(index)
      try {
        const result = await connection.run(
          (redis) =>
            redis.eval(CACHE_SET_V1_LUA, 2, key, CACHE_REGISTRY_KEY, value),
          signal,
        )
        if (result === 0) throw new RedisOperationError('capacity')
        if (result !== 1) throw new RedisOperationError('unavailable')
      } catch (error) {
        const reason = redisFailure(error)
        policy.onEvent?.(reason)
        throw new RedisOperationError(reason)
      }
    },
  }
}
