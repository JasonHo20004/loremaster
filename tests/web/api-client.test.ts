import {
  API_ERROR_CODES,
  API_ERROR_STATUS,
  type ApiErrorCode,
  type ApiOperationId,
} from '../../packages/contracts/src/index.js'
import { describe, expect, it, vi } from 'vitest'

import {
  ApiClient,
  ApiClientError,
  csrfCookieName,
  presentationForApiError,
  retryDirective,
  type ApiClientEvent,
} from '../../apps/web/src/api/index.js'
import { SessionBootstrap } from '../../apps/web/src/session/index.js'

const API_BASE_URL = new URL('http://localhost:5173/api/v1')
const BROWSER_ORIGIN = 'http://localhost:5173'
const REQUEST_ID = '00000000-0000-4000-8000-000000000099'
const ATTEMPT_ID = '00000000-0000-4000-8000-000000000001'
const CSRF_TOKEN = 'A'.repeat(43)
const IDEMPOTENCY_KEY = 'logical-start-key'
const SESSION_RESPONSE = {
  data: { expiresAt: '2030-01-01T00:00:00.000Z' },
} as const

function jsonResponse(
  body: unknown,
  status = 200,
  headers?: HeadersInit,
): Response {
  return Response.json(body, { status, headers })
}

function publicError(code: ApiErrorCode): unknown {
  return { error: { code, requestId: REQUEST_ID } }
}

function client(
  fetchImplementation: typeof fetch,
  options: {
    readonly cookieSource?: () => string
    readonly observe?: (event: ApiClientEvent) => void
    readonly sleep?: (milliseconds: number) => Promise<void>
  } = {},
): ApiClient {
  return new ApiClient({
    apiBaseUrl: API_BASE_URL,
    browserOrigin: BROWSER_ORIGIN,
    fetchImplementation,
    cookieSource: options.cookieSource ?? (() => ''),
    observe: options.observe,
    sleep: options.sleep,
  })
}

describe('contract-driven API client', () => {
  it('sends credentialed reads and returns only schema-validated data', async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init).toMatchObject({ method: 'GET', credentials: 'include' })
      expect(new Headers(init?.headers)).toEqual(new Headers())
      return jsonResponse({ data: { view: 'NO_CASE' } })
    })

    await expect(
      client(fetchImplementation).request('getCurrentCase', {}),
    ).resolves.toEqual({ data: { view: 'NO_CASE' } })
    expect(fetchImplementation).toHaveBeenCalledWith(
      new URL('http://localhost:5173/api/v1/cases/current'),
      expect.any(Object),
    )
  })

  it('constructs validated path parameters and normalized queries centrally', async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async (input) => {
      expect(String(input)).toBe(
        `http://localhost:5173/api/v1/attempts/${ATTEMPT_ID}/suggestions?q=harbor`,
      )
      return jsonResponse({ data: { items: [] } })
    })

    await client(fetchImplementation).request('getSuggestions', {
      path: { attemptId: ATTEMPT_ID },
      query: { q: '  harbor  ' },
    })
  })

  it('reads only the mode-appropriate CSRF cookie for a mutation', async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async (_input, init) => {
      const headers = new Headers(init?.headers)
      expect(headers.get('Content-Type')).toBe('application/json')
      expect(headers.get('X-CSRF-Token')).toBe(CSRF_TOKEN)
      expect(headers.get('Idempotency-Key')).toBe(IDEMPOTENCY_KEY)
      expect(init?.body).toBe('{}')
      return jsonResponse(publicError('SERVICE_UNAVAILABLE'), 503)
    })
    const api = client(fetchImplementation, {
      cookieSource: () =>
        `unrelated=value; loremaster_local_csrf=${CSRF_TOKEN}`,
    })

    await expect(
      api.request('startCurrentAttempt', {
        body: {},
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
    ).rejects.toMatchObject({
      kind: 'API_ERROR',
      apiCode: 'SERVICE_UNAVAILABLE',
      requestId: REQUEST_ID,
    })
    expect(csrfCookieName(new URL('https://game.example/api/v1'))).toBe(
      '__Host-loremaster_csrf',
    )
  })

  it('rejects missing, repeated, and malformed CSRF cookie values before fetch', async () => {
    const fetchImplementation = vi.fn<typeof fetch>()
    for (const cookie of [
      '',
      'loremaster_local_csrf=short',
      `loremaster_local_csrf=${CSRF_TOKEN}; loremaster_local_csrf=${CSRF_TOKEN}`,
    ]) {
      await expect(
        client(fetchImplementation, { cookieSource: () => cookie }).request(
          'startCurrentAttempt',
          { body: {}, idempotencyKey: IDEMPOTENCY_KEY },
        ),
      ).rejects.toMatchObject({ kind: 'SESSION_SECURITY' })
    }
    expect(fetchImplementation).not.toHaveBeenCalled()
  })

  it('maps cancellation and network failures without exposing exception text', async () => {
    const secret = 'browser-secret-detail'
    const networkClient = client(
      vi.fn<typeof fetch>(async () => {
        throw new Error(secret)
      }),
    )
    const networkError = await networkClient
      .request('getSession', {})
      .catch((error: unknown) => error)
    expect(networkError).toMatchObject({ kind: 'NETWORK_ERROR' })
    expect(String(networkError)).not.toContain(secret)

    const controller = new AbortController()
    controller.abort()
    const cancelledError = await client(
      vi.fn<typeof fetch>(async () => {
        throw new DOMException('secret abort reason', 'AbortError')
      }),
    )
      .request('getSession', { signal: controller.signal })
      .catch((error: unknown) => error)
    expect(cancelledError).toMatchObject({ kind: 'CANCELLED' })
    expect(String(cancelledError)).not.toContain('secret abort reason')
  })

  it('rejects malformed success and error responses', async () => {
    const malformedSuccess = client(
      vi.fn<typeof fetch>(async () =>
        jsonResponse({ data: { expiresAt: 'not-a-time' } }),
      ),
    )
    await expect(
      malformedSuccess.request('getSession', {}),
    ).rejects.toMatchObject({ kind: 'MALFORMED_RESPONSE', status: 200 })

    const mismatchedError = client(
      vi.fn<typeof fetch>(async () =>
        jsonResponse(publicError('REQUEST_FORBIDDEN'), 401),
      ),
    )
    await expect(
      mismatchedError.request('getSession', {}),
    ).rejects.toMatchObject({ kind: 'MALFORMED_RESPONSE', status: 401 })

    const nonJson = client(
      vi.fn<typeof fetch>(
        async () =>
          new Response('<html>private detail</html>', {
            status: 500,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
    )
    await expect(nonJson.request('getSession', {})).rejects.toMatchObject({
      kind: 'MALFORMED_RESPONSE',
    })
  })

  it('validates 429 Retry-After and exposes delay metadata', async () => {
    const rateLimited = client(
      vi.fn<typeof fetch>(async () =>
        jsonResponse(publicError('RATE_LIMITED'), 429, {
          'Retry-After': '17',
        }),
      ),
    )
    const error = await rateLimited
      .request('getSuggestions', {
        path: { attemptId: ATTEMPT_ID },
        query: { q: 'harbor' },
      })
      .catch((failure: unknown) => failure)
    expect(error).toMatchObject({
      kind: 'RATE_LIMITED',
      retryAfterMilliseconds: 17_000,
      requestId: REQUEST_ID,
    })

    const missingHeader = client(
      vi.fn<typeof fetch>(async () =>
        jsonResponse(publicError('RATE_LIMITED'), 429),
      ),
    )
    await expect(
      missingHeader.request('getSuggestions', {
        path: { attemptId: ATTEMPT_ID },
        query: { q: 'harbor' },
      }),
    ).rejects.toMatchObject({ kind: 'MALFORMED_RESPONSE' })
  })

  it('retries reads with policy backoff but refuses mutation auto-retry', async () => {
    const delays: number[] = []
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(publicError('SERVICE_UNAVAILABLE'), 503),
      )
      .mockResolvedValueOnce(jsonResponse(SESSION_RESPONSE))
    const api = client(fetchImplementation, {
      sleep: async (milliseconds) => {
        delays.push(milliseconds)
      },
    })

    await expect(api.requestReadWithRetry('getSession', {})).resolves.toEqual(
      SESSION_RESPONSE,
    )
    expect(delays).toEqual([500])
    expect(fetchImplementation).toHaveBeenCalledTimes(2)

    const unsafeRead = api.requestReadWithRetry.bind(api) as unknown as (
      operationId: ApiOperationId,
      request: Readonly<Record<string, unknown>>,
    ) => Promise<unknown>
    await expect(
      unsafeRead('createSession', { body: {} }),
    ).rejects.toMatchObject({ kind: 'INVALID_CLIENT_REQUEST' })
    expect(fetchImplementation).toHaveBeenCalledTimes(2)
  })

  it('never includes request bodies, cookies, or exception details in observations', async () => {
    const events: ApiClientEvent[] = []
    const api = client(
      vi.fn<typeof fetch>(async () =>
        jsonResponse(publicError('SERVICE_UNAVAILABLE'), 503),
      ),
      {
        cookieSource: () => `loremaster_local_csrf=${CSRF_TOKEN}`,
        observe: (event) => events.push(event),
      },
    )
    await api
      .request('startCurrentAttempt', {
        body: {},
        idempotencyKey: IDEMPOTENCY_KEY,
      })
      .catch(() => undefined)

    expect(events).toEqual([
      {
        operationId: 'startCurrentAttempt',
        outcome: 'API_ERROR',
        requestId: REQUEST_ID,
        status: 503,
      },
    ])
    const serialized = JSON.stringify(events)
    expect(serialized).not.toContain(CSRF_TOKEN)
    expect(serialized).not.toContain(IDEMPOTENCY_KEY)
    expect(serialized).not.toContain('body')
  })

  it('assigns every stable API code a finite presentation category', () => {
    expect(API_ERROR_CODES.map(presentationForApiError)).toHaveLength(
      API_ERROR_CODES.length,
    )
    for (const code of API_ERROR_CODES) {
      expect(API_ERROR_STATUS[code]).toBeTypeOf('number')
      expect(presentationForApiError(code)).toMatch(
        /^(?:ACCESS_DENIED|INVALID_INPUT|MISSING_RESOURCE|RATE_LIMIT|SERVER_PROBLEM|SESSION_REQUIRED|STATE_CHANGED)$/u,
      )
    }
  })

  it('requires exact-key mutation replay for every uncertain outcome', () => {
    for (const error of [
      new ApiClientError('NETWORK_ERROR'),
      new ApiClientError('MALFORMED_RESPONSE'),
      new ApiClientError('CANCELLED'),
      new ApiClientError('API_ERROR', { apiCode: 'INTERNAL_ERROR' }),
      new ApiClientError('API_ERROR', { apiCode: 'SERVICE_UNAVAILABLE' }),
      new ApiClientError('API_ERROR', { apiCode: 'REQUEST_TIMEOUT' }),
      new ApiClientError('RATE_LIMITED', { retryAfterMilliseconds: 3_000 }),
    ]) {
      expect(retryDirective('runGameplayCommand', error)).toMatchObject({
        kind: 'REPLAY_EXACT_MUTATION',
      })
    }
    expect(
      retryDirective(
        'runGameplayCommand',
        new ApiClientError('API_ERROR', { apiCode: 'STALE_VERSION' }),
      ),
    ).toEqual({ kind: 'REFRESH_THEN_NEW_COMMAND' })
  })
})

describe('session bootstrap', () => {
  it('uses an existing session without creating a replacement', async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async () =>
      jsonResponse(SESSION_RESPONSE),
    )
    const result = await new SessionBootstrap(
      client(fetchImplementation),
    ).initialize()

    expect(result).toEqual({ created: false, session: SESSION_RESPONSE })
    expect(fetchImplementation).toHaveBeenCalledTimes(1)
  })

  it('creates a session with exact empty JSON only after a 401', async () => {
    const calls: RequestInit[] = []
    const fetchImplementation = vi.fn<typeof fetch>(async (_input, init) => {
      calls.push(init ?? {})
      return calls.length === 1
        ? jsonResponse(publicError('AUTHENTICATION_REQUIRED'), 401)
        : jsonResponse(SESSION_RESPONSE, 201)
    })
    const result = await new SessionBootstrap(
      client(fetchImplementation),
    ).initialize()

    expect(result).toEqual({ created: true, session: SESSION_RESPONSE })
    expect(calls).toHaveLength(2)
    expect(calls[0]).toMatchObject({ method: 'GET' })
    expect(calls[1]).toMatchObject({ method: 'POST', body: '{}' })
  })

  it('does not bootstrap after non-authentication failures', async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async () =>
      jsonResponse(publicError('SERVICE_UNAVAILABLE'), 503),
    )
    await expect(
      new SessionBootstrap(
        client(fetchImplementation, { sleep: async () => undefined }),
      ).initialize(),
    ).rejects.toMatchObject({ apiCode: 'SERVICE_UNAVAILABLE' })
    expect(fetchImplementation).toHaveBeenCalledTimes(3)
  })

  it('supports an explicit new-session action without a preliminary read', async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init).toMatchObject({ method: 'POST', body: '{}' })
      return jsonResponse(SESSION_RESPONSE, 201)
    })
    await expect(
      new SessionBootstrap(client(fetchImplementation)).createNewSession(),
    ).resolves.toEqual({ created: true, session: SESSION_RESPONSE })
    expect(fetchImplementation).toHaveBeenCalledTimes(1)
  })
})
