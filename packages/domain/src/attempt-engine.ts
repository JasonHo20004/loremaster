export const EVIDENCE_LEVELS = [0, 1, 2, 3, 4] as const
export const ATTEMPT_STATES = [
  'ACTIVE',
  'SOLVED',
  'GIVEN_UP',
  'EXHAUSTED',
  'EXPIRED',
] as const

export type EvidenceLevel = (typeof EVIDENCE_LEVELS)[number]

export type AttemptState = (typeof ATTEMPT_STATES)[number]

export type SolveRank =
  | 'Cold Case Solve'
  | 'Loremaster'
  | 'Investigator'
  | 'Detective'
  | 'Case Closed'

interface AttemptCounters {
  readonly evidenceLevel: EvidenceLevel
  readonly wrongGuessesAtLevel: 0 | 1 | 2
  readonly totalWrongGuesses: number
}

export interface ActiveAttempt extends AttemptCounters {
  readonly state: 'ACTIVE'
}

export interface SolvedAttempt extends AttemptCounters {
  readonly state: 'SOLVED'
}

export interface GivenUpAttempt extends AttemptCounters {
  readonly state: 'GIVEN_UP'
}

export interface ExpiredAttempt extends AttemptCounters {
  readonly state: 'EXPIRED'
}

export interface ExhaustedAttempt {
  readonly state: 'EXHAUSTED'
  readonly evidenceLevel: 4
  readonly wrongGuessesAtLevel: 2
  readonly totalWrongGuesses: 15
}

export type TerminalAttempt =
  SolvedAttempt | GivenUpAttempt | ExhaustedAttempt | ExpiredAttempt

export type AttemptSnapshot = ActiveAttempt | TerminalAttempt

export interface ScoreBreakdown {
  readonly rank: SolveRank
  readonly tierScore: number
  readonly wrongGuessPenalty: number
  readonly timeBonus: number
  readonly score: number
}

export type TransitionRejection = 'EVIDENCE_LIMIT' | 'TERMINAL_ATTEMPT'

export type TransitionResult =
  | {
      readonly accepted: true
      readonly attempt: AttemptSnapshot
      readonly recordsParticipation: boolean
    }
  | {
      readonly accepted: false
      readonly reason: TransitionRejection
      readonly attempt: AttemptSnapshot
    }

const LEVEL_RULES: Readonly<
  Record<
    EvidenceLevel,
    { readonly rank: SolveRank; readonly tierScore: number }
  >
> = {
  0: { rank: 'Cold Case Solve', tierScore: 1200 },
  1: { rank: 'Loremaster', tierScore: 1000 },
  2: { rank: 'Investigator', tierScore: 750 },
  3: { rank: 'Detective', tierScore: 500 },
  4: { rank: 'Case Closed', tierScore: 250 },
}

export function timeBonusFor(elapsedMilliseconds: number): number {
  assertNonNegativeFinite(elapsedMilliseconds, 'elapsedMilliseconds')

  if (elapsedMilliseconds <= 30_000) return 150
  if (elapsedMilliseconds <= 60_000) return 100
  if (elapsedMilliseconds <= 120_000) return 60
  if (elapsedMilliseconds <= 300_000) return 25
  return 0
}

export function scoreSolvedAttempt(
  attempt: SolvedAttempt,
  elapsedMilliseconds: number,
): ScoreBreakdown {
  assertValidAttemptSnapshot(attempt)
  const levelRule = LEVEL_RULES[attempt.evidenceLevel]
  const wrongGuessPenalty = 40 * attempt.totalWrongGuesses
  const timeBonus = timeBonusFor(elapsedMilliseconds)

  return {
    ...levelRule,
    wrongGuessPenalty,
    timeBonus,
    score: Math.max(0, levelRule.tierScore - wrongGuessPenalty + timeBonus),
  }
}

export function applyGuess(
  attempt: AttemptSnapshot,
  correct: boolean,
): TransitionResult {
  assertValidAttemptSnapshot(attempt)
  if (attempt.state !== 'ACTIVE') return terminalRejection(attempt)

  if (correct) {
    return accepted({ ...attempt, state: 'SOLVED' }, true)
  }

  const totalWrongGuesses = attempt.totalWrongGuesses + 1
  if (attempt.wrongGuessesAtLevel < 2) {
    return accepted(
      {
        ...attempt,
        wrongGuessesAtLevel: (attempt.wrongGuessesAtLevel + 1) as 1 | 2,
        totalWrongGuesses,
      },
      true,
    )
  }

  if (attempt.evidenceLevel === 4) {
    return accepted(
      {
        state: 'EXHAUSTED',
        evidenceLevel: 4,
        wrongGuessesAtLevel: 2,
        totalWrongGuesses: 15,
      },
      true,
    )
  }

  return accepted(
    {
      ...attempt,
      evidenceLevel: nextEvidenceLevel(attempt.evidenceLevel),
      wrongGuessesAtLevel: 0,
      totalWrongGuesses,
    },
    true,
  )
}

export function revealEvidence(attempt: AttemptSnapshot): TransitionResult {
  assertValidAttemptSnapshot(attempt)
  if (attempt.state !== 'ACTIVE') return terminalRejection(attempt)
  if (attempt.evidenceLevel === 4) {
    return { accepted: false, reason: 'EVIDENCE_LIMIT', attempt }
  }

  return accepted(
    {
      ...attempt,
      evidenceLevel: nextEvidenceLevel(attempt.evidenceLevel),
      wrongGuessesAtLevel: 0,
    },
    false,
  )
}

export function giveUp(attempt: AttemptSnapshot): TransitionResult {
  assertValidAttemptSnapshot(attempt)
  if (attempt.state !== 'ACTIVE') return terminalRejection(attempt)
  return accepted({ ...attempt, state: 'GIVEN_UP' }, false)
}

export function expire(attempt: AttemptSnapshot): TransitionResult {
  assertValidAttemptSnapshot(attempt)
  if (attempt.state !== 'ACTIVE') return terminalRejection(attempt)
  return accepted({ ...attempt, state: 'EXPIRED' }, false)
}

function nextEvidenceLevel(level: Exclude<EvidenceLevel, 4>): EvidenceLevel {
  return (level + 1) as EvidenceLevel
}

function accepted(
  attempt: AttemptSnapshot,
  recordsParticipation: boolean,
): TransitionResult {
  return { accepted: true, attempt, recordsParticipation }
}

function terminalRejection(attempt: TerminalAttempt): TransitionResult {
  return { accepted: false, reason: 'TERMINAL_ATTEMPT', attempt }
}

export function assertValidAttemptSnapshot(
  attempt: unknown,
): asserts attempt is AttemptSnapshot {
  if (typeof attempt !== 'object' || attempt === null) {
    throw new TypeError('attempt must be an object')
  }

  const candidate: Record<string, unknown> = { ...attempt }
  const { state, evidenceLevel, wrongGuessesAtLevel, totalWrongGuesses } =
    candidate
  if (!isAttemptState(state)) {
    throw new RangeError('attempt state is invalid')
  }
  if (!isEvidenceLevel(evidenceLevel)) {
    throw new RangeError('evidenceLevel must be between zero and four')
  }
  if (!isWrongGuessesAtLevel(wrongGuessesAtLevel)) {
    throw new RangeError('wrongGuessesAtLevel must be between zero and two')
  }
  if (
    typeof totalWrongGuesses !== 'number' ||
    !Number.isInteger(totalWrongGuesses) ||
    totalWrongGuesses < 0
  ) {
    throw new RangeError('totalWrongGuesses must be a non-negative integer')
  }

  if (state === 'EXHAUSTED') {
    if (
      evidenceLevel !== 4 ||
      wrongGuessesAtLevel !== 2 ||
      totalWrongGuesses !== 15
    ) {
      throw new RangeError('EXHAUSTED requires e=4, w=2, and W=15')
    }
    return
  }

  const maximumReachableWrongGuesses = evidenceLevel * 3 + wrongGuessesAtLevel
  if (
    totalWrongGuesses < wrongGuessesAtLevel ||
    totalWrongGuesses > maximumReachableWrongGuesses
  ) {
    throw new RangeError('attempt counters describe an unreachable state')
  }
}

function isAttemptState(value: unknown): value is AttemptState {
  return ATTEMPT_STATES.some((state) => state === value)
}

function isEvidenceLevel(value: unknown): value is EvidenceLevel {
  return EVIDENCE_LEVELS.some((level) => level === value)
}

function isWrongGuessesAtLevel(value: unknown): value is 0 | 1 | 2 {
  return value === 0 || value === 1 || value === 2
}

function assertNonNegativeFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative finite number`)
  }
}
