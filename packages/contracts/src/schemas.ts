import { z } from 'zod'

import { API_CONTRACT_LIMITS, API_TIMEOUTS_MILLISECONDS } from './limits.js'

const IDENTIFIER_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/u
const IDEMPOTENCY_KEY_PATTERN = /^[\x20-\x7e]+$/u
const LEADERBOARD_LIMIT_PATTERN = /^(?:[1-9]|[1-9][0-9]|100)$/u
const CURSOR_PATTERN =
  /^v1\.[A-Za-z0-9_-]{1,16}\.[A-Za-z0-9_-]{1,512}\.[A-Za-z0-9_-]{43}$/u

function containsNoControlCharacters(value: string): boolean {
  return Array.from(value).every((character) => {
    const codePoint = character.codePointAt(0)!
    return !(codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
  })
}

const safeNonNegativeIntegerSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER)

export const uuidSchema = z.string().uuid()

export const slotIdSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u)
  .refine((value) => {
    const timestamp = Date.parse(`${value}T00:00:00.000Z`)
    return (
      Number.isFinite(timestamp) &&
      new Date(timestamp).toISOString().slice(0, 10) === value
    )
  }, 'slot ID must be a valid UTC calendar date')

export const timestampSchema = z.string().datetime({ offset: false })

export const entityIdSchema = z
  .string()
  .min(1)
  .max(API_CONTRACT_LIMITS.entityIdCharacters)
  .regex(IDENTIFIER_PATTERN)

export const idempotencyKeySchema = z
  .string()
  .min(1)
  .max(API_CONTRACT_LIMITS.idempotencyKeyCharacters)
  .regex(IDEMPOTENCY_KEY_PATTERN)

export const leaderboardCursorSchema = z
  .string()
  .min(1)
  .max(API_CONTRACT_LIMITS.cursorCharacters)
  .regex(CURSOR_PATTERN)

export const csrfTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u)

export const sessionBootstrapRequestSchema = z.strictObject({})

export const gameplayCommandRequestSchema = z.strictObject({
  expectedVersion: safeNonNegativeIntegerSchema,
  command: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('GUESS'),
      entityId: entityIdSchema,
    }),
    z.strictObject({ kind: z.literal('REVEAL') }),
    z.strictObject({ kind: z.literal('GIVE_UP') }),
  ]),
})

export type GameplayCommandRequest = z.output<
  typeof gameplayCommandRequestSchema
>

export const attemptPathSchema = z.strictObject({ attemptId: uuidSchema })

export const leaderboardPathSchema = z.strictObject({ slotId: slotIdSchema })

export const suggestionsQuerySchema = z.strictObject({
  q: z
    .string()
    .max(API_CONTRACT_LIMITS.autocompleteQueryCharacters)
    .trim()
    .min(1)
    .refine(containsNoControlCharacters),
})

export const leaderboardQuerySchema = z.strictObject({
  limit: z.string().regex(LEADERBOARD_LIMIT_PATTERN).optional(),
  cursor: leaderboardCursorSchema.optional(),
})

export const mutationHeadersSchema = z.strictObject({
  contentType: z.literal('application/json'),
  csrfToken: csrfTokenSchema,
  idempotencyKey: idempotencyKeySchema,
  origin: z.string().url().max(2_048),
})

export const bootstrapHeadersSchema = z.strictObject({
  contentType: z.literal('application/json'),
  origin: z.string().url().max(2_048),
})

const publicEntitySuggestionSchema = z.strictObject({
  entityId: entityIdSchema,
  canonicalName: z
    .string()
    .min(1)
    .max(API_CONTRACT_LIMITS.publicNameCharacters),
  publicRole: z.string().min(1).max(API_CONTRACT_LIMITS.publicRoleCharacters),
  aliases: z
    .array(z.string().min(1).max(API_CONTRACT_LIMITS.aliasCharacters))
    .min(1)
    .max(API_CONTRACT_LIMITS.aliasesPerEntity),
})

const publicGuessSchema = z.strictObject({
  entityId: entityIdSchema,
  guessedAt: timestampSchema,
})

const publicEvidenceSchema = z.strictObject({
  level: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  text: z.string().min(1).max(API_CONTRACT_LIMITS.evidenceTextCharacters),
})

const terminalEvidenceSchema = publicEvidenceSchema.extend({
  explanation: z.string().min(1).max(API_CONTRACT_LIMITS.explanationCharacters),
  sourceReferences: z
    .array(z.string().min(1).max(API_CONTRACT_LIMITS.sourceReferenceCharacters))
    .min(1)
    .max(API_CONTRACT_LIMITS.sourceReferencesPerEvidence),
})

const attemptProjectionBase = {
  view: z.literal('ATTEMPT'),
  attemptId: uuidSchema,
  version: safeNonNegativeIntegerSchema,
  startedAt: timestampSchema,
  closesAt: timestampSchema,
  evidenceLevel: z.union([
    z.literal(0),
    z.literal(1),
    z.literal(2),
    z.literal(3),
    z.literal(4),
  ]),
  wrongGuessesAtLevel: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  totalWrongGuesses: z.number().int().min(0).max(15),
  briefing: z.string().min(1).max(API_CONTRACT_LIMITS.briefingCharacters),
  suggestions: z.array(publicEntitySuggestionSchema).min(2).max(32),
  guessHistory: z.array(publicGuessSchema).max(15),
}

function countersAreReachable(value: {
  evidenceLevel: number
  wrongGuessesAtLevel: number
  totalWrongGuesses: number
}): boolean {
  return (
    value.totalWrongGuesses >= value.wrongGuessesAtLevel &&
    value.totalWrongGuesses <=
      value.evidenceLevel * 3 + value.wrongGuessesAtLevel
  )
}

export const activeAttemptProjectionSchema = z
  .strictObject({
    ...attemptProjectionBase,
    state: z.literal('ACTIVE'),
    evidence: z.array(publicEvidenceSchema).max(4),
  })
  .superRefine((value, context) => {
    if (!countersAreReachable(value)) {
      context.addIssue({ code: 'custom', message: 'unreachable counters' })
    }
    if (
      value.evidence.length !== value.evidenceLevel ||
      value.evidence.some((item, index) => item.level !== index + 1)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['evidence'],
        message: 'ACTIVE evidence must contain exactly levels 1..e',
      })
    }
  })

export type PublicActiveAttempt = z.output<typeof activeAttemptProjectionSchema>

export const terminalAttemptProjectionSchema = z
  .strictObject({
    ...attemptProjectionBase,
    state: z.enum(['SOLVED', 'GIVEN_UP', 'EXHAUSTED', 'EXPIRED']),
    answer: publicEntitySuggestionSchema,
    evidence: z.tuple([
      terminalEvidenceSchema,
      terminalEvidenceSchema,
      terminalEvidenceSchema,
      terminalEvidenceSchema,
    ]),
  })
  .superRefine((value, context) => {
    if (
      value.evidence.some((item, index) => item.level !== index + 1) ||
      (value.state === 'EXHAUSTED' &&
        (value.evidenceLevel !== 4 ||
          value.wrongGuessesAtLevel !== 2 ||
          value.totalWrongGuesses !== 15)) ||
      (value.state !== 'EXHAUSTED' && !countersAreReachable(value))
    ) {
      context.addIssue({
        code: 'custom',
        message: 'invalid terminal projection',
      })
    }
  })

export const attemptProjectionSchema = z.union([
  activeAttemptProjectionSchema,
  terminalAttemptProjectionSchema,
])

export const caseProjectionSchema = z.union([
  z.strictObject({ view: z.literal('NO_CASE') }),
  z.strictObject({
    view: z.literal('NOT_STARTED'),
    slotId: slotIdSchema,
    opensAt: timestampSchema,
    closesAt: timestampSchema,
  }),
  attemptProjectionSchema,
])

export const sessionResponseSchema = z.strictObject({
  data: z.strictObject({ expiresAt: timestampSchema }),
})

export const caseResponseSchema = z.strictObject({ data: caseProjectionSchema })

export const attemptResponseSchema = z.strictObject({
  data: attemptProjectionSchema,
})

const solvedAttemptProjectionSchema = terminalAttemptProjectionSchema.refine(
  (value) => value.state === 'SOLVED',
)
const givenUpAttemptProjectionSchema = terminalAttemptProjectionSchema.refine(
  (value) => value.state === 'GIVEN_UP',
)
const exhaustedAttemptProjectionSchema = terminalAttemptProjectionSchema.refine(
  (value) => value.state === 'EXHAUSTED',
)

export const commandResponseSchema = z.union([
  z.strictObject({
    data: z.strictObject({
      outcomeCode: z.enum(['CORRECT', 'WRONG', 'REVEALED', 'GIVEN_UP']),
      replayed: z.literal(true),
      attempt: attemptProjectionSchema,
    }),
  }),
  z.strictObject({
    data: z.strictObject({
      outcomeCode: z.literal('CORRECT'),
      replayed: z.literal(false),
      attempt: solvedAttemptProjectionSchema,
    }),
  }),
  z.strictObject({
    data: z.strictObject({
      outcomeCode: z.literal('GIVEN_UP'),
      replayed: z.literal(false),
      attempt: givenUpAttemptProjectionSchema,
    }),
  }),
  z.strictObject({
    data: z.strictObject({
      outcomeCode: z.literal('REVEALED'),
      replayed: z.literal(false),
      attempt: activeAttemptProjectionSchema,
    }),
  }),
  z.strictObject({
    data: z.strictObject({
      outcomeCode: z.literal('WRONG'),
      replayed: z.literal(false),
      attempt: z.union([
        activeAttemptProjectionSchema,
        exhaustedAttemptProjectionSchema,
      ]),
    }),
  }),
])

export const startAttemptResponseSchema = z.strictObject({
  data: z.strictObject({
    outcomeCode: z.literal('STARTED'),
    replayed: z.boolean(),
    attempt: attemptProjectionSchema,
  }),
})

export const suggestionsResponseSchema = z.strictObject({
  data: z.strictObject({
    items: z.array(publicEntitySuggestionSchema).max(20),
  }),
})

const regionalKnowledgeSchema = z.strictObject({
  regionId: entityIdSchema,
  alphaHundredths: safeNonNegativeIntegerSchema,
  betaHundredths: safeNonNegativeIntegerSchema,
  sampleCount: safeNonNegativeIntegerSchema,
  displayPercentage: z.number().int().min(0).max(100),
})

export const profileResponseSchema = z.strictObject({
  data: z.strictObject({
    currentStreak: safeNonNegativeIntegerSchema,
    longestStreak: safeNonNegativeIntegerSchema,
    solvedCount: safeNonNegativeIntegerSchema,
    failedCount: safeNonNegativeIntegerSchema,
    accuracyPercentage: z.number().int().min(0).max(100),
    regionalKnowledge: z.array(regionalKnowledgeSchema),
  }),
})

const leaderboardEntrySchema = z.strictObject({
  attemptId: uuidSchema,
  pseudonym: z.string().min(1).max(48),
  evidenceLevel: z.union([
    z.literal(0),
    z.literal(1),
    z.literal(2),
    z.literal(3),
    z.literal(4),
  ]),
  totalWrongGuesses: z.number().int().min(0).max(15),
  elapsedMilliseconds: safeNonNegativeIntegerSchema,
  score: safeNonNegativeIntegerSchema,
  rank: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
})

export const leaderboardCursorPayloadSchema = z.strictObject({
  version: z.literal(1),
  slotId: slotIdSchema,
  orderingSchema: z.literal('e-w-elapsed-id-v1'),
  evidenceLevel: z.union([
    z.literal(0),
    z.literal(1),
    z.literal(2),
    z.literal(3),
    z.literal(4),
  ]),
  totalWrongGuesses: z.number().int().min(0).max(15),
  elapsedMilliseconds: safeNonNegativeIntegerSchema,
  attemptId: uuidSchema,
})

export const leaderboardResponseSchema = z.strictObject({
  data: z.strictObject({
    items: z.array(leaderboardEntrySchema).max(100),
    nextCursor: leaderboardCursorSchema.nullable(),
  }),
})

export const healthResponseSchema = z.strictObject({
  status: z.enum(['ok', 'ready']),
})

export const API_ERROR_CODES = [
  'INVALID_REQUEST',
  'INVALID_GUESS',
  'AUTHENTICATION_REQUIRED',
  'REQUEST_FORBIDDEN',
  'RESOURCE_NOT_FOUND',
  'NO_CURRENT_CASE',
  'IDEMPOTENCY_CONFLICT',
  'STALE_VERSION',
  'EVIDENCE_LIMIT',
  'TERMINAL_ATTEMPT',
  'BODY_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
  'SERVICE_UNAVAILABLE',
  'REQUEST_TIMEOUT',
] as const

export type ApiErrorCode = (typeof API_ERROR_CODES)[number]

export const PUBLIC_ERROR_FIELD_PATHS = [
  '$',
  '$.attemptId',
  '$.command',
  '$.command.entityId',
  '$.command.kind',
  '$.cursor',
  '$.expectedVersion',
  '$.headers.contentType',
  '$.headers.csrfToken',
  '$.headers.idempotencyKey',
  '$.headers.origin',
  '$.limit',
  '$.q',
  '$.slotId',
] as const

export const errorResponseSchema = z.strictObject({
  error: z.strictObject({
    code: z.enum(API_ERROR_CODES),
    requestId: uuidSchema,
    fields: z
      .array(
        z.strictObject({
          path: z.enum(PUBLIC_ERROR_FIELD_PATHS),
          code: z.enum([
            'REQUIRED',
            'INVALID_TYPE',
            'INVALID_FORMAT',
            'OUT_OF_BOUNDS',
            'UNKNOWN_FIELD',
            'DUPLICATE_FIELD',
          ]),
        }),
      )
      .max(32)
      .optional(),
  }),
})

export const API_ERROR_STATUS = Object.freeze({
  INVALID_REQUEST: 400,
  INVALID_GUESS: 400,
  AUTHENTICATION_REQUIRED: 401,
  REQUEST_FORBIDDEN: 403,
  RESOURCE_NOT_FOUND: 404,
  NO_CURRENT_CASE: 409,
  IDEMPOTENCY_CONFLICT: 409,
  STALE_VERSION: 409,
  EVIDENCE_LIMIT: 409,
  TERMINAL_ATTEMPT: 409,
  BODY_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
  REQUEST_TIMEOUT: 504,
} as const satisfies Readonly<Record<ApiErrorCode, number>>)

export const API_RETRY_POLICY = Object.freeze({
  gameplayMutation: Object.freeze({
    INTERNAL_ERROR: 'SAME_IDEMPOTENCY_KEY_ONLY',
    SERVICE_UNAVAILABLE: 'SAME_IDEMPOTENCY_KEY_ONLY',
    REQUEST_TIMEOUT: 'SAME_IDEMPOTENCY_KEY_ONLY',
    RATE_LIMITED: 'AFTER_RETRY_AFTER_WITH_SAME_IDEMPOTENCY_KEY',
    STALE_VERSION: 'AFTER_REFRESH_WITH_NEW_COMMAND_KEY',
    IDEMPOTENCY_CONFLICT: 'NEW_VALID_COMMAND_KEY',
  }),
  sessionBootstrap: Object.freeze({
    RATE_LIMITED: 'AFTER_RETRY_AFTER',
    INTERNAL_ERROR: 'AFTER_BACKOFF',
    SERVICE_UNAVAILABLE: 'AFTER_BACKOFF',
  }),
  read: Object.freeze({
    INTERNAL_ERROR: 'AFTER_BACKOFF',
    SERVICE_UNAVAILABLE: 'AFTER_BACKOFF',
  }),
})

export const CONTRACT_TIMEOUT_POLICY = Object.freeze({
  ...API_TIMEOUTS_MILLISECONDS,
  responseAfterTransactionSettlement: true,
  mutationUncertaintyRetry: 'SAME_IDEMPOTENCY_KEY_ONLY',
})
