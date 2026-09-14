import type {
  AttemptProjection,
  CaseProjection,
  EvidenceLevel,
  ProfileStatistics,
  RegionalKnowledge,
} from '@loremaster/domain'

export type GameplayCommandKind = 'GUESS' | 'REVEAL' | 'GIVE_UP'

export const GAMEPLAY_COMMAND_OUTCOME_CODES = [
  'CORRECT',
  'WRONG',
  'REVEALED',
  'GIVEN_UP',
] as const

export type GameplayCommandOutcomeCode =
  (typeof GAMEPLAY_COMMAND_OUTCOME_CODES)[number]

export interface GameplayIdentity {
  readonly guestId: string
  readonly sessionId: string
}

export interface StartAttemptRequest extends GameplayIdentity {
  readonly idempotencyKey: string
}

export interface GameplayCommandRequest extends GameplayIdentity {
  readonly attemptId: string
  readonly expectedVersion: number
  readonly idempotencyKey: string
  readonly command:
    | { readonly kind: 'GUESS'; readonly entityId: string }
    | { readonly kind: 'REVEAL' }
    | { readonly kind: 'GIVE_UP' }
}

export type GameplayRejectionCode =
  | 'EVIDENCE_LIMIT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'INVALID_COMMAND'
  | 'SESSION_EXPIRED'
  | 'STALE_VERSION'
  | 'TERMINAL_ATTEMPT'
  | 'UNKNOWN_ATTEMPT'
  | 'UNKNOWN_ENTITY'

export type GameplayCommandResult =
  | {
      readonly ok: true
      readonly outcomeCode: GameplayCommandOutcomeCode
      readonly projection: AttemptProjection
      readonly replayed: boolean
    }
  | {
      readonly code: GameplayRejectionCode
      readonly ok: false
      readonly projection?: AttemptProjection
    }

export type StartAttemptResult =
  | {
      readonly ok: true
      readonly outcomeCode: 'STARTED'
      readonly projection: AttemptProjection
      readonly replayed: boolean
    }
  | {
      readonly code:
        | 'IDEMPOTENCY_CONFLICT'
        | 'INVALID_COMMAND'
        | 'NO_CASE'
        | 'SESSION_EXPIRED'
      readonly ok: false
      readonly projection?: CaseProjection
    }

export interface ProfileProjection extends ProfileStatistics {
  readonly regionalKnowledge: readonly RegionalKnowledge[]
}

export interface LeaderboardEntry {
  readonly attemptId: string
  readonly pseudonym: string
  readonly evidenceLevel: EvidenceLevel
  readonly totalWrongGuesses: number
  readonly elapsedMilliseconds: number
  readonly score: number
  readonly rank: number
}
