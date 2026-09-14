import {
  assertValidAttemptSnapshot,
  type ActiveAttempt,
  type AttemptSnapshot,
  type EvidenceLevel,
  type TerminalAttempt,
} from './attempt-engine.js'

export interface PublicEntitySuggestion {
  readonly entityId: string
  readonly canonicalName: string
  readonly publicRole: string
  readonly aliases: readonly string[]
}

interface PrivateEvidence<L extends 1 | 2 | 3 | 4> {
  readonly level: L
  readonly text: string
  readonly explanation: string
  readonly sourceReferences: readonly string[]
}

export type PrivateEvidenceSet = readonly [
  PrivateEvidence<1>,
  PrivateEvidence<2>,
  PrivateEvidence<3>,
  PrivateEvidence<4>,
]

export interface PrivateCaseFile {
  readonly slotId: string
  readonly revisionId: string
  readonly opensAt: string
  readonly closesAt: string
  readonly briefing: string
  readonly suggestions: readonly PublicEntitySuggestion[]
  readonly answerEntityId: string
  readonly evidence: PrivateEvidenceSet
}

export interface PublicSlot {
  readonly slotId: string
  readonly opensAt: string
  readonly closesAt: string
}

export interface PrivateGuessRecord {
  readonly guessId: string
  readonly guestId: string
  readonly entityId: string
  readonly guessedAt: string
}

export interface PrivateAttemptRecord {
  readonly attemptId: string
  readonly ownerGuestId: string
  readonly slotId: string
  readonly revisionId: string
  readonly version: number
  readonly startedAt: string
  readonly snapshotAt: string
  readonly attempt: AttemptSnapshot
  readonly guesses: readonly PrivateGuessRecord[]
}

export interface PublicGuess {
  readonly entityId: string
  readonly guessedAt: string
}

export interface NoCaseProjection {
  readonly view: 'NO_CASE'
}

export interface NotStartedProjection {
  readonly view: 'NOT_STARTED'
  readonly slotId: string
  readonly opensAt: string
  readonly closesAt: string
}

interface AttemptProjectionBase {
  readonly view: 'ATTEMPT'
  readonly attemptId: string
  readonly state: AttemptSnapshot['state']
  readonly version: number
  readonly startedAt: string
  readonly closesAt: string
  readonly evidenceLevel: EvidenceLevel
  readonly wrongGuessesAtLevel: 0 | 1 | 2
  readonly totalWrongGuesses: number
  readonly briefing: string
  readonly suggestions: readonly PublicEntitySuggestion[]
  readonly guessHistory: readonly PublicGuess[]
}

export interface PublicEvidence {
  readonly level: 1 | 2 | 3 | 4
  readonly text: string
}

export interface ActiveAttemptProjection extends AttemptProjectionBase {
  readonly state: 'ACTIVE'
  readonly evidence: readonly PublicEvidence[]
}

export interface TerminalEvidence extends PublicEvidence {
  readonly explanation: string
  readonly sourceReferences: readonly string[]
}

export interface TerminalAttemptProjection extends AttemptProjectionBase {
  readonly state: TerminalAttempt['state']
  readonly answer: PublicEntitySuggestion
  readonly evidence: readonly TerminalEvidence[]
}

export type AttemptProjection =
  ActiveAttemptProjection | TerminalAttemptProjection

export type CaseProjection =
  NoCaseProjection | NotStartedProjection | AttemptProjection

export function projectNoCase(): NoCaseProjection {
  return { view: 'NO_CASE' }
}

export function projectNotStarted(slot: PublicSlot): NotStartedProjection {
  return {
    view: 'NOT_STARTED',
    slotId: slot.slotId,
    opensAt: slot.opensAt,
    closesAt: slot.closesAt,
  }
}

export function projectAttempt(
  caseFile: PrivateCaseFile,
  record: PrivateAttemptRecord & { readonly attempt: ActiveAttempt },
  requestingGuestId: string,
): ActiveAttemptProjection
export function projectAttempt(
  caseFile: PrivateCaseFile,
  record: PrivateAttemptRecord & { readonly attempt: TerminalAttempt },
  requestingGuestId: string,
): TerminalAttemptProjection
export function projectAttempt(
  caseFile: PrivateCaseFile,
  record: PrivateAttemptRecord,
  requestingGuestId: string,
): AttemptProjection
export function projectAttempt(
  caseFile: PrivateCaseFile,
  record: PrivateAttemptRecord,
  requestingGuestId: string,
): AttemptProjection {
  if (record.ownerGuestId !== requestingGuestId) {
    throw new Error('attempt does not belong to the requesting guest')
  }
  if (record.guesses.some((guess) => guess.guestId !== record.ownerGuestId)) {
    throw new Error('guess history contains another guest')
  }
  if (
    record.slotId !== caseFile.slotId ||
    record.revisionId !== caseFile.revisionId
  ) {
    throw new Error('attempt does not reference the supplied case revision')
  }
  assertValidAttemptSnapshot(record.attempt)
  assertOrderedEvidence(caseFile.evidence)
  const base = projectAttemptBase(caseFile, record)

  if (record.attempt.state === 'ACTIVE') {
    return {
      ...base,
      state: 'ACTIVE',
      evidence: caseFile.evidence
        .slice(0, record.attempt.evidenceLevel)
        .map(projectPublicEvidence),
    }
  }

  const answer = caseFile.suggestions.find(
    (suggestion) => suggestion.entityId === caseFile.answerEntityId,
  )
  if (answer === undefined) {
    throw new RangeError('answerEntityId must identify a public suggestion')
  }

  return {
    ...base,
    state: record.attempt.state,
    answer: copySuggestion(answer),
    evidence: caseFile.evidence.map((item) => ({
      ...projectPublicEvidence(item),
      explanation: item.explanation,
      sourceReferences: [...item.sourceReferences],
    })),
  }
}

function projectAttemptBase(
  caseFile: PrivateCaseFile,
  record: PrivateAttemptRecord,
): AttemptProjectionBase {
  return {
    view: 'ATTEMPT',
    attemptId: record.attemptId,
    state: record.attempt.state,
    version: record.version,
    startedAt: record.startedAt,
    closesAt: caseFile.closesAt,
    evidenceLevel: record.attempt.evidenceLevel,
    wrongGuessesAtLevel: record.attempt.wrongGuessesAtLevel,
    totalWrongGuesses: record.attempt.totalWrongGuesses,
    briefing: caseFile.briefing,
    suggestions: caseFile.suggestions.map(copySuggestion),
    guessHistory: record.guesses.map((guess) => ({
      entityId: guess.entityId,
      guessedAt: guess.guessedAt,
    })),
  }
}

function copySuggestion(
  suggestion: PublicEntitySuggestion,
): PublicEntitySuggestion {
  return {
    entityId: suggestion.entityId,
    canonicalName: suggestion.canonicalName,
    publicRole: suggestion.publicRole,
    aliases: [...suggestion.aliases],
  }
}

function projectPublicEvidence(
  evidence: PrivateEvidence<1 | 2 | 3 | 4>,
): PublicEvidence {
  return { level: evidence.level, text: evidence.text }
}

function assertOrderedEvidence(evidence: PrivateEvidenceSet): void {
  if (
    evidence.length !== 4 ||
    evidence.some((item, index) => item.level !== index + 1)
  ) {
    throw new RangeError(
      'evidence must contain ordered levels one through four',
    )
  }
}
