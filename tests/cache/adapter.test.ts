import { describe, expect, it } from 'vitest'
import {
  createSuggestionCacheReader,
  createSuggestionCacheWriter,
  serializeSuggestionIndex,
  CACHE_SET_V1_LUA,
  type SuggestionIndex,
  type BoundedRedisConnection,
} from '../../packages/cache/src/index.js'

const revisionId = '12345678-1234-1234-1234-123456789abc'
const index: SuggestionIndex = { version: 1, revisionId, entities: [] }

function connection(redis: object): BoundedRedisConnection {
  return {
    run: (work: (client: object) => Promise<unknown>) => work(redis),
  } as unknown as BoundedRedisConnection
}

describe('role-specific suggestion adapters', () => {
  it('validates a hit, rejects a mismatched revision, and reports only reason codes', async () => {
    const events: string[] = []
    const reader = createSuggestionCacheReader(
      connection({ get: async () => serializeSuggestionIndex(index) }),
      {
        assertOutsideTransaction: () => undefined,
        onEvent: (code) => events.push(code),
      },
    )
    expect(await reader.get(revisionId)).toEqual(index)
    expect(
      await reader.get('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
    ).toBeUndefined()
    expect(events).toEqual(['corrupt'])
  })

  it('falls back on miss and Redis failure without exposing key or value text', async () => {
    const events: string[] = []
    const policy = {
      assertOutsideTransaction: () => undefined,
      onEvent: (code: string) => events.push(code),
    }
    expect(
      await createSuggestionCacheReader(
        connection({ get: async () => null }),
        policy,
      ).get(revisionId),
    ).toBeUndefined()
    expect(
      await createSuggestionCacheReader(
        connection({
          get: async () => {
            throw new Error('NOPERM secret-value')
          },
        }),
        policy,
      ).get(revisionId),
    ).toBeUndefined()
    expect(events).toEqual(['miss', 'acl_denied'])
  })

  it('allows only a validated exact index through the atomic fixed-TTL writer', async () => {
    const calls: unknown[][] = []
    const writer = createSuggestionCacheWriter(
      connection({
        eval: async (...args: unknown[]) => {
          calls.push(args)
          return 1
        },
      }),
      {
        assertOutsideTransaction: () => undefined,
      },
    )
    await writer.set(index)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.[0]).toBe(CACHE_SET_V1_LUA)
    expect(calls[0]?.[2]).toBe(
      `loremaster:v1:revision:${revisionId}:suggestions`,
    )
    await expect(
      writer.set({
        ...index,
        entities: [{ answer: 'private' }],
      } as unknown as SuggestionIndex),
    ).rejects.toThrow('Invalid suggestion index')
    expect(calls).toHaveLength(1)
  })

  it('rejects Redis access while the transaction assertion is active', async () => {
    const reader = createSuggestionCacheReader(
      connection({ get: async () => null }),
      {
        assertOutsideTransaction: () => {
          throw new Error('inside transaction')
        },
      },
    )
    await expect(reader.get(revisionId)).rejects.toThrow('inside transaction')
  })
})
