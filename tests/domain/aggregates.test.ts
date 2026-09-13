import { describe, expect, it } from 'vitest'

import {
  calculateProfileStatistics,
  calculateRegionalKnowledge,
  regionalPerformanceHundredths,
  type ActiveAttempt,
  type SolvedAttempt,
  type TerminalAttempt,
} from '../../packages/domain/src/index.js'

const solved = (overrides: Partial<SolvedAttempt> = {}): SolvedAttempt => ({
  state: 'SOLVED',
  evidenceLevel: 0,
  wrongGuessesAtLevel: 0,
  totalWrongGuesses: 0,
  ...overrides,
})

const failed = (
  state: 'GIVEN_UP' | 'EXHAUSTED' | 'EXPIRED' = 'GIVEN_UP',
): TerminalAttempt =>
  state === 'EXHAUSTED'
    ? {
        state,
        evidenceLevel: 4,
        wrongGuessesAtLevel: 2,
        totalWrongGuesses: 15,
      }
    : {
        state,
        evidenceLevel: 0,
        wrongGuessesAtLevel: 0,
        totalWrongGuesses: 0,
      }

describe('profile statistics', () => {
  it('counts finalized outcomes, omits ACTIVE by type, and rounds accuracy half up (B10)', () => {
    const statistics = calculateProfileStatistics(
      [solved(), failed(), solved()],
      [],
      '2026-09-13',
    )

    expect(statistics).toMatchObject({
      solvedCount: 2,
      failedCount: 1,
      accuracyPercentage: 67,
    })
  })

  it('counts every failed terminal outcome and returns zero accuracy without solves (B09)', () => {
    expect(
      calculateProfileStatistics(
        [failed('GIVEN_UP'), failed('EXHAUSTED'), failed('EXPIRED')],
        ['2026-09-10', '2026-09-11'],
        '2026-09-11',
      ),
    ).toEqual({
      currentStreak: 2,
      longestStreak: 2,
      solvedCount: 0,
      failedCount: 3,
      accuracyPercentage: 0,
    })
  })

  it('returns zero accuracy with no completed cases', () => {
    expect(calculateProfileStatistics([], [], '2026-09-13')).toMatchObject({
      solvedCount: 0,
      failedCount: 0,
      accuracyPercentage: 0,
    })
  })

  it('rounds an exact half accuracy percentage upward', () => {
    expect(
      calculateProfileStatistics(
        [solved(), ...Array.from({ length: 7 }, () => failed())],
        [],
        '2026-09-13',
      ).accuracyPercentage,
    ).toBe(13)
  })

  it('ends the current streak yesterday when today has not participated (B08)', () => {
    expect(
      calculateProfileStatistics([], ['2026-09-10'], '2026-09-11'),
    ).toMatchObject({ currentStreak: 1, longestStreak: 1 })
    expect(
      calculateProfileStatistics([], ['2026-09-10'], '2026-09-12'),
    ).toMatchObject({ currentStreak: 0, longestStreak: 1 })
  })

  it('deduplicates and sorts participation days before finding streaks', () => {
    expect(
      calculateProfileStatistics(
        [],
        [
          '2026-09-05',
          '2026-09-03',
          '2026-09-04',
          '2026-09-04',
          '2026-09-10',
          '2026-09-11',
        ],
        '2026-09-12',
      ),
    ).toMatchObject({ currentStreak: 2, longestStreak: 3 })
  })

  it('uses UTC calendar arithmetic across month and leap-day boundaries', () => {
    expect(
      calculateProfileStatistics(
        [],
        ['2024-02-28', '2024-02-29', '2024-03-01'],
        '2024-03-01',
      ),
    ).toMatchObject({ currentStreak: 3, longestStreak: 3 })
  })

  it.each(['2026-9-01', '2026-02-29', 'not-a-day'])(
    'rejects an invalid UTC participation day: %s',
    (day) => {
      expect(() => calculateProfileStatistics([], [day], '2026-09-13')).toThrow(
        RangeError,
      )
    },
  )

  it('rejects ACTIVE attempts supplied through an untyped hydration boundary', () => {
    const active: ActiveAttempt = {
      state: 'ACTIVE',
      evidenceLevel: 0,
      wrongGuessesAtLevel: 0,
      totalWrongGuesses: 0,
    }
    expect(() =>
      calculateProfileStatistics([active as never], [], '2026-09-13'),
    ).toThrow('finalized attempts only')
  })
})

describe('regional knowledge', () => {
  it('applies the exact B05 solve delta without per-update rounding', () => {
    const result = calculateRegionalKnowledge(
      ['region-a'],
      [
        {
          attempt: solved({
            evidenceLevel: 1,
            totalWrongGuesses: 3,
          }),
          regionIds: ['region-a'],
        },
      ],
    )

    expect(result).toEqual([
      {
        regionId: 'region-a',
        alphaHundredths: 270,
        betaHundredths: 230,
        sampleCount: 1,
        displayPercentage: 54,
      },
    ])
  })

  it('then applies one failure exactly and displays 45% (B06)', () => {
    const result = calculateRegionalKnowledge(
      ['region-a'],
      [
        {
          attempt: solved({ evidenceLevel: 1, totalWrongGuesses: 3 }),
          regionIds: ['region-a'],
        },
        { attempt: failed(), regionIds: ['region-a'] },
      ],
    )

    expect(result[0]).toEqual({
      regionId: 'region-a',
      alphaHundredths: 270,
      betaHundredths: 330,
      sampleCount: 2,
      displayPercentage: 45,
    })
  })

  it('contributes once to each distinct region in a multi-region case', () => {
    const result = calculateRegionalKnowledge(
      ['north', 'south'],
      [
        {
          attempt: solved(),
          regionIds: ['north', 'south', 'north', 'south'],
        },
      ],
    )

    expect(result).toEqual([
      {
        regionId: 'north',
        alphaHundredths: 300,
        betaHundredths: 200,
        sampleCount: 1,
        displayPercentage: 60,
      },
      {
        regionId: 'south',
        alphaHundredths: 300,
        betaHundredths: 200,
        sampleCount: 1,
        displayPercentage: 60,
      },
    ])
  })

  it('shows the prior-only 50% and zero samples for regions without outcomes', () => {
    expect(calculateRegionalKnowledge(['unplayed'], [])).toEqual([
      {
        regionId: 'unplayed',
        alphaHundredths: 200,
        betaHundredths: 200,
        sampleCount: 0,
        displayPercentage: 50,
      },
    ])
  })

  it('retains exact hundredths over repeated updates and rounds display half up', () => {
    const cases = Array.from({ length: 4 }, () => ({
      attempt: solved({ evidenceLevel: 2, totalWrongGuesses: 2 }),
      regionIds: ['region-a'],
    }))

    expect(calculateRegionalKnowledge(['region-a'], cases)[0]).toEqual({
      regionId: 'region-a',
      alphaHundredths: 420,
      betaHundredths: 380,
      sampleCount: 4,
      displayPercentage: 53,
    })
  })

  it.each([
    [solved({ evidenceLevel: 0, totalWrongGuesses: 0 }), 100],
    [solved({ evidenceLevel: 1, totalWrongGuesses: 3 }), 70],
    [solved({ evidenceLevel: 2, totalWrongGuesses: 6 }), 35],
    [solved({ evidenceLevel: 3, totalWrongGuesses: 9 }), 0],
    [
      solved({
        evidenceLevel: 4,
        wrongGuessesAtLevel: 2,
        totalWrongGuesses: 14,
      }),
      0,
    ],
    [failed('EXPIRED'), 0],
  ] as const)('calculates exact performance %#', (attempt, expected) => {
    expect(regionalPerformanceHundredths(attempt)).toBe(expected)
  })

  it('does not mutate input arrays or outcomes', () => {
    const regionIds = ['region-b', 'region-a']
    const regionIdsOnCase = ['region-a', 'region-a']
    const cases = [{ attempt: solved(), regionIds: regionIdsOnCase }]

    calculateRegionalKnowledge(regionIds, cases)

    expect(regionIds).toEqual(['region-b', 'region-a'])
    expect(regionIdsOnCase).toEqual(['region-a', 'region-a'])
    expect(cases).toEqual([{ attempt: solved(), regionIds: regionIdsOnCase }])
  })
})
