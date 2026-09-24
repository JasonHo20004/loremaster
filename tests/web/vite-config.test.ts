import { describe, expect, it } from 'vitest'

import { parseProxyTarget } from '../../apps/web/vite.config'

describe('local API proxy configuration', () => {
  it.each([
    [undefined, 'http://127.0.0.1:3000'],
    ['http://localhost:3000', 'http://localhost:3000'],
    ['http://[::1]:3000', 'http://[::1]:3000'],
  ])('accepts exact loopback origin %j', (candidate, expected) => {
    expect(parseProxyTarget(candidate)).toBe(expected)
  })

  it.each([
    'https://localhost:3000',
    'http://example.test:3000',
    'http://localhost:3000/api',
    'http://user:pass@localhost:3000',
    'http://localhost:3000?token=secret',
  ])('rejects unsafe or ambiguous proxy target %j', (candidate) => {
    expect(() => parseProxyTarget(candidate)).toThrow(
      'LOREMASTER_API_PROXY_TARGET must be an exact loopback HTTP origin',
    )
  })
})
