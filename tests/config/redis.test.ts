import { expect, it } from 'vitest'
import {
  parseApiRedisConfiguration,
  parseWorkerConfiguration,
  parseObserverConfiguration,
} from '../../packages/config/src/redis.js'
it('defaults API to disabled and requires explicit role credentials when enabled', () => {
  expect(parseApiRedisConfiguration({})).toEqual({ enabled: false })
  expect(() =>
    parseApiRedisConfiguration({ LOREMASTER_REDIS_ENABLED: 'true' }),
  ).toThrow()
})
it('redacts invalid Redis credentials and rejects production plaintext', () => {
  expect(() =>
    parseObserverConfiguration({
      LOREMASTER_REDIS_MODE: 'production',
      LOREMASTER_OBSERVER_REDIS_URL: 'redis://user:secret@localhost',
    }),
  ).toThrow('LOREMASTER_OBSERVER_REDIS_URL')
  try {
    parseObserverConfiguration({ LOREMASTER_OBSERVER_REDIS_URL: 'secret' })
  } catch (error) {
    expect(String(error)).not.toContain('secret')
  }
})
it('freezes private health ports and bounds worker concurrency', () => {
  const env = {
    LOREMASTER_WORKER_REDIS_URL: 'redis://loremaster_worker:pass@localhost',
    LOREMASTER_WORKER_CACHE_REDIS_URL:
      'redis://loremaster_worker_cache:pass@localhost',
    LOREMASTER_WORKER_DATABASE_URL: 'postgresql://worker:pass@localhost/db',
  }
  expect(parseWorkerConfiguration(env)).toMatchObject({
    healthHost: '127.0.0.1',
    healthPort: 3001,
    concurrency: 2,
  })
  expect(() =>
    parseWorkerConfiguration({
      ...env,
      LOREMASTER_WORKER_CONCURRENCY: '10000',
    }),
  ).toThrow()
  expect(
    parseObserverConfiguration({
      LOREMASTER_OBSERVER_REDIS_URL:
        'redis://loremaster_observer:pass@localhost',
    }),
  ).toMatchObject({ healthHost: '127.0.0.1', healthPort: 3002 })
})
const validApi = {
  LOREMASTER_REDIS_ENABLED: 'true',
  LOREMASTER_REDIS_CACHE_URL:
    'rediss://loremaster_api_cache:password@localhost',
  LOREMASTER_REDIS_LIMITER_URL:
    'rediss://loremaster_api_limiter:password@localhost',
  LOREMASTER_REDIS_PRODUCER_URL:
    'rediss://loremaster_producer:password@localhost',
  LOREMASTER_REDIS_PRODUCER_DATABASE_URL:
    'postgresql://producer:password@localhost/db',
  LOREMASTER_REDIS_LIMITER_HMAC_KEY: Buffer.alloc(32, 17).toString('base64url'),
  LOREMASTER_REDIS_LIMITER_HMAC_VERSION: 'v1',
}
it('accepts explicitly separated API profiles and key material', () => {
  expect(
    parseApiRedisConfiguration({
      ...validApi,
      LOREMASTER_REDIS_MODE: 'production',
    }),
  ).toMatchObject({
    enabled: true,
    limiterHmacVersion: 'v1',
    limiterHmacKey: new Uint8Array(Buffer.alloc(32, 17)),
  })
})
it.each([
  { LOREMASTER_REDIS_UNKNOWN: 'value' },
  { LOREMASTER_REDIS_ENABLED: 'yes' },
  { LOREMASTER_REDIS_ENABLED: 'false' },
  { LOREMASTER_REDIS_MODE: 'other' },
  { LOREMASTER_REDIS_MODE: 'local', LOREMASTER_API_MODE: 'production' },
  { LOREMASTER_REDIS_CACHE_URL: 'http://cache:password@localhost' },
  { LOREMASTER_REDIS_CACHE_URL: 'rediss://cache:password@localhost/1' },
  {
    LOREMASTER_REDIS_CACHE_URL:
      'rediss://cache:password@localhost?password=secret',
  },
  { LOREMASTER_REDIS_CACHE_URL: 'rediss://cache:password@localhost#secret' },
  { LOREMASTER_REDIS_CACHE_URL: 'rediss://limiter:password@localhost' },
  { LOREMASTER_REDIS_CACHE_URL: 'rediss://localhost' },
  { LOREMASTER_REDIS_LIMITER_HMAC_KEY: 'short' },
  { LOREMASTER_REDIS_LIMITER_HMAC_KEY: '='.repeat(44) },
  { LOREMASTER_REDIS_LIMITER_HMAC_VERSION: '../secret' },
  {
    LOREMASTER_API_CURSOR_ACTIVE_KEY:
      validApi.LOREMASTER_REDIS_LIMITER_HMAC_KEY,
  },
  { LOREMASTER_REDIS_CACHE_URL: 'redis://cache:pass@local\nhost' },
  { LOREMASTER_REDIS_CACHE_URL: 'redis://cache:pass@localhost:0' },
  { LOREMASTER_REDIS_CACHE_URL: 'redis://cache:%zz@localhost' },
  { LOREMASTER_REDIS_CACHE_URL: 'redis://cache:%00@localhost' },
])('rejects invalid API configuration without exposing values', (overrides) => {
  expect(() =>
    parseApiRedisConfiguration({ ...validApi, ...overrides }),
  ).toThrow('Invalid Redis configuration')
})
it.each([
  'redis://observer:password@localhost',
  'rediss://localhost',
  'rediss://observer@localhost',
])('requires authenticated TLS in production', (url) => {
  expect(() =>
    parseObserverConfiguration({
      LOREMASTER_REDIS_MODE: 'production',
      LOREMASTER_OBSERVER_REDIS_URL: url,
    }),
  ).toThrow()
})
it('rejects unknown observer fields and malformed worker DB configuration', () => {
  expect(() =>
    parseObserverConfiguration({ LOREMASTER_OBSERVER_OTHER: '1' }),
  ).toThrow()
  expect(() =>
    parseWorkerConfiguration({
      LOREMASTER_WORKER_REDIS_URL: 'redis://worker:pass@localhost',
      LOREMASTER_WORKER_CACHE_REDIS_URL: 'redis://cache:pass@localhost',
      LOREMASTER_WORKER_DATABASE_URL: 'https://user:secret@localhost/db',
    }),
  ).toThrow()
  expect(() =>
    parseWorkerConfiguration({
      LOREMASTER_WORKER_REDIS_URL: 'redis://worker:pass@localhost',
      LOREMASTER_WORKER_CACHE_REDIS_URL: 'redis://worker:pass@localhost',
      LOREMASTER_WORKER_DATABASE_URL: 'postgresql://user:secret@localhost/db',
    }),
  ).toThrow()
})
