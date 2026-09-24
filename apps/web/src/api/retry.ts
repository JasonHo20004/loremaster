import {
  API_OPERATIONS,
  API_RETRY_POLICY,
  type ApiErrorCode,
  type ApiOperationId,
} from '@loremaster/contracts'

import type { ApiClientError } from './errors.js'

export type RetryDirective =
  | { readonly kind: 'DO_NOT_RETRY' }
  | { readonly delayMilliseconds: number; readonly kind: 'AUTOMATIC_RETRY' }
  | {
      readonly delayMilliseconds: number
      readonly kind: 'REPLAY_EXACT_MUTATION'
    }
  | { readonly kind: 'REFRESH_THEN_NEW_COMMAND' }
  | { readonly kind: 'USE_NEW_COMMAND_KEY' }

const INITIAL_BACKOFF_MILLISECONDS = 500
const MAXIMUM_BACKOFF_MILLISECONDS = 8_000

function backoffMilliseconds(attempt: number): number {
  const safeAttempt = Math.max(0, Math.min(attempt, 10))
  return Math.min(
    INITIAL_BACKOFF_MILLISECONDS * 2 ** safeAttempt,
    MAXIMUM_BACKOFF_MILLISECONDS,
  )
}

function policyAction(
  operationId: ApiOperationId,
  code: ApiErrorCode,
): string | undefined {
  const operation = API_OPERATIONS[operationId]
  if (operation.auth === 'GAMEPLAY_MUTATION') {
    const policy = API_RETRY_POLICY.gameplayMutation as Readonly<
      Partial<Record<ApiErrorCode, string>>
    >
    return policy[code]
  }
  if (operation.auth === 'BOOTSTRAP') {
    const policy = API_RETRY_POLICY.sessionBootstrap as Readonly<
      Partial<Record<ApiErrorCode, string>>
    >
    return policy[code]
  }
  const policy = API_RETRY_POLICY.read as Readonly<
    Partial<Record<ApiErrorCode, string>>
  >
  return policy[code]
}

export function retryDirective(
  operationId: ApiOperationId,
  error: ApiClientError,
  attempt = 0,
): RetryDirective {
  const operation = API_OPERATIONS[operationId]
  const isMutation = operation.auth === 'GAMEPLAY_MUTATION'

  if (
    error.kind === 'NETWORK_ERROR' ||
    error.kind === 'MALFORMED_RESPONSE' ||
    error.kind === 'CANCELLED'
  ) {
    if (isMutation) {
      return { kind: 'REPLAY_EXACT_MUTATION', delayMilliseconds: 0 }
    }
    return error.kind === 'CANCELLED'
      ? { kind: 'DO_NOT_RETRY' }
      : {
          kind: 'AUTOMATIC_RETRY',
          delayMilliseconds: backoffMilliseconds(attempt),
        }
  }

  if (error.kind === 'RATE_LIMITED') {
    const delayMilliseconds = error.retryAfterMilliseconds ?? 0
    return isMutation
      ? { kind: 'REPLAY_EXACT_MUTATION', delayMilliseconds }
      : { kind: 'AUTOMATIC_RETRY', delayMilliseconds }
  }

  if (error.kind !== 'API_ERROR' || error.apiCode === undefined) {
    return { kind: 'DO_NOT_RETRY' }
  }

  const action = policyAction(operationId, error.apiCode)
  switch (action) {
    case 'SAME_IDEMPOTENCY_KEY_ONLY':
      return { kind: 'REPLAY_EXACT_MUTATION', delayMilliseconds: 0 }
    case 'AFTER_RETRY_AFTER_WITH_SAME_IDEMPOTENCY_KEY':
      return {
        kind: 'REPLAY_EXACT_MUTATION',
        delayMilliseconds: error.retryAfterMilliseconds ?? 0,
      }
    case 'AFTER_RETRY_AFTER':
      return {
        kind: 'AUTOMATIC_RETRY',
        delayMilliseconds: error.retryAfterMilliseconds ?? 0,
      }
    case 'AFTER_BACKOFF':
      return {
        kind: 'AUTOMATIC_RETRY',
        delayMilliseconds: backoffMilliseconds(attempt),
      }
    case 'AFTER_REFRESH_WITH_NEW_COMMAND_KEY':
      return { kind: 'REFRESH_THEN_NEW_COMMAND' }
    case 'NEW_VALID_COMMAND_KEY':
      return { kind: 'USE_NEW_COMMAND_KEY' }
    default:
      return { kind: 'DO_NOT_RETRY' }
  }
}
