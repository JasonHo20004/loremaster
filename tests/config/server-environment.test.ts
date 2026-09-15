import { describe, expect, it } from 'vitest'

import {
  ConfigurationError,
  parseServerEnvironment,
} from '../../packages/config/src/index.js'

const activeKey = Buffer.alloc(32, 0x11).toString('base64url')

function validEnvironment(
  overrides: Readonly<Record<string, string | undefined>> = {},
): Record<string, string | undefined> {
  return {
    LOREMASTER_API_MODE: 'local',
    DATABASE_URL: 'postgresql://runtime:secret@127.0.0.1/loremaster',
    LOREMASTER_API_ORIGIN: 'http://localhost:5173',
    LOREMASTER_API_CURSOR_ACTIVE_VERSION: 'key-2026-09',
    LOREMASTER_API_CURSOR_ACTIVE_KEY: activeKey,
    ...overrides,
  }
}

describe('server environment configuration', () => {
  it('parses the fixed local policy and explicit proxy networks', () => {
    const config = parseServerEnvironment(
      validEnvironment({
        LOREMASTER_API_TRUSTED_PROXIES: '127.0.0.1,10.20.0.0/16,2001:db8::/32',
        LOREMASTER_API_LIMITER_GUEST_CAPACITY: '5000',
        LOREMASTER_API_LIMITER_IP_CAPACITY: '6000',
      }),
    )

    expect(config).toMatchObject({
      mode: 'local',
      origin: 'http://localhost:5173',
      port: 3000,
      cookies: {
        session: {
          name: 'loremaster_local_session',
          secure: false,
          httpOnly: true,
          sameSite: 'lax',
          path: '/',
        },
        csrf: {
          name: 'loremaster_local_csrf',
          secure: false,
          httpOnly: false,
        },
      },
      timeouts: { commandMs: 5000, lockMs: 1000, statementMs: 3000 },
      limiter: {
        mutationsPerGuest: 30,
        mutationsPerIp: 120,
        autocompletePerGuest: 120,
        autocompletePerIp: 300,
        sessionCreationsPerIp: 10,
        guestCapacity: 5000,
        ipCapacity: 6000,
      },
      sessionAbsoluteTtlDays: 30,
    })
    expect(config.trustedProxies).toEqual([
      { address: '127.0.0.1', prefixLength: 32, version: 4 },
      { address: '10.20.0.0', prefixLength: 16, version: 4 },
      { address: '2001:db8::', prefixLength: 32, version: 6 },
    ])
    expect(Buffer.from(config.cursor.active.key)).toEqual(
      Buffer.alloc(32, 0x11),
    )
  })

  it('requires the exact secure production cookie and HTTPS origin policy', () => {
    const config = parseServerEnvironment(
      validEnvironment({
        LOREMASTER_API_MODE: 'production',
        LOREMASTER_API_ORIGIN: 'https://loremaster.example',
      }),
    )
    expect(config.cookies).toEqual({
      session: {
        name: '__Host-loremaster_session',
        secure: true,
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
      },
      csrf: {
        name: '__Host-loremaster_csrf',
        secure: true,
        httpOnly: false,
        sameSite: 'lax',
        path: '/',
      },
    })

    for (const overrides of [
      { LOREMASTER_API_ORIGIN: 'http://loremaster.example' },
      { LOREMASTER_API_SESSION_COOKIE_NAME: 'loremaster_local_session' },
      { LOREMASTER_API_CSRF_COOKIE_NAME: 'loremaster_local_csrf' },
    ]) {
      expect(() =>
        parseServerEnvironment(
          validEnvironment({
            LOREMASTER_API_MODE: 'production',
            LOREMASTER_API_ORIGIN: 'https://loremaster.example',
            ...overrides,
          }),
        ),
      ).toThrow(ConfigurationError)
    }
  })

  it('rejects ambiguous origins, proxy hop counts, unsafe timeouts, and unknown API variables', () => {
    const cases = [
      { LOREMASTER_API_ORIGIN: 'http://localhost:5173/path' },
      { LOREMASTER_API_TRUSTED_PROXIES: '1' },
      { LOREMASTER_API_TRUSTED_PROXIES: '10.0.0.0/33' },
      { LOREMASTER_API_TRUSTED_PROXIES: '127.0.0.1, 10.0.0.1' },
      { LOREMASTER_API_COMMAND_TIMEOUT_MS: '6000' },
      { LOREMASTER_API_UNKNOWN: 'true' },
    ]
    for (const overrides of cases) {
      expect(() => parseServerEnvironment(validEnvironment(overrides))).toThrow(
        ConfigurationError,
      )
    }
  })

  it('accepts one distinct previous cursor key and rejects partial, short, or reused keys', () => {
    const previousKey = Buffer.alloc(32, 0x22).toString('base64url')
    expect(
      parseServerEnvironment(
        validEnvironment({
          LOREMASTER_API_CURSOR_PREVIOUS_VERSION: 'key-2026-08',
          LOREMASTER_API_CURSOR_PREVIOUS_KEY: previousKey,
        }),
      ).cursor.previous,
    ).toMatchObject({ version: 'key-2026-08' })

    for (const overrides of [
      { LOREMASTER_API_CURSOR_PREVIOUS_VERSION: 'key-2026-08' },
      { LOREMASTER_API_CURSOR_PREVIOUS_KEY: previousKey },
      {
        LOREMASTER_API_CURSOR_PREVIOUS_VERSION: 'key-2026-09',
        LOREMASTER_API_CURSOR_PREVIOUS_KEY: previousKey,
      },
      {
        LOREMASTER_API_CURSOR_PREVIOUS_VERSION: 'key-2026-08',
        LOREMASTER_API_CURSOR_PREVIOUS_KEY: activeKey,
      },
      {
        LOREMASTER_API_CURSOR_ACTIVE_KEY:
          Buffer.alloc(31).toString('base64url'),
      },
    ]) {
      expect(() => parseServerEnvironment(validEnvironment(overrides))).toThrow(
        ConfigurationError,
      )
    }
  })

  it('rejects cursor key identifiers that cannot fit the public envelope', () => {
    expect(() =>
      parseServerEnvironment({
        ...validEnvironment(),
        LOREMASTER_API_CURSOR_ACTIVE_VERSION: 'a'.repeat(17),
      }),
    ).toThrowError(
      expect.objectContaining({
        fields: ['LOREMASTER_API_CURSOR_ACTIVE_VERSION'],
      }),
    )
  })

  it('reports field names without secret values', () => {
    const secret = 'not-valid-secret-material'
    expect.assertions(2)
    try {
      parseServerEnvironment(
        validEnvironment({ LOREMASTER_API_CURSOR_ACTIVE_KEY: secret }),
      )
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError)
      expect(String(error)).not.toContain(secret)
    }
  })
})
