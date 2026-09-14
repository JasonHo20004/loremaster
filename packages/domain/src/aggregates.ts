import {
  assertValidAttemptSnapshot,
  type EvidenceLevel,
  type TerminalAttempt,
} from './attempt-engine.js'

export interface ProfileStatistics {
  readonly currentStreak: number
  readonly longestStreak: number
  readonly solvedCount: number
  readonly failedCount: number
  readonly accuracyPercentage: number
}

export interface FinalizedCaseOutcome {
  readonly attempt: TerminalAttempt
  readonly regionIds: readonly string[]
}

export interface RegionalKnowledge {
  readonly regionId: string
  readonly alphaHundredths: number
  readonly betaHundredths: number
  readonly sampleCount: number
  readonly displayPercentage: number
}

const MILLISECONDS_PER_DAY = 86_400_000
const INITIAL_ALPHA_HUNDREDTHS = 200
const INITIAL_BETA_HUNDREDTHS = 200
const PERFORMANCE_BASE_HUNDREDTHS: Readonly<Record<EvidenceLevel, number>> = {
  0: 100,
  1: 85,
  2: 65,
  3: 45,
  4: 25,
}

export function calculateProfileStatistics(
  finalizedAttempts: readonly TerminalAttempt[],
  participationUtcDays: readonly string[],
  todayUtcDay: string,
): ProfileStatistics {
  const today = utcDayNumber(todayUtcDay)
  const participationDays = [
    ...new Set(participationUtcDays.map(utcDayNumber)),
  ].sort((left, right) => left - right)

  let solvedCount = 0
  for (const attempt of finalizedAttempts) {
    assertTerminalAttempt(attempt)
    if (attempt.state === 'SOLVED') solvedCount += 1
  }

  const failedCount = finalizedAttempts.length - solvedCount
  return {
    currentStreak: calculateCurrentStreak(participationDays, today),
    longestStreak: calculateLongestStreak(participationDays),
    solvedCount,
    failedCount,
    accuracyPercentage:
      finalizedAttempts.length === 0
        ? 0
        : roundHalfUp(solvedCount * 100, finalizedAttempts.length),
  }
}

export function calculateRegionalKnowledge(
  regionIds: readonly string[],
  finalizedCases: readonly FinalizedCaseOutcome[],
): readonly RegionalKnowledge[] {
  const knowledgeByRegion = new Map<string, MutableRegionalKnowledge>()

  for (const regionId of regionIds) {
    assertRegionId(regionId)
    if (!knowledgeByRegion.has(regionId)) {
      knowledgeByRegion.set(regionId, initialRegionalKnowledge())
    }
  }

  for (const finalizedCase of finalizedCases) {
    assertTerminalAttempt(finalizedCase.attempt)
    const performanceHundredths = regionalPerformanceHundredths(
      finalizedCase.attempt,
    )

    for (const regionId of new Set(finalizedCase.regionIds)) {
      assertRegionId(regionId)
      const knowledge =
        knowledgeByRegion.get(regionId) ?? initialRegionalKnowledge()
      knowledge.alphaHundredths += performanceHundredths
      knowledge.betaHundredths += 100 - performanceHundredths
      knowledge.sampleCount += 1
      knowledgeByRegion.set(regionId, knowledge)
    }
  }

  return [...knowledgeByRegion].map(([regionId, knowledge]) => ({
    regionId,
    ...knowledge,
    displayPercentage: roundHalfUp(
      knowledge.alphaHundredths * 100,
      knowledge.alphaHundredths + knowledge.betaHundredths,
    ),
  }))
}

export function regionalPerformanceHundredths(
  attempt: TerminalAttempt,
): number {
  assertTerminalAttempt(attempt)
  if (attempt.state !== 'SOLVED') return 0

  return Math.max(
    0,
    PERFORMANCE_BASE_HUNDREDTHS[attempt.evidenceLevel] -
      5 * attempt.totalWrongGuesses,
  )
}

interface MutableRegionalKnowledge {
  alphaHundredths: number
  betaHundredths: number
  sampleCount: number
}

function initialRegionalKnowledge(): MutableRegionalKnowledge {
  return {
    alphaHundredths: INITIAL_ALPHA_HUNDREDTHS,
    betaHundredths: INITIAL_BETA_HUNDREDTHS,
    sampleCount: 0,
  }
}

function calculateCurrentStreak(
  sortedParticipationDays: readonly number[],
  today: number,
): number {
  const days = new Set(sortedParticipationDays)
  let cursor = days.has(today) ? today : today - 1
  if (!days.has(cursor)) return 0

  let streak = 0
  while (days.has(cursor)) {
    streak += 1
    cursor -= 1
  }
  return streak
}

function calculateLongestStreak(
  sortedParticipationDays: readonly number[],
): number {
  let longestStreak = 0
  let currentStreak = 0
  let previousDay: number | undefined

  for (const day of sortedParticipationDays) {
    currentStreak =
      previousDay !== undefined && day === previousDay + 1
        ? currentStreak + 1
        : 1
    longestStreak = Math.max(longestStreak, currentStreak)
    previousDay = day
  }

  return longestStreak
}

function utcDayNumber(day: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new RangeError('UTC day must use YYYY-MM-DD')
  }

  const timestamp = Date.parse(`${day}T00:00:00.000Z`)
  if (
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString().slice(0, 10) !== day
  ) {
    throw new RangeError('UTC day must be a valid calendar day')
  }
  return timestamp / MILLISECONDS_PER_DAY
}

function assertTerminalAttempt(
  attempt: unknown,
): asserts attempt is TerminalAttempt {
  assertValidAttemptSnapshot(attempt)
  if (attempt.state === 'ACTIVE') {
    throw new RangeError('aggregate input must contain finalized attempts only')
  }
}

function assertRegionId(regionId: string): void {
  if (regionId.length === 0) throw new RangeError('regionId must not be empty')
}

function roundHalfUp(numerator: number, denominator: number): number {
  if (
    !Number.isSafeInteger(numerator) ||
    numerator < 0 ||
    !Number.isSafeInteger(denominator) ||
    denominator <= 0
  ) {
    throw new RangeError('rounding operands must be safe positive integers')
  }

  const doubledNumerator = BigInt(numerator) * 2n
  const doubledDenominator = BigInt(denominator) * 2n
  return Number((doubledNumerator + BigInt(denominator)) / doubledDenominator)
}
