import { describe, expect, it } from 'vitest'

import {
  applyGuess,
  expire,
  giveUp,
  revealEvidence,
  scoreSolvedAttempt,
  timeBonusFor,
  type ActiveAttempt,
  type SolvedAttempt,
  type TerminalAttempt,
} from '../../packages/domain/src/index.js'

const active = (overrides: Partial<ActiveAttempt> = {}): ActiveAttempt => ({
  state: 'ACTIVE',
  evidenceLevel: 0,
  wrongGuessesAtLevel: 0,
  totalWrongGuesses: 0,
  ...overrides,
})

const solved = (overrides: Partial<SolvedAttempt> = {}): SolvedAttempt => ({
  ...active(),
  state: 'SOLVED',
  ...overrides,
})

describe('score rules', () => {
  it.each([
    [0, 'Cold Case Solve', 1200],
    [1, 'Loremaster', 1000],
    [2, 'Investigator', 750],
    [3, 'Detective', 500],
    [4, 'Case Closed', 250],
  ] as const)(
    'maps evidence level %i to %s and %i tier points',
    (evidenceLevel, rank, tierScore) => {
      expect(
        scoreSolvedAttempt(solved({ evidenceLevel }), 300_001),
      ).toMatchObject({ rank, tierScore, score: tierScore })
    },
  )

  it.each([
    [30_000, 150],
    [30_001, 100],
    [60_000, 100],
    [60_001, 60],
    [120_000, 60],
    [120_001, 25],
    [300_000, 25],
    [300_001, 0],
  ])('gives %i ms the boundary bonus %i', (elapsed, expected) => {
    expect(timeBonusFor(elapsed)).toBe(expected)
  })

  it('scores a briefing solve at the 30 second boundary', () => {
    expect(scoreSolvedAttempt(solved(), 30_000)).toEqual({
      rank: 'Cold Case Solve',
      tierScore: 1200,
      wrongGuessPenalty: 0,
      timeBonus: 150,
      score: 1350,
    })
  })

  it('uses the accepted first-clue example after 60 seconds', () => {
    expect(
      scoreSolvedAttempt(
        solved({
          evidenceLevel: 1,
          wrongGuessesAtLevel: 0,
          totalWrongGuesses: 3,
        }),
        60_001,
      ).score,
    ).toBe(940)
  })

  it('clamps a solved score to zero without changing the solve outcome', () => {
    expect(
      scoreSolvedAttempt(
        solved({
          evidenceLevel: 4,
          wrongGuessesAtLevel: 2,
          totalWrongGuesses: 14,
        }),
        300_001,
      ).score,
    ).toBe(0)
  })

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid elapsed milliseconds: %s',
    (elapsed) => {
      expect(() => timeBonusFor(elapsed)).toThrow(RangeError)
    },
  )

  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid total wrong guesses: %s',
    (totalWrongGuesses) => {
      expect(() =>
        scoreSolvedAttempt(solved({ totalWrongGuesses }), 1),
      ).toThrow(RangeError)
    },
  )
})

describe('attempt transitions', () => {
  it('records correct and wrong guesses as participation', () => {
    const solved = applyGuess(active(), true)
    const wrong = applyGuess(active(), false)

    expect(solved).toMatchObject({
      accepted: true,
      recordsParticipation: true,
      attempt: { state: 'SOLVED', totalWrongGuesses: 0 },
    })
    expect(wrong).toMatchObject({
      accepted: true,
      recordsParticipation: true,
      attempt: {
        state: 'ACTIVE',
        wrongGuessesAtLevel: 1,
        totalWrongGuesses: 1,
      },
    })
  })

  it('applies two sequential wrong guesses at the same level (T05)', () => {
    const first = applyGuess(
      active({ evidenceLevel: 2, totalWrongGuesses: 3 }),
      false,
    )
    expect(first.accepted).toBe(true)
    if (!first.accepted || first.attempt.state !== 'ACTIVE') return

    const second = applyGuess(first.attempt, false)
    expect(second).toMatchObject({
      accepted: true,
      attempt: {
        state: 'ACTIVE',
        evidenceLevel: 2,
        wrongGuessesAtLevel: 2,
        totalWrongGuesses: 5,
      },
    })
  })

  it.each([0, 1, 2, 3] as const)(
    'unlocks level %i + 1 on the third wrong guess',
    (evidenceLevel) => {
      const result = applyGuess(
        active({ evidenceLevel, wrongGuessesAtLevel: 2, totalWrongGuesses: 2 }),
        false,
      )

      expect(result).toMatchObject({
        accepted: true,
        attempt: {
          state: 'ACTIVE',
          evidenceLevel: evidenceLevel + 1,
          wrongGuessesAtLevel: 0,
          totalWrongGuesses: 3,
        },
      })
    },
  )

  it('exhausts instead of creating evidence level five', () => {
    const result = applyGuess(
      active({
        evidenceLevel: 4,
        wrongGuessesAtLevel: 2,
        totalWrongGuesses: 14,
      }),
      false,
    )

    expect(result).toMatchObject({
      accepted: true,
      recordsParticipation: true,
      attempt: { state: 'EXHAUSTED', evidenceLevel: 4, totalWrongGuesses: 15 },
    })
  })

  it.each([0, 1, 2, 3] as const)(
    'reveals level %i + 1, resets misses, and does not participate (T07)',
    (evidenceLevel) => {
      const result = revealEvidence(
        active({
          evidenceLevel,
          wrongGuessesAtLevel: 2,
          totalWrongGuesses: evidenceLevel * 3 + 2,
        }),
      )

      expect(result).toEqual({
        accepted: true,
        recordsParticipation: false,
        attempt: {
          state: 'ACTIVE',
          evidenceLevel: evidenceLevel + 1,
          wrongGuessesAtLevel: 0,
          totalWrongGuesses: evidenceLevel * 3 + 2,
        },
      })
    },
  )

  it('keeps level four active after its second wrong guess (T08)', () => {
    expect(
      applyGuess(
        active({
          evidenceLevel: 4,
          wrongGuessesAtLevel: 1,
          totalWrongGuesses: 13,
        }),
        false,
      ),
    ).toMatchObject({
      accepted: true,
      attempt: {
        state: 'ACTIVE',
        evidenceLevel: 4,
        wrongGuessesAtLevel: 2,
        totalWrongGuesses: 14,
      },
    })
  })

  it('rejects revealing beyond level four without mutation', () => {
    const attempt = active({
      evidenceLevel: 4,
      wrongGuessesAtLevel: 1,
      totalWrongGuesses: 1,
    })
    expect(revealEvidence(attempt)).toEqual({
      accepted: false,
      reason: 'EVIDENCE_LIMIT',
      attempt,
    })
  })

  it('gives up and expires without recording participation', () => {
    expect(giveUp(active())).toMatchObject({
      accepted: true,
      recordsParticipation: false,
      attempt: { state: 'GIVEN_UP' },
    })
    expect(expire(active())).toMatchObject({
      accepted: true,
      recordsParticipation: false,
      attempt: { state: 'EXPIRED' },
    })
  })

  it('preserves an earlier participation event when giving up (T12)', () => {
    const guess = applyGuess(active(), false)
    expect(guess).toMatchObject({ accepted: true, recordsParticipation: true })
    if (!guess.accepted) return

    expect(giveUp(guess.attempt)).toMatchObject({
      accepted: true,
      recordsParticipation: false,
      attempt: { state: 'GIVEN_UP', totalWrongGuesses: 1 },
    })
  })

  it('auto-unlocks level one then solves with the accepted score (T21)', () => {
    const unlock = applyGuess(
      active({ wrongGuessesAtLevel: 2, totalWrongGuesses: 2 }),
      false,
    )
    expect(unlock.accepted).toBe(true)
    if (!unlock.accepted) return

    const solve = applyGuess(unlock.attempt, true)
    expect(solve).toMatchObject({
      accepted: true,
      attempt: { state: 'SOLVED', evidenceLevel: 1, totalWrongGuesses: 3 },
    })
    if (!solve.accepted || solve.attempt.state !== 'SOLVED') return
    expect(scoreSolvedAttempt(solve.attempt, 60_001).score).toBe(940)
  })

  const terminalAttempts: readonly TerminalAttempt[] = [
    solved(),
    { ...active(), state: 'GIVEN_UP' },
    {
      state: 'EXHAUSTED',
      evidenceLevel: 4,
      wrongGuessesAtLevel: 2,
      totalWrongGuesses: 15,
    },
    { ...active(), state: 'EXPIRED' },
  ]

  it.each(terminalAttempts)(
    'rejects new commands for terminal state $state',
    (terminal) => {
      const rejection = {
        accepted: false,
        reason: 'TERMINAL_ATTEMPT',
        attempt: terminal,
      } as const
      expect(applyGuess(terminal, false)).toEqual(rejection)
      expect(revealEvidence(terminal)).toEqual(rejection)
      expect(giveUp(terminal)).toEqual(rejection)
      expect(expire(terminal)).toEqual(rejection)
    },
  )

  it('does not mutate the supplied snapshot', () => {
    const attempt = active({ wrongGuessesAtLevel: 2, totalWrongGuesses: 2 })
    applyGuess(attempt, false)
    expect(attempt).toEqual(
      active({ wrongGuessesAtLevel: 2, totalWrongGuesses: 2 }),
    )
  })

  it.each([
    active({ evidenceLevel: 4, wrongGuessesAtLevel: 2, totalWrongGuesses: 15 }),
    active({ totalWrongGuesses: -1 }),
    active({ totalWrongGuesses: Number.NaN }),
    active({ evidenceLevel: 1, wrongGuessesAtLevel: 0, totalWrongGuesses: 4 }),
  ])(
    'rejects an impossible snapshot without applying a transition',
    (attempt) => {
      expect(() => applyGuess(attempt, false)).toThrow(RangeError)
    },
  )

  it('rejects an unknown runtime state at the hydration boundary', () => {
    expect(() =>
      applyGuess({ ...active(), state: 'CORRUPT' } as never, false),
    ).toThrow('attempt state is invalid')
  })
})
