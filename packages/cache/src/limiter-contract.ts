/** S7.1 vocabulary only. The atomic operation is implemented in S7.6. */
export const SHARED_LIMIT_POLICY = Object.freeze({
  windowMs: 60_000,
  maximumTtlSeconds: 61,
  maximumIdentityBytes: 128,
  maximumKeys: 20_000,
  session: Object.freeze({ ip: 10 }),
  autocomplete: Object.freeze({ ip: 300, guest: 120 }),
  mutation: Object.freeze({ ip: 120, guest: 30 }),
})

export type LimitCounter = 'session' | 'autocomplete' | 'mutation'
export type LimitIdentityScope = 'ip' | 'guest'

export interface SharedLimitRequest {
  readonly counter: LimitCounter
  /** SHA-256 HMAC hex digest; never raw addresses, guest IDs or cookies. */
  readonly ipDigest: string
  readonly guestDigest?: string
}

export type SharedLimitDecision =
  | { readonly state: 'allowed' | 'degraded'; readonly retryAfterSeconds: 0 }
  | { readonly state: 'denied'; readonly retryAfterSeconds: number }

/** Run after local admission, outside PostgreSQL; error yields degraded state. */
export interface SharedLimiter {
  consume(
    request: SharedLimitRequest,
    signal?: AbortSignal,
  ): Promise<SharedLimitDecision>
}

function invalid(): never {
  throw new Error('Invalid shared limiter contract')
}

/** Bucket is derived from Redis TIME in S7.6, never from a browser timestamp. */
export function sharedLimitKey(
  keyVersion: string,
  counter: LimitCounter,
  scope: LimitIdentityScope,
  digest: string,
  bucket: number,
): string {
  if (
    typeof keyVersion !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,15}$/u.test(keyVersion) ||
    !['session', 'autocomplete', 'mutation'].includes(counter) ||
    !['ip', 'guest'].includes(scope) ||
    (counter === 'session' && scope === 'guest') ||
    typeof digest !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(digest) ||
    !Number.isSafeInteger(bucket) ||
    bucket < 0
  )
    invalid()
  return `loremaster:v1:limit:${keyVersion}:${bucket}:${counter}:${scope}:${digest}`
}

export function parseSharedLimitDecision(value: unknown): SharedLimitDecision {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    invalid()
  const keys = Reflect.ownKeys(value)
  if (keys.length !== 2) invalid()
  const stateDescriptor = Object.getOwnPropertyDescriptor(value, 'state')
  const retryDescriptor = Object.getOwnPropertyDescriptor(
    value,
    'retryAfterSeconds',
  )
  if (
    !stateDescriptor ||
    !retryDescriptor ||
    !('value' in stateDescriptor) ||
    !('value' in retryDescriptor)
  )
    invalid()
  const state: unknown = stateDescriptor.value
  const retryAfterSeconds: unknown = retryDescriptor.value
  if (
    state === 'denied' &&
    typeof retryAfterSeconds === 'number' &&
    Number.isInteger(retryAfterSeconds) &&
    retryAfterSeconds >= 1 &&
    retryAfterSeconds <= 60
  ) {
    return Object.freeze({ state, retryAfterSeconds })
  }
  if (
    (state === 'allowed' || state === 'degraded') &&
    retryAfterSeconds === 0
  ) {
    return Object.freeze({ state, retryAfterSeconds })
  }
  return invalid()
}
