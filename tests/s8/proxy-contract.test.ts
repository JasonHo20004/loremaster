import { readFileSync } from 'node:fs'
import type { Request } from 'express'
import { describe, expect, it } from 'vitest'

import { createSourceIpResolver } from '../../apps/api/src/security/source-ip.js'
import { parseServerEnvironment } from '../../packages/config/src/index.js'
import { secretFiles } from './secret-fixtures.js'

const edge = JSON.parse(
  readFileSync(
    new URL('../../ops/s8/local-edge.json', import.meta.url),
    'utf8',
  ),
)

function request(peer: string, forwarded?: string, repeated = false): Request {
  return {
    socket: { remoteAddress: peer },
    headers: forwarded === undefined ? {} : { 'x-forwarded-for': forwarded },
    rawHeaders:
      forwarded === undefined
        ? []
        : repeated
          ? ['X-Forwarded-For', forwarded, 'x-forwarded-for', forwarded]
          : ['X-Forwarded-For', forwarded],
  } as unknown as Request
}

describe('S8 local edge contract', () => {
  it('fixes the single gateway trust address and local browser policy', () => {
    expect(edge).toMatchObject({
      origin: 'http://localhost:8080',
      apiMode: 'local',
      hostBinding: '127.0.0.1:8080',
      edgeMembers: ['web', 'api'],
      trustedProxy: `${edge.gatewayIp}/32`,
      privatePorts: { api: 3000, worker: 3001, observer: 3002 },
      cookies: {
        session: 'loremaster_local_session',
        csrf: 'loremaster_local_csrf',
      },
    })
    expect(edge.proxyHeaders).toMatchObject({
      strategy: 'drop-all-then-allowlist',
      preserveOriginBytes: true,
      reconstruct: { 'X-Forwarded-For': 'direct-client-address' },
      apiPrefix: '/api/',
    })
    expect(edge.proxyHeaders.forward).not.toContain('X-Forwarded-For')
    const configuration = parseServerEnvironment({
      LOREMASTER_API_MODE: edge.apiMode,
      DATABASE_URL: 'postgresql://runtime:secret@database/loremaster',
      LOREMASTER_API_ORIGIN: edge.origin,
      LOREMASTER_API_TRUSTED_PROXIES: edge.trustedProxy,
      LOREMASTER_API_CURSOR_ACTIVE_VERSION: 'local-v1',
      LOREMASTER_API_CURSOR_ACTIVE_KEY: Buffer.alloc(32, 0x41).toString(
        'base64url',
      ),
    })
    expect(configuration.trustedProxies).toEqual([
      { address: edge.gatewayIp, prefixLength: 32, version: 4 },
    ])
    expect(configuration.cookies.session.name).toBe(edge.cookies.session)
    expect(configuration.cookies.csrf.name).toBe(edge.cookies.csrf)
    const files = secretFiles({
      DATABASE_URL: 'postgresql://runtime:secret@database/loremaster',
      LOREMASTER_API_CURSOR_ACTIVE_KEY: Buffer.alloc(32, 0x41).toString(
        'base64url',
      ),
    })
    try {
      const production = {
        ...files.environment,
        LOREMASTER_API_MODE: 'production',
        LOREMASTER_API_CURSOR_ACTIVE_VERSION: 'local-v1',
      }
      expect(() =>
        parseServerEnvironment({
          ...production,
          LOREMASTER_API_ORIGIN: edge.origin,
        }),
      ).toThrow('LOREMASTER_API_ORIGIN')
      expect(() =>
        parseServerEnvironment({
          ...production,
          LOREMASTER_API_ORIGIN: 'https://loremaster.example',
          LOREMASTER_API_SESSION_COOKIE_NAME: edge.cookies.session,
          LOREMASTER_API_CSRF_COOKIE_NAME: edge.cookies.csrf,
        }),
      ).toThrow('LOREMASTER_API_SESSION_COOKIE_NAME')
    } finally {
      files.cleanup()
    }
  })

  it('accepts distinct clients only through the exact gateway and rejects spoofing', () => {
    const resolver = createSourceIpResolver([
      { address: edge.gatewayIp, prefixLength: 32, version: 4 },
    ])
    expect(resolver.sourceIpFor(request(edge.gatewayIp, '198.51.100.1'))).toBe(
      '198.51.100.1',
    )
    expect(resolver.sourceIpFor(request(edge.gatewayIp, '198.51.100.2'))).toBe(
      '198.51.100.2',
    )
    expect(
      resolver.sourceIpFor(
        request(edge.gatewayIp, '203.0.113.9, 198.51.100.1'),
      ),
    ).toBe('198.51.100.1')
    expect(() =>
      resolver.sourceIpFor(request(edge.apiIp, '198.51.100.1')),
    ).toThrow()
    expect(() =>
      resolver.sourceIpFor(request(edge.gatewayIp, '198.51.100.1', true)),
    ).toThrow()
  })
})
