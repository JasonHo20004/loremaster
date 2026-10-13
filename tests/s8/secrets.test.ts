import {
  chmodSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspect } from 'node:util'
import { describe, expect, it } from 'vitest'

import { parseServerEnvironment } from '../../packages/config/src/index.js'
import {
  parseApiRedisConfiguration,
  parseObserverConfiguration,
  parseWorkerConfiguration,
} from '../../packages/config/src/redis.js'
import { secretFiles } from './secret-fixtures.js'

const cursorKey = Buffer.alloc(32, 0x41).toString('base64url')
const limiterKey = Buffer.alloc(32, 0x42).toString('base64url')
const databaseUrl = 'postgresql://runtime:private-password@localhost/loremaster'

function apiEnvironment(overrides: Record<string, string | undefined> = {}) {
  return {
    LOREMASTER_API_MODE: 'local',
    LOREMASTER_API_ORIGIN: 'http://localhost:8080',
    LOREMASTER_API_CURSOR_ACTIVE_VERSION: 'v1',
    ...overrides,
  }
}

describe('S8 file-backed secret boundary', () => {
  it('reads API secrets once without serializing their contents', () => {
    const files = secretFiles({
      DATABASE_URL: databaseUrl,
      LOREMASTER_API_CURSOR_ACTIVE_KEY: cursorKey,
    })
    try {
      const environment = apiEnvironment(files.environment)
      const config = parseServerEnvironment(environment)
      expect(config.databaseUrl).toBe(databaseUrl)
      expect(Buffer.from(config.cursor.active.key)).toEqual(
        Buffer.alloc(32, 0x41),
      )
      expect(JSON.stringify(environment)).not.toContain('private-password')
      expect(JSON.stringify(config)).not.toContain('private-password')
      expect(inspect(config)).not.toContain('private-password')
      expect(JSON.stringify(config)).not.toContain(cursorKey)
      files.cleanup()
      expect(config.databaseUrl).toBe(databaseUrl)
    } finally {
      files.cleanup()
    }
  })

  it('rejects simultaneous direct and file values, unknown keys, and invalid content', () => {
    const files = secretFiles({
      DATABASE_URL: databaseUrl,
      LOREMASTER_API_CURSOR_ACTIVE_KEY: cursorKey,
    })
    try {
      expect(() =>
        parseServerEnvironment(
          apiEnvironment({
            ...files.environment,
            DATABASE_URL: databaseUrl,
          }),
        ),
      ).toThrow('DATABASE_URL_FILE')
      expect(() =>
        parseServerEnvironment(
          apiEnvironment({
            ...files.environment,
            LOREMASTER_API_CURSOR_ACTIVE_KEY_FILE_EXTRA: 'ignored',
          }),
        ),
      ).toThrow('LOREMASTER_API_CURSOR_ACTIVE_KEY_FILE_EXTRA')
      for (const content of [
        '',
        `${databaseUrl}\n`,
        `x\0y`,
        'x'.repeat(4097),
      ]) {
        const invalid = join(files.directory, `invalid-${content.length}`)
        writeFileSync(invalid, content, { mode: 0o400 })
        chmodSync(invalid, 0o400)
        expect(() =>
          parseServerEnvironment(
            apiEnvironment({
              ...files.environment,
              DATABASE_URL_FILE: invalid,
            }),
          ),
        ).toThrow('DATABASE_URL_FILE')
      }
    } finally {
      files.cleanup()
    }
  })

  it('loads separate Redis credentials and hides them from object serialization', () => {
    const files = secretFiles({
      LOREMASTER_REDIS_CACHE_URL:
        'redis://loremaster_api_cache:cache-private@localhost',
      LOREMASTER_REDIS_LIMITER_URL:
        'redis://loremaster_api_limiter:limiter-private@localhost',
      LOREMASTER_REDIS_PRODUCER_URL:
        'redis://loremaster_producer:producer-private@localhost',
      LOREMASTER_REDIS_PRODUCER_DATABASE_URL:
        'postgresql://producer:database-private@localhost/loremaster',
      LOREMASTER_REDIS_LIMITER_HMAC_KEY: limiterKey,
      LOREMASTER_WORKER_REDIS_URL:
        'redis://loremaster_worker:worker-private@localhost',
      LOREMASTER_WORKER_CACHE_REDIS_URL:
        'redis://loremaster_worker_cache:cache-private@localhost',
      LOREMASTER_WORKER_DATABASE_URL:
        'postgresql://worker:database-private@localhost/loremaster',
      LOREMASTER_OBSERVER_REDIS_URL:
        'redis://loremaster_observer:observer-private@localhost',
    })
    try {
      const forPrefix = (prefix: string) =>
        Object.fromEntries(
          Object.entries(files.environment).filter(([key]) =>
            key.startsWith(prefix),
          ),
        )
      const apiEnvironment = {
        LOREMASTER_REDIS_ENABLED: 'true',
        LOREMASTER_REDIS_LIMITER_HMAC_VERSION: 'v1',
        ...forPrefix('LOREMASTER_REDIS_'),
      }
      const api = parseApiRedisConfiguration({
        ...apiEnvironment,
      })
      expect(api.enabled).toBe(true)
      expect(JSON.stringify(api)).not.toContain('private')
      expect(inspect(api)).not.toContain('private')
      const worker = parseWorkerConfiguration(forPrefix('LOREMASTER_WORKER_'))
      const observer = parseObserverConfiguration(
        forPrefix('LOREMASTER_OBSERVER_'),
      )
      expect(JSON.stringify(worker)).not.toContain('private')
      expect(JSON.stringify(observer)).not.toContain('private')
      expect(() =>
        parseApiRedisConfiguration(apiEnvironment, [
          Buffer.from(limiterKey, 'base64url'),
        ]),
      ).toThrow('LOREMASTER_REDIS_LIMITER_HMAC_KEY')
    } finally {
      files.cleanup()
    }
  })

  it('rejects symlinks and writable modes on Linux', () => {
    if (process.platform === 'win32') return
    const directory = mkdtempSync(join(tmpdir(), 'loremaster-s8-invalid-'))
    try {
      const target = join(directory, 'target')
      const link = join(directory, 'link')
      writeFileSync(target, databaseUrl, { mode: 0o400 })
      symlinkSync(target, link)
      expect(() =>
        parseServerEnvironment(
          apiEnvironment({
            DATABASE_URL_FILE: link,
            LOREMASTER_API_CURSOR_ACTIVE_KEY: cursorKey,
          }),
        ),
      ).toThrow('DATABASE_URL_FILE')
      chmodSync(target, 0o600)
      expect(() =>
        parseServerEnvironment(
          apiEnvironment({
            DATABASE_URL_FILE: target,
            LOREMASTER_API_CURSOR_ACTIVE_KEY: cursorKey,
          }),
        ),
      ).toThrow('DATABASE_URL_FILE')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
