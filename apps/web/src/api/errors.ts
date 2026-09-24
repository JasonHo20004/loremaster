import type { ApiErrorCode } from '@loremaster/contracts'

export type ApiErrorPresentationCategory =
  | 'ACCESS_DENIED'
  | 'INVALID_INPUT'
  | 'MISSING_RESOURCE'
  | 'RATE_LIMIT'
  | 'SERVER_PROBLEM'
  | 'SESSION_REQUIRED'
  | 'STATE_CHANGED'

export const API_ERROR_PRESENTATION = Object.freeze({
  INVALID_REQUEST: 'INVALID_INPUT',
  INVALID_GUESS: 'INVALID_INPUT',
  AUTHENTICATION_REQUIRED: 'SESSION_REQUIRED',
  REQUEST_FORBIDDEN: 'ACCESS_DENIED',
  RESOURCE_NOT_FOUND: 'MISSING_RESOURCE',
  NO_CURRENT_CASE: 'STATE_CHANGED',
  IDEMPOTENCY_CONFLICT: 'STATE_CHANGED',
  STALE_VERSION: 'STATE_CHANGED',
  EVIDENCE_LIMIT: 'STATE_CHANGED',
  TERMINAL_ATTEMPT: 'STATE_CHANGED',
  BODY_TOO_LARGE: 'INVALID_INPUT',
  UNSUPPORTED_MEDIA_TYPE: 'INVALID_INPUT',
  RATE_LIMITED: 'RATE_LIMIT',
  INTERNAL_ERROR: 'SERVER_PROBLEM',
  SERVICE_UNAVAILABLE: 'SERVER_PROBLEM',
  REQUEST_TIMEOUT: 'SERVER_PROBLEM',
} as const satisfies Readonly<
  Record<ApiErrorCode, ApiErrorPresentationCategory>
>)

export type ApiClientErrorKind =
  | 'API_ERROR'
  | 'CANCELLED'
  | 'INVALID_CLIENT_REQUEST'
  | 'MALFORMED_RESPONSE'
  | 'NETWORK_ERROR'
  | 'RATE_LIMITED'
  | 'SESSION_SECURITY'

interface ApiClientErrorDetails {
  readonly apiCode?: ApiErrorCode
  readonly presentation?: ApiErrorPresentationCategory
  readonly requestId?: string
  readonly retryAfterMilliseconds?: number
  readonly status?: number
}

const SAFE_MESSAGES = Object.freeze({
  API_ERROR: 'The service rejected the request.',
  CANCELLED: 'The request was cancelled.',
  INVALID_CLIENT_REQUEST: 'The request could not be created safely.',
  MALFORMED_RESPONSE: 'The service returned an invalid response.',
  NETWORK_ERROR: 'The service could not be reached.',
  RATE_LIMITED: 'Too many requests were made.',
  SESSION_SECURITY: 'The session security token is unavailable.',
} as const satisfies Readonly<Record<ApiClientErrorKind, string>>)

export class ApiClientError extends Error {
  readonly apiCode?: ApiErrorCode
  readonly kind: ApiClientErrorKind
  readonly presentation?: ApiErrorPresentationCategory
  readonly requestId?: string
  readonly retryAfterMilliseconds?: number
  readonly status?: number

  constructor(kind: ApiClientErrorKind, details: ApiClientErrorDetails = {}) {
    super(SAFE_MESSAGES[kind])
    this.name = 'ApiClientError'
    this.kind = kind
    this.apiCode = details.apiCode
    this.presentation = details.presentation
    this.requestId = details.requestId
    this.retryAfterMilliseconds = details.retryAfterMilliseconds
    this.status = details.status
  }
}

export function presentationForApiError(
  code: ApiErrorCode,
): ApiErrorPresentationCategory {
  return API_ERROR_PRESENTATION[code]
}
