import { describe, expect, it } from 'vitest'

import { parseApiBaseUrl } from '../../apps/web/src/public-config'

describe('public browser configuration', () => {
  it('accepts the same-origin base path and secure absolute API base', () => {
    expect(parseApiBaseUrl('/api/v1', 'http://localhost:5173').href).toBe(
      'http://localhost:5173/api/v1',
    )
    expect(
      parseApiBaseUrl(
        'https://api.example.test/api/v1',
        'https://game.example.test',
      ).href,
    ).toBe('https://api.example.test/api/v1')
  })

  it.each([
    '',
    ' /api/v1',
    '/api/v1/',
    '/api/v1?token=secret',
    'http://example.test/api/v1',
    'https://user:pass@example.test/api/v1',
    'javascript:alert(1)',
  ])('rejects unsafe or ambiguous API base %j', (candidate) => {
    expect(() => parseApiBaseUrl(candidate, 'http://localhost:5173')).toThrow(
      'VITE_API_BASE_URL is invalid',
    )
  })
})
