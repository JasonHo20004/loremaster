import { expect, it } from 'vitest'
import {
  filterSuggestionIndex,
  type PublishedSuggestionIndex,
} from '../../packages/database/src/gameplay/suggestions.js'

const index: PublishedSuggestionIndex = {
  version: 1,
  revisionId: '12345678-1234-1234-1234-123456789abc',
  entities: [
    {
      entityId: 'role',
      canonicalName: 'B',
      publicRole: 'Mira',
      aliases: ['B'],
      searchName: 'b',
      searchRole: 'mira',
      searchAliases: ['b'],
      sortRank: 0,
    },
    {
      entityId: 'prefix',
      canonicalName: 'Mira B',
      publicRole: 'Archivist',
      aliases: ['MB'],
      searchName: 'mira b',
      searchRole: 'archivist',
      searchAliases: ['mb'],
      sortRank: 1,
    },
    {
      entityId: 'exact',
      canonicalName: 'Mira',
      publicRole: 'Archivist',
      aliases: ['M'],
      searchName: 'mira',
      searchRole: 'archivist',
      searchAliases: ['m'],
      sortRank: 2,
    },
    {
      entityId: 'alias',
      canonicalName: 'Z',
      publicRole: 'Archivist',
      aliases: ['Mira'],
      searchName: 'z',
      searchRole: 'archivist',
      searchAliases: ['mira'],
      sortRank: 3,
    },
  ],
}

it('preserves exact, alias, prefix, role ordering and literal wildcard matching', () => {
  expect(
    filterSuggestionIndex(index, 'mira').map((item) => item.entityId),
  ).toEqual(['exact', 'alias', 'prefix', 'role'])
  expect(filterSuggestionIndex(index, '%')).toEqual([])
  expect(filterSuggestionIndex(index, '_')).toEqual([])
})
