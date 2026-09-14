import type { ApiErrorCode } from './schemas.js'

export const API_CONTRACT_OWNERS = Object.freeze({
  artifact: 'packages/contracts/src/api.ts',
  provider: 'apps/api',
  consumers: ['apps/web', 'operator HTTP examples'],
  approver: 'repository maintainers',
})

const productionSessionCookie = Object.freeze({
  name: '__Host-loremaster_session',
  httpOnly: true,
  secure: true,
  sameSite: 'lax',
  path: '/',
  domain: undefined,
})

const productionCsrfCookie = Object.freeze({
  name: '__Host-loremaster_csrf',
  httpOnly: false,
  secure: true,
  sameSite: 'lax',
  path: '/',
  domain: undefined,
})

const localSessionCookie = Object.freeze({
  name: 'loremaster_local_session',
  httpOnly: true,
  secure: false,
  sameSite: 'lax',
  path: '/',
  domain: undefined,
})

const localCsrfCookie = Object.freeze({
  name: 'loremaster_local_csrf',
  httpOnly: false,
  secure: false,
  sameSite: 'lax',
  path: '/',
  domain: undefined,
})

export const COOKIE_POLICIES = Object.freeze({
  production: Object.freeze({
    session: productionSessionCookie,
    csrf: productionCsrfCookie,
    clearWithIdenticalAttributes: true,
  }),
  local: Object.freeze({
    session: localSessionCookie,
    csrf: localCsrfCookie,
    clearWithIdenticalAttributes: true,
    forbiddenInProduction: true,
  }),
})

export const CORS_POLICY = Object.freeze({
  allowCredentials: true,
  allowOrigin: 'EXACT_CONFIGURED_ORIGIN',
  allowHeaders: Object.freeze([
    'Content-Type',
    'Idempotency-Key',
    'X-CSRF-Token',
  ]),
  allowMethods: Object.freeze(['GET', 'POST', 'OPTIONS']),
  vary: 'Origin',
  wildcardAllowed: false,
})

export const REQUEST_PARSING_POLICY = Object.freeze({
  duplicateJsonKeys: 'REJECT',
  repeatedSecurityHeaders: 'REJECT',
  repeatedQueryParameters: 'REJECT',
  unknownObjectFields: 'REJECT',
  requestId: 'SERVER_GENERATED_UUID',
})

export const SESSION_BOOTSTRAP_POLICY = Object.freeze({
  route: 'POST /api/v1/session',
  exactBody: '{}',
  requiresAuthentication: false,
  requiresCsrf: false,
  requiresIdempotencyKey: false,
  requiresExactOrigin: true,
  rateLimit: '10_PER_SOURCE_IP_PER_MINUTE',
})

export const LEADERBOARD_CURSOR_POLICY = Object.freeze({
  algorithm: 'HMAC-SHA-256',
  minimumKeyBytes: 32,
  envelopeVersion: 'v1',
  orderingSchema: 'e-w-elapsed-id-v1',
  bindsSlotId: true,
  acceptedKeyVersions: 'ACTIVE_AND_PREVIOUS',
  issueWithKeyVersion: 'ACTIVE_ONLY',
  keyIdsAndMaterialMustBeDistinct: true,
  previousKeyGraceSeconds: 86_400,
  retirePreviousAfterGrace: true,
  rejectUnknownKeyVersion: true,
  rejectWrongSlot: true,
  compareAuthenticationTagConstantTime: true,
})

export const GAMEPLAY_REJECTION_HTTP = Object.freeze({
  EVIDENCE_LIMIT: { status: 409, code: 'EVIDENCE_LIMIT' },
  IDEMPOTENCY_CONFLICT: { status: 409, code: 'IDEMPOTENCY_CONFLICT' },
  INVALID_COMMAND: { status: 400, code: 'INVALID_REQUEST' },
  SESSION_EXPIRED: { status: 401, code: 'AUTHENTICATION_REQUIRED' },
  STALE_VERSION: { status: 409, code: 'STALE_VERSION' },
  TERMINAL_ATTEMPT: { status: 409, code: 'TERMINAL_ATTEMPT' },
  UNKNOWN_ATTEMPT: { status: 404, code: 'RESOURCE_NOT_FOUND' },
  UNKNOWN_ENTITY: { status: 400, code: 'INVALID_GUESS' },
  NO_CASE: { status: 409, code: 'NO_CURRENT_CASE' },
} as const satisfies Readonly<
  Record<string, { readonly status: number; readonly code: ApiErrorCode }>
>)

export const SUGGESTION_ACCESS_POLICY = Object.freeze({
  requiresOwnedAttempt: true,
  requiresCurrentSlot: true,
  requiresActiveAttempt: true,
  unknownForeignAndTerminalResponse: 'RESOURCE_NOT_FOUND',
  fetchesExternalUrls: false,
})
