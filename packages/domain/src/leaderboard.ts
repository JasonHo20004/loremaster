import { EVIDENCE_LEVELS, type EvidenceLevel } from './attempt-engine.js'

export interface LeaderboardCandidate {
  readonly attemptId: string
  readonly state: 'SOLVED'
  readonly evidenceLevel: EvidenceLevel
  readonly totalWrongGuesses: number
  readonly elapsedMilliseconds: number
}

export type RankedLeaderboardEntry<
  Candidate extends LeaderboardCandidate = LeaderboardCandidate,
> = Candidate & { readonly rank: number }

export function compareLeaderboardPerformance(
  left: LeaderboardCandidate,
  right: LeaderboardCandidate,
): number {
  assertLeaderboardCandidate(left)
  assertLeaderboardCandidate(right)
  return comparePerformance(left, right)
}

export function compareLeaderboardPaginationOrder(
  left: LeaderboardCandidate,
  right: LeaderboardCandidate,
): number {
  assertLeaderboardCandidate(left)
  assertLeaderboardCandidate(right)
  return comparePaginationOrder(left, right)
}

export function rankLeaderboard<Candidate extends LeaderboardCandidate>(
  candidates: readonly Candidate[],
): readonly RankedLeaderboardEntry<Candidate>[] {
  assertUniqueCandidates(candidates)
  const orderedCandidates = [...candidates].sort(comparePaginationOrder)

  let previousCandidate: Candidate | undefined
  let previousRank = 0
  return orderedCandidates.map((candidate, index) => {
    const rank =
      previousCandidate !== undefined &&
      comparePerformance(previousCandidate, candidate) === 0
        ? previousRank
        : index + 1
    previousCandidate = candidate
    previousRank = rank
    return { ...candidate, rank }
  })
}

function comparePerformance(
  left: LeaderboardCandidate,
  right: LeaderboardCandidate,
): number {
  return (
    left.evidenceLevel - right.evidenceLevel ||
    left.totalWrongGuesses - right.totalWrongGuesses ||
    left.elapsedMilliseconds - right.elapsedMilliseconds
  )
}

function comparePaginationOrder(
  left: LeaderboardCandidate,
  right: LeaderboardCandidate,
): number {
  const performanceOrder = comparePerformance(left, right)
  if (performanceOrder !== 0) return performanceOrder
  if (left.attemptId < right.attemptId) return -1
  if (left.attemptId > right.attemptId) return 1
  return 0
}

function assertUniqueCandidates(
  candidates: readonly LeaderboardCandidate[],
): void {
  const attemptIds = new Set<string>()
  for (const candidate of candidates) {
    assertLeaderboardCandidate(candidate)
    if (attemptIds.has(candidate.attemptId)) {
      throw new RangeError('leaderboard attempt IDs must be unique')
    }
    attemptIds.add(candidate.attemptId)
  }
}

function assertLeaderboardCandidate(
  candidate: unknown,
): asserts candidate is LeaderboardCandidate {
  if (typeof candidate !== 'object' || candidate === null) {
    throw new TypeError('leaderboard candidate must be an object')
  }

  const entry: Record<string, unknown> = { ...candidate }
  if (entry.state !== 'SOLVED') {
    throw new RangeError('leaderboard accepts SOLVED attempts only')
  }
  const evidenceLevel = entry.evidenceLevel
  if (!isEvidenceLevel(evidenceLevel)) {
    throw new RangeError('leaderboard evidenceLevel must be zero through four')
  }
  if (
    typeof entry.totalWrongGuesses !== 'number' ||
    !Number.isSafeInteger(entry.totalWrongGuesses) ||
    entry.totalWrongGuesses < 0 ||
    entry.totalWrongGuesses > evidenceLevel * 3 + 2
  ) {
    throw new RangeError(
      'leaderboard totalWrongGuesses is unreachable at this evidence level',
    )
  }
  if (
    typeof entry.elapsedMilliseconds !== 'number' ||
    !Number.isSafeInteger(entry.elapsedMilliseconds) ||
    entry.elapsedMilliseconds < 0
  ) {
    throw new RangeError(
      'leaderboard elapsedMilliseconds must be a non-negative safe integer',
    )
  }
  if (typeof entry.attemptId !== 'string' || entry.attemptId.length === 0) {
    throw new RangeError('leaderboard attemptId must not be empty')
  }
}

function isEvidenceLevel(value: unknown): value is EvidenceLevel {
  return EVIDENCE_LEVELS.some((evidenceLevel) => evidenceLevel === value)
}
