import { describe, expect, it } from 'vitest'

import {
  SHARED_LIMIT_POLICY,
  sharedLimitKey,
  parseSharedLimitDecision,
} from '../../packages/cache/src/limiter-contract.js'

describe('shared limiter contract', () => {
  it('bounds version, counter, scope, window and pseudonym inputs', () => {
    const digest = 'a'.repeat(64)
    expect(sharedLimitKey('key-v1', 'autocomplete', 'guest', digest, 42)).toBe(
      `loremaster:v1:limit:key-v1:42:autocomplete:guest:${digest}`,
    )
    for (const value of ['cookie', digest.toUpperCase(), '../secret', '']) {
      expect(() => sharedLimitKey('v1', 'session', 'ip', value, 42)).toThrow()
    }
    expect(() =>
      sharedLimitKey('bad:key', 'session', 'ip', digest, 42),
    ).toThrow()
    expect(() => sharedLimitKey('v1', 'session', 'ip', digest, -1)).toThrow()
    expect(() =>
      sharedLimitKey('v1', 'session', 'ip', digest, Infinity),
    ).toThrow()
    expect(() => sharedLimitKey('v1', 'session', 'guest', digest, 42)).toThrow()
  })

  it('preserves the existing ceilings and requires a finite TTL', () => {
    expect(SHARED_LIMIT_POLICY).toMatchObject({
      windowMs: 60_000,
      maximumTtlSeconds: 61,
      maximumIdentityBytes: 128,
      maximumKeys: 20_000,
      session: { ip: 10 },
      autocomplete: { ip: 300, guest: 120 },
      mutation: { ip: 120, guest: 30 },
    })
    expect(Object.isFrozen(SHARED_LIMIT_POLICY.autocomplete)).toBe(true)
  })

  it('accepts only bounded aggregate decisions without diagnostic content', () => {
    expect(
      parseSharedLimitDecision({ state: 'denied', retryAfterSeconds: 60 }),
    ).toEqual({ state: 'denied', retryAfterSeconds: 60 })
    for (const value of [
      null,
      { state: 'denied', retryAfterSeconds: 0 },
      { state: 'denied', retryAfterSeconds: 61 },
      { state: 'allowed', retryAfterSeconds: 1 },
      { state: 'degraded', retryAfterSeconds: 0, error: 'redis://secret' },
    ]) {
      expect(() => parseSharedLimitDecision(value)).toThrow(
        'Invalid shared limiter contract',
      )
    }
  })
})
