import { describe, expect, expectTypeOf, it } from 'vitest'

import type { ActiveAttemptProjection } from '../../packages/domain/src/index.js'

import {
  API_CONTRACT_LIMITS,
  API_CONTRACT_OWNERS,
  API_ERROR_STATUS,
  API_OPERATIONS,
  API_RETRY_POLICY,
  COOKIE_POLICIES,
  CORS_POLICY,
  GAMEPLAY_REJECTION_HTTP,
  LEADERBOARD_CURSOR_POLICY,
  activeAttemptProjectionSchema,
  canonicalGameplayCommandInput,
  canonicalStartInput,
  commandResponseSchema,
  errorResponseSchema,
  gameplayCommandRequestSchema,
  idempotencyKeySchema,
  leaderboardCursorPayloadSchema,
  leaderboardCursorSchema,
  leaderboardQuerySchema,
  sessionBootstrapRequestSchema,
  slotIdSchema,
  suggestionsQuerySchema,
  terminalAttemptProjectionSchema,
  type GameplayCommandRequest,
  type PublicActiveAttempt,
} from '../../packages/contracts/src/index.js'

const suggestion = {
  entityId: 'dockmaster_vesa',
  canonicalName: 'Dockmaster Vesa',
  publicRole: 'Harbor official',
  aliases: ['Vesa'],
}

const alternateSuggestion = {
  entityId: 'archivist_noma',
  canonicalName: 'Archivist Noma',
  publicRole: 'Quay archivist',
  aliases: ['Noma'],
}

const activeAttempt = {
  view: 'ATTEMPT',
  attemptId: '00000000-0000-4000-8000-000000000001',
  state: 'ACTIVE',
  version: 2,
  startedAt: '2026-09-14T00:00:01.000Z',
  closesAt: '2026-09-15T00:00:00.000Z',
  evidenceLevel: 1,
  wrongGuessesAtLevel: 0,
  totalWrongGuesses: 0,
  briefing: 'A sealed manifest vanished from the quay.',
  suggestions: [suggestion, alternateSuggestion],
  guessHistory: [],
  evidence: [{ level: 1, text: 'The harbor bell rang twice.' }],
} as const

const terminalAttempt = {
  ...activeAttempt,
  state: 'SOLVED',
  answer: suggestion,
  evidence: [1, 2, 3, 4].map((level) => ({
    level,
    text: `Evidence ${level}`,
    explanation: `Explanation ${level}`,
    sourceReferences: [`source/${level}`],
  })),
} as const

describe('S5.1 request contracts', () => {
  it('accepts only the exact session bootstrap body', () => {
    expect(sessionBootstrapRequestSchema.parse({})).toEqual({})
    expect(() =>
      sessionBootstrapRequestSchema.parse({ guestId: 'chosen' }),
    ).toThrow()
    expect(() => sessionBootstrapRequestSchema.parse(null)).toThrow()
  })

  it('bounds idempotency keys to printable ASCII', () => {
    expect(idempotencyKeySchema.parse('retry key-01')).toBe('retry key-01')
    expect(() => idempotencyKeySchema.parse('')).toThrow()
    expect(() => idempotencyKeySchema.parse('a'.repeat(129))).toThrow()
    expect(() => idempotencyKeySchema.parse('non-ascii-é')).toThrow()
    expect(() => idempotencyKeySchema.parse('line\nbreak')).toThrow()
  })

  it('rejects unknown command fields, wrong types, and unreachable versions', () => {
    const valid = {
      expectedVersion: 3,
      command: { kind: 'GUESS', entityId: 'dockmaster_vesa' },
    }
    expect(gameplayCommandRequestSchema.parse(valid)).toEqual(valid)
    expect(() =>
      gameplayCommandRequestSchema.parse({
        ...valid,
        guestId: 'client-selected',
      }),
    ).toThrow()
    expect(() =>
      gameplayCommandRequestSchema.parse({ ...valid, expectedVersion: -1 }),
    ).toThrow()
    expect(() =>
      gameplayCommandRequestSchema.parse({
        expectedVersion: 3,
        command: { kind: 'REVEAL', entityId: 'unexpected' },
      }),
    ).toThrow()
  })

  it('validates calendar dates and query bounds before repository use', () => {
    expect(slotIdSchema.parse('2026-09-14')).toBe('2026-09-14')
    expect(() => slotIdSchema.parse('2026-02-30')).toThrow()
    expect(
      leaderboardQuerySchema.parse({ limit: '20', cursor: undefined }),
    ).toEqual({ limit: '20', cursor: undefined })
    expect(() => leaderboardQuerySchema.parse({ limit: '0' })).toThrow()
    expect(() => leaderboardQuerySchema.parse({ limit: '101' })).toThrow()
    expect(() =>
      leaderboardQuerySchema.parse({ limit: ['20', '30'] }),
    ).toThrow()
  })

  it('accepts UTC response timestamps and rejects offset variants', () => {
    expect(activeAttemptProjectionSchema.parse(activeAttempt).startedAt).toBe(
      '2026-09-14T00:00:01.000Z',
    )
    expect(() =>
      activeAttemptProjectionSchema.parse({
        ...activeAttempt,
        startedAt: '2026-09-14T07:00:01.000+07:00',
      }),
    ).toThrow()
  })

  it('normalizes useful autocomplete text and rejects controls', () => {
    expect(suggestionsQuerySchema.parse({ q: '  Vesa  ' })).toEqual({
      q: 'Vesa',
    })
    expect(() => suggestionsQuerySchema.parse({ q: '   ' })).toThrow()
    expect(() => suggestionsQuerySchema.parse({ q: 'Vesa\u0000' })).toThrow()
    expect(() => suggestionsQuerySchema.parse({ q: 'Vesa\u0085' })).toThrow()
  })
})

describe('S5.1 canonical command identity', () => {
  it('matches the S4 v1 fingerprint tuple independently of HTTP field order', () => {
    const attemptId = '00000000-0000-4000-8000-000000000001'
    const left = gameplayCommandRequestSchema.parse({
      expectedVersion: 7,
      command: { kind: 'GUESS', entityId: 'dockmaster_vesa' },
    })
    const right = gameplayCommandRequestSchema.parse({
      command: { entityId: 'dockmaster_vesa', kind: 'GUESS' },
      expectedVersion: 7,
    })

    expect(canonicalGameplayCommandInput(attemptId, left)).toEqual([
      'v1',
      'GUESS',
      attemptId,
      7,
      'dockmaster_vesa',
    ])
    expect(canonicalGameplayCommandInput(attemptId, right)).toEqual(
      canonicalGameplayCommandInput(attemptId, left),
    )
    expect(canonicalStartInput()).toEqual(['v1', 'START'])
    expect(() => canonicalGameplayCommandInput('not-a-uuid', left)).toThrow()
    expectTypeOf(left).toEqualTypeOf<GameplayCommandRequest>()
    expectTypeOf<PublicActiveAttempt>().toMatchTypeOf<ActiveAttemptProjection>()
  })
})

describe('S5.1 public response confidentiality', () => {
  it('accepts a bounded ACTIVE projection and rejects private/terminal fields', () => {
    expect(activeAttemptProjectionSchema.parse(activeAttempt)).toEqual(
      activeAttempt,
    )
    expect(() =>
      activeAttemptProjectionSchema.parse({
        ...activeAttempt,
        answer: suggestion,
      }),
    ).toThrow()
    expect(() =>
      activeAttemptProjectionSchema.parse({
        ...activeAttempt,
        evidence: [
          ...activeAttempt.evidence,
          { level: 2, text: 'Future evidence' },
        ],
      }),
    ).toThrow()
    expect(() =>
      activeAttemptProjectionSchema.parse({
        ...activeAttempt,
        evidence: [
          { ...activeAttempt.evidence[0], explanation: 'Private explanation' },
        ],
      }),
    ).toThrow()
  })

  it('requires all four explained evidence entries for terminal projections', () => {
    expect(terminalAttemptProjectionSchema.parse(terminalAttempt)).toEqual(
      terminalAttempt,
    )
    expect(() =>
      terminalAttemptProjectionSchema.parse({
        ...terminalAttempt,
        evidence: terminalAttempt.evidence.slice(0, 3),
      }),
    ).toThrow()
  })

  it('correlates fresh outcomes with state while preserving T23 replay projection', () => {
    expect(
      commandResponseSchema.parse({
        data: {
          outcomeCode: 'CORRECT',
          replayed: false,
          attempt: terminalAttempt,
        },
      }),
    ).toBeDefined()
    expect(() =>
      commandResponseSchema.parse({
        data: {
          outcomeCode: 'CORRECT',
          replayed: false,
          attempt: activeAttempt,
        },
      }),
    ).toThrow()
    expect(() =>
      commandResponseSchema.parse({
        data: {
          outcomeCode: 'GIVEN_UP',
          replayed: false,
          attempt: terminalAttempt,
        },
      }),
    ).toThrow()
    expect(
      commandResponseSchema.parse({
        data: {
          outcomeCode: 'WRONG',
          replayed: true,
          attempt: terminalAttempt,
        },
      }),
    ).toBeDefined()
  })

  it('keeps public errors stable and free of arbitrary messages/details', () => {
    const error = {
      error: {
        code: 'INVALID_REQUEST',
        requestId: '00000000-0000-4000-8000-000000000099',
        fields: [{ path: '$.expectedVersion', code: 'OUT_OF_BOUNDS' }],
      },
    }
    expect(errorResponseSchema.parse(error)).toEqual(error)
    expect(() =>
      errorResponseSchema.parse({
        error: { ...error.error, message: 'SQL contained secret value' },
      }),
    ).toThrow()
    expect(() =>
      errorResponseSchema.parse({
        error: {
          ...error.error,
          fields: [{ path: '$.password=secret\nSQL', code: 'INVALID_FORMAT' }],
        },
      }),
    ).toThrow()
  })
})

describe('S5.1 route, status, cursor, and browser policies', () => {
  it('defines one versioned operation for every frozen route', () => {
    expect(Object.keys(API_OPERATIONS).sort()).toEqual([
      'createSession',
      'getCurrentCase',
      'getLeaderboard',
      'getOwnedAttempt',
      'getProfile',
      'getSession',
      'getSuggestions',
      'healthLive',
      'healthReady',
      'runGameplayCommand',
      'startCurrentAttempt',
    ])
    expect(
      new Set(
        Object.values(API_OPERATIONS).map(({ operationId }) => operationId),
      ).size,
    ).toBe(11)
    expect(API_OPERATIONS.createSession).toMatchObject({
      method: 'POST',
      path: '/api/v1/session',
      auth: 'BOOTSTRAP',
      successStatus: 201,
    })
    expect(API_OPERATIONS.runGameplayCommand.errorStatuses).toContain(409)
    expect(API_OPERATIONS.runGameplayCommand.errorStatuses).toContain(504)
    expect(API_OPERATIONS.runGameplayCommand.errorStatuses).toContain(429)
    expect(API_OPERATIONS.startCurrentAttempt.errorStatuses).toContain(429)
    expect(API_OPERATIONS.getSuggestions.errorStatuses).toContain(429)
    expect(API_OPERATIONS.getOwnedAttempt.errorStatuses).not.toContain(429)
    expect(API_OPERATIONS.startCurrentAttempt.successStatus).toBe(200)
  })

  it('freezes rejection mappings and retry semantics', () => {
    expect(GAMEPLAY_REJECTION_HTTP).toMatchObject({
      IDEMPOTENCY_CONFLICT: { status: 409, code: 'IDEMPOTENCY_CONFLICT' },
      STALE_VERSION: { status: 409, code: 'STALE_VERSION' },
      UNKNOWN_ATTEMPT: { status: 404, code: 'RESOURCE_NOT_FOUND' },
      UNKNOWN_ENTITY: { status: 400, code: 'INVALID_GUESS' },
      SESSION_EXPIRED: { status: 401, code: 'AUTHENTICATION_REQUIRED' },
    })
    expect(API_ERROR_STATUS.REQUEST_TIMEOUT).toBe(504)
    expect(API_RETRY_POLICY.gameplayMutation.REQUEST_TIMEOUT).toBe(
      'SAME_IDEMPOTENCY_KEY_ONLY',
    )
    expect(API_RETRY_POLICY.sessionBootstrap.SERVICE_UNAVAILABLE).toBe(
      'AFTER_BACKOFF',
    )
  })

  it('defines an authenticated, versioned, slot-bound cursor envelope', () => {
    expect(LEADERBOARD_CURSOR_POLICY).toMatchObject({
      algorithm: 'HMAC-SHA-256',
      envelopeVersion: 'v1',
      orderingSchema: 'e-w-elapsed-id-v1',
      acceptedKeyVersions: 'ACTIVE_AND_PREVIOUS',
      issueWithKeyVersion: 'ACTIVE_ONLY',
      minimumKeyBytes: 32,
      previousKeyGraceSeconds: 86_400,
    })
    expect(
      leaderboardCursorPayloadSchema.parse({
        version: 1,
        slotId: '2026-09-14',
        orderingSchema: 'e-w-elapsed-id-v1',
        evidenceLevel: 1,
        totalWrongGuesses: 3,
        elapsedMilliseconds: 42_000,
        attemptId: '00000000-0000-4000-8000-000000000001',
      }),
    ).toBeDefined()
    expect(
      leaderboardCursorSchema.parse(
        `v1.k1.${'a'.repeat(24)}.${'b'.repeat(43)}`,
      ),
    ).toBeDefined()
    expect(() => leaderboardCursorSchema.parse('plain-base64url')).toThrow()
    expect(() =>
      leaderboardQuerySchema.parse({ cursor: 'plain-base64url' }),
    ).toThrow()
  })

  it('freezes cookie, CORS, parsing, and ownership policies', () => {
    expect(COOKIE_POLICIES.production.session).toEqual({
      name: '__Host-loremaster_session',
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      domain: undefined,
    })
    expect(COOKIE_POLICIES.local.session.name).toBe('loremaster_local_session')
    expect(COOKIE_POLICIES.local.session.secure).toBe(false)
    expect(CORS_POLICY).toMatchObject({
      allowCredentials: true,
      allowOrigin: 'EXACT_CONFIGURED_ORIGIN',
      allowHeaders: ['Content-Type', 'Idempotency-Key', 'X-CSRF-Token'],
      allowMethods: ['GET', 'POST', 'OPTIONS'],
    })
    expect(CORS_POLICY.allowOrigin).not.toBe('*')
    expect(API_CONTRACT_LIMITS).toMatchObject({
      jsonBodyBytes: 16 * 1024,
      autocompleteQueryCharacters: 80,
      autocompleteResults: 20,
      idempotencyKeyCharacters: 128,
    })
    expect(API_CONTRACT_OWNERS).toMatchObject({
      artifact: 'packages/contracts/src/api.ts',
      provider: 'apps/api',
      consumers: ['apps/web', 'operator HTTP examples'],
    })
  })
})
