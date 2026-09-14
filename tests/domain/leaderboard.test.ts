import { describe, expect, expectTypeOf, it } from 'vitest'

import {
  compareLeaderboardPaginationOrder,
  compareLeaderboardPerformance,
  rankLeaderboard,
  type LeaderboardCandidate,
} from '../../packages/domain/src/index.js'

const candidate = (
  overrides: Partial<LeaderboardCandidate> = {},
): LeaderboardCandidate => ({
  attemptId: 'attempt-default',
  state: 'SOLVED',
  evidenceLevel: 0,
  totalWrongGuesses: 0,
  elapsedMilliseconds: 1_000,
  ...overrides,
})

describe('leaderboard ordering', () => {
  it('orders by evidence before score or faster later-evidence solves (B03)', () => {
    const entries = [
      {
        ...candidate({
          attemptId: 'attempt-b',
          evidenceLevel: 1,
          totalWrongGuesses: 0,
          elapsedMilliseconds: 1_000,
        }),
        score: 1_150,
      },
      {
        ...candidate({
          attemptId: 'attempt-a',
          evidenceLevel: 0,
          totalWrongGuesses: 2,
          elapsedMilliseconds: 301_000,
        }),
        score: 1_120,
      },
    ]

    expect(rankLeaderboard(entries).map((entry) => entry.attemptId)).toEqual([
      'attempt-a',
      'attempt-b',
    ])
  })

  it('orders equal evidence by fewer wrong guesses, then elapsed milliseconds', () => {
    const entries = [
      candidate({
        attemptId: 'slow',
        evidenceLevel: 2,
        totalWrongGuesses: 1,
        elapsedMilliseconds: 50_000,
      }),
      candidate({
        attemptId: 'more-wrong',
        evidenceLevel: 2,
        totalWrongGuesses: 2,
        elapsedMilliseconds: 1_000,
      }),
      candidate({
        attemptId: 'fast',
        evidenceLevel: 2,
        totalWrongGuesses: 1,
        elapsedMilliseconds: 49_999,
      }),
    ]

    expect(rankLeaderboard(entries).map((entry) => entry.attemptId)).toEqual([
      'fast',
      'slow',
      'more-wrong',
    ])
  })

  it('uses attempt ID only for pagination inside exact ties (B04)', () => {
    const tiedB = candidate({
      attemptId: 'attempt-b',
      evidenceLevel: 1,
      elapsedMilliseconds: 42_000,
    })
    const tiedA = { ...tiedB, attemptId: 'attempt-a' }
    const next = {
      ...tiedB,
      attemptId: 'attempt-c',
      elapsedMilliseconds: 42_001,
    }

    expect(compareLeaderboardPerformance(tiedB, tiedA)).toBe(0)
    expect(compareLeaderboardPaginationOrder(tiedB, tiedA)).toBeGreaterThan(0)
    expect(rankLeaderboard([next, tiedB, tiedA])).toEqual([
      { ...tiedA, rank: 1 },
      { ...tiedB, rank: 1 },
      { ...next, rank: 3 },
    ])
  })

  it('gives every exact tie the same competition rank before skipping positions', () => {
    const entries = ['c', 'a', 'b'].map((attemptId) => candidate({ attemptId }))
    entries.push(candidate({ attemptId: 'd', elapsedMilliseconds: 1_001 }))

    expect(
      rankLeaderboard(entries).map(({ attemptId, rank }) => ({
        attemptId,
        rank,
      })),
    ).toEqual([
      { attemptId: 'a', rank: 1 },
      { attemptId: 'b', rank: 1 },
      { attemptId: 'c', rank: 1 },
      { attemptId: 'd', rank: 4 },
    ])
  })

  it('keeps a zero-score SOLVED attempt eligible (B02)', () => {
    const zeroScoreSolve = {
      ...candidate({
        attemptId: 'zero-score-solve',
        evidenceLevel: 4,
        totalWrongGuesses: 14,
        elapsedMilliseconds: 300_001,
      }),
      score: 0,
    }

    expect(rankLeaderboard([zeroScoreSolve])).toEqual([
      { ...zeroScoreSolve, rank: 1 },
    ])
  })

  it('preserves caller metadata and does not mutate the input', () => {
    const entries = [
      { ...candidate({ attemptId: 'b' }), pseudonym: 'Quiet Heron' },
      { ...candidate({ attemptId: 'a' }), pseudonym: 'Silver Moth' },
    ]
    const original = structuredClone(entries)
    const ranked = rankLeaderboard(entries)

    expect(entries).toEqual(original)
    expect(ranked.map((entry) => entry.pseudonym)).toEqual([
      'Silver Moth',
      'Quiet Heron',
    ])
  })

  it('accepts only the SOLVED state at the type boundary', () => {
    expectTypeOf<LeaderboardCandidate['state']>().toEqualTypeOf<'SOLVED'>()
  })

  it.each(['ACTIVE', 'GIVEN_UP', 'EXHAUSTED', 'EXPIRED'] as const)(
    'rejects runtime %s outcomes that bypass the typed boundary',
    (state) => {
      expect(() =>
        rankLeaderboard([{ ...candidate(), state } as never]),
      ).toThrow('SOLVED attempts only')
    },
  )

  it('rejects duplicate attempt IDs that cannot provide a stable page order', () => {
    expect(() =>
      rankLeaderboard([
        candidate({ attemptId: 'duplicate' }),
        candidate({ attemptId: 'duplicate', elapsedMilliseconds: 2_000 }),
      ]),
    ).toThrow('attempt IDs must be unique')
  })

  it.each([
    candidate({ evidenceLevel: 1, totalWrongGuesses: 6 }),
    candidate({ elapsedMilliseconds: -1 }),
    candidate({ elapsedMilliseconds: Number.NaN }),
    candidate({ attemptId: '' }),
  ])('rejects an invalid persisted candidate %#', (invalidCandidate) => {
    expect(() => rankLeaderboard([invalidCandidate])).toThrow(RangeError)
  })
})
