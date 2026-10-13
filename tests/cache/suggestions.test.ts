import { describe, expect, it } from 'vitest'
import {
  parseSuggestionIndex,
  serializeSuggestionIndex,
  suggestionCacheKey,
  REDIS_CLIENT_PROFILES,
  type SuggestionIndex,
} from '../../packages/cache/src/index.js'
const revisionId = '12345678-1234-1234-1234-123456789abc'
const index: SuggestionIndex = {
  version: 1,
  revisionId,
  entities: [
    {
      entityId: 'person-one',
      canonicalName: 'Álice %',
      publicRole: 'Detective',
      aliases: ['Al'],
      searchName: 'álice %',
      searchRole: 'detective',
      searchAliases: ['al'],
      sortRank: 0,
    },
  ],
}
describe('strict immutable suggestion contract', () => {
  it('rejects sparse, decorated and accessor arrays without calling supplied methods', () => {
    const decorated = Object.assign([], {
      map: () => [{ answer: 'private answer' }],
    })
    const accessor = Object.defineProperty([index.entities[0]], '0', {
      enumerable: true,
      get() {
        throw new Error('private content')
      },
    })
    const subclass = new (class extends Array {})()
    for (const entities of [Array(1), decorated, accessor, subclass]) {
      expect(() => serializeSuggestionIndex({ ...index, entities })).toThrow(
        'Invalid suggestion index',
      )
    }
    for (const aliases of [Array(1), decorated, accessor, subclass]) {
      expect(() =>
        serializeSuggestionIndex({
          ...index,
          entities: [
            { ...index.entities[0]!, aliases, searchAliases: aliases },
          ],
        }),
      ).toThrow('Invalid suggestion index')
    }
  })
  it('rejects private accessors and symbol fields before serialization', () => {
    const accessor = Object.defineProperty({ ...index }, 'revisionId', {
      enumerable: true,
      get() {
        throw new Error('private content')
      },
    })
    expect(() => serializeSuggestionIndex(accessor)).toThrow(
      'Invalid suggestion index',
    )
    expect(() =>
      serializeSuggestionIndex({ ...index, [Symbol('private')]: 'content' }),
    ).toThrow('Invalid suggestion index')
    expect(() =>
      serializeSuggestionIndex(
        Object.assign(Object.create({ private: 'content' }), index),
      ),
    ).toThrow('Invalid suggestion index')
  })
  it('serializes canonically independent of property insertion order', () => {
    expect(parseSuggestionIndex(serializeSuggestionIndex(index))).toEqual(index)
    expect(
      serializeSuggestionIndex({
        ...index,
        entities: [{ ...index.entities[0]! }],
      }),
    ).toBe(serializeSuggestionIndex(index))
    expect(suggestionCacheKey(revisionId)).toBe(
      `loremaster:v1:revision:${revisionId}:suggestions`,
    )
  })
  it.each([
    null,
    [],
    {},
    { ...index, version: 2 },
    { ...index, answer: 'secret' },
    { ...index, entities: Array(10001).fill(index.entities[0]) },
    { ...index, entities: [{ ...index.entities[0], source: 'secret' }] },
    {
      ...index,
      entities: [{ ...index.entities[0], aliases: Array(33).fill('a') }],
    },
    { ...index, entities: [{ ...index.entities[0], sortRank: -1 }] },
    { ...index, entities: [{ ...index.entities[0], searchAliases: [] }] },
    { ...index, entities: [index.entities[0], index.entities[0]] },
  ])('rejects invalid or private content', (value) =>
    expect(() => parseSuggestionIndex(JSON.stringify(value))).toThrow(),
  )
  it('rejects oversized data, wrong types, and unsafe ids', () => {
    expect(() => parseSuggestionIndex(' '.repeat(524289))).toThrow()
    expect(() => parseSuggestionIndex(undefined)).toThrow()
    expect(() => suggestionCacheKey('../secret')).toThrow()
    expect(() => suggestionCacheKey(revisionId.toUpperCase())).toThrow()
    expect(
      parseSuggestionIndex(JSON.stringify({ ...index, entities: [] })).entities,
    ).toEqual([])
  })
  it('freezes bounded request profiles with no replay or offline queuing', () => {
    for (const role of ['api-cache', 'api-limiter', 'producer'] as const) {
      expect(REDIS_CLIENT_PROFILES[role]).toMatchObject({
        enableOfflineQueue: false,
        autoResendUnfulfilledCommands: false,
        maxRetriesPerRequest: 0,
        lazyConnect: true,
        destroyOnDeadline: true,
      })
      expect(REDIS_CLIENT_PROFILES[role].commandTimeoutMs).toBeLessThanOrEqual(
        1000,
      )
      expect(Object.isFrozen(REDIS_CLIENT_PROFILES[role])).toBe(true)
    }
  })
})
