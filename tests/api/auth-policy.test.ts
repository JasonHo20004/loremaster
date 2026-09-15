import { createHash } from 'node:crypto'

import type { CookieConfiguration } from '@loremaster/config'
import type { RequestHandler } from 'express'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'

import { createApplication } from '../../apps/api/src/app.js'
import { createDeadlineControl } from '../../apps/api/src/http/deadline.js'
import type {
  AuthenticatedIdentity,
  AuthenticatedSession,
  KernelDependencies,
  KernelHandlers,
  OperationMiddleware,
} from '../../apps/api/src/http/dependencies.js'
import {
  createAuthenticationControl,
  type SessionSecurityStore,
} from '../../apps/api/src/security/auth.js'
import {
  issueSessionCookies,
  type IssuedSessionCookies,
} from '../../apps/api/src/security/cookies.js'
import { createCorsMiddleware } from '../../apps/api/src/security/cors.js'
import { createCsrfControl } from '../../apps/api/src/security/csrf.js'
import { createRequestPolicy } from '../../apps/api/src/security/policy.js'

const ORIGIN = 'http://localhost:5173'
const AUTHENTICATION_TOKEN = 'A'.repeat(43)
const CSRF_TOKEN = 'C'.repeat(43)
const EXPIRES_AT = new Date('2030-01-01T00:00:00.000Z')
const SESSION_RESPONSE = { data: { expiresAt: EXPIRES_AT.toISOString() } }
const START_RESPONSE = {
  data: {
    outcomeCode: 'STARTED',
    replayed: false,
    attempt: {
      view: 'ATTEMPT',
      attemptId: '44444444-4444-4444-8444-444444444444',
      version: 0,
      startedAt: '2026-09-15T00:00:00.000Z',
      closesAt: '2026-09-16T00:00:00.000Z',
      evidenceLevel: 0,
      wrongGuessesAtLevel: 0,
      totalWrongGuesses: 0,
      briefing: 'A concise mystery briefing.',
      suggestions: [
        {
          entityId: 'first_suspect',
          canonicalName: 'First Suspect',
          publicRole: 'Archivist',
          aliases: ['The First'],
        },
        {
          entityId: 'second_suspect',
          canonicalName: 'Second Suspect',
          publicRole: 'Curator',
          aliases: ['The Second'],
        },
      ],
      guessHistory: [],
      state: 'ACTIVE',
      evidence: [],
    },
  },
}

const localCookies = {
  session: {
    name: 'loremaster_local_session',
    httpOnly: true,
    secure: false,
    sameSite: 'lax',
    path: '/',
  } satisfies CookieConfiguration,
  csrf: {
    name: 'loremaster_local_csrf',
    httpOnly: false,
    secure: false,
    sameSite: 'lax',
    path: '/',
  } satisfies CookieConfiguration,
}

const productionCookies = {
  session: {
    ...localCookies.session,
    name: '__Host-loremaster_session',
    secure: true,
  },
  csrf: { ...localCookies.csrf, name: '__Host-loremaster_csrf', secure: true },
}

function hash(token: string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(token).digest())
}

const identity: AuthenticatedIdentity = {
  expiresAt: EXPIRES_AT,
  guestId: '11111111-1111-4111-8111-111111111111',
  pseudonym: 'Guest-test',
  sessionId: '22222222-2222-4222-8222-222222222222',
}

const authenticatedSession: AuthenticatedSession = {
  ...identity,
  csrfHash: hash(CSRF_TOKEN),
}

function store(
  overrides: Partial<SessionSecurityStore> = {},
): SessionSecurityStore {
  return {
    authenticate: async (token) =>
      token === AUTHENTICATION_TOKEN ? authenticatedSession : null,
    verifyCsrfToken: (session, token) => {
      const actual = hash(token)
      return Buffer.from(actual).equals(Buffer.from(session.csrfHash))
    },
    ...overrides,
  }
}

function noOpOperation(): OperationMiddleware {
  return { forOperation: () => (_request, _response, next) => next() }
}

function dependencies(
  handlers: KernelHandlers,
  sessions: SessionSecurityStore = store(),
  cookies = localCookies,
): KernelDependencies {
  const clock = { now: () => 1_700_000_000_000 }
  const deadline = createDeadlineControl({ clock, timeoutMs: 5_000 })
  const auth = createAuthenticationControl({
    clock,
    cookies,
    deadline,
    sessions,
  })
  const noOp: RequestHandler = (_request, _response, next) => next()
  return {
    clock,
    controls: {
      auth,
      cors: createCorsMiddleware(ORIGIN),
      csrf: createCsrfControl({ auth, csrfCookie: cookies.csrf, sessions }),
      deadline,
      limiter: noOpOperation(),
      logger: noOp,
      policy: createRequestPolicy(ORIGIN),
    },
    handlers,
    repository: {},
  }
}

function cookieHeader(cookies = localCookies): string {
  return `${cookies.session.name}=${AUTHENTICATION_TOKEN}; ${cookies.csrf.name}=${CSRF_TOKEN}`
}

function errorCode(response: request.Response): unknown {
  return response.body.error?.code
}

describe('S5.3b authentication and transport policy', () => {
  it('resolves the session cookie to trusted identity without exposing the raw token', async () => {
    const handler = vi.fn((context) => {
      expect(context.identity).toEqual(identity)
      expect(context.identity).not.toHaveProperty('csrfHash')
      expect(context.identity).not.toHaveProperty('authenticationToken')
      return { status: 200 as const, body: SESSION_RESPONSE }
    })
    const response = await request(
      createApplication(dependencies({ getSession: handler })),
    )
      .get('/api/v1/session')
      .set('Cookie', cookieHeader())

    expect(response.status).toBe(200)
    expect(handler).toHaveBeenCalledOnce()
    expect(JSON.stringify(response.body)).not.toContain(AUTHENTICATION_TOKEN)
  })

  it.each([
    ['missing', undefined, store()],
    ['malformed', `${localCookies.session.name}=short`, store()],
    ['unknown', `${localCookies.session.name}=${'Z'.repeat(43)}`, store()],
    [
      'expired',
      `${localCookies.session.name}=${AUTHENTICATION_TOKEN}`,
      store({
        authenticate: async () => ({
          ...authenticatedSession,
          expiresAt: new Date(0),
        }),
      }),
    ],
  ])(
    'returns the same public failure and clears both cookies for %s credentials',
    async (_case, cookie, sessions) => {
      let call = request(
        createApplication(
          dependencies(
            {
              getSession: () => ({ status: 200, body: SESSION_RESPONSE }),
            },
            sessions,
          ),
        ),
      ).get('/api/v1/session')
      if (cookie !== undefined) call = call.set('Cookie', cookie)
      const response = await call

      expect(response.status).toBe(401)
      expect(errorCode(response)).toBe('AUTHENTICATION_REQUIRED')
      expect(response.headers['set-cookie']).toHaveLength(2)
      for (const value of response.headers[
        'set-cookie'
      ] as unknown as string[]) {
        expect(value).toContain('Path=/')
        expect(value).toContain('Expires=Thu, 01 Jan 1970 00:00:00 GMT')
        expect(value).toContain('Max-Age=0')
        expect(value).toContain('SameSite=Lax')
      }
    },
  )

  it('maps authentication-store failures to a generic service error without clearing credentials', async () => {
    const sessions = store({
      authenticate: async () => {
        throw new Error(`leaked ${AUTHENTICATION_TOKEN}`)
      },
    })
    const response = await request(
      createApplication(
        dependencies(
          {
            getSession: () => ({ status: 200, body: SESSION_RESPONSE }),
          },
          sessions,
        ),
      ),
    )
      .get('/api/v1/session')
      .set('Cookie', cookieHeader())

    expect(response.status).toBe(503)
    expect(errorCode(response)).toBe('SERVICE_UNAVAILABLE')
    expect(response.headers['set-cookie']).toBeUndefined()
    expect(JSON.stringify(response.body)).not.toContain(AUTHENTICATION_TOKEN)
  })

  it.each([
    ['local', localCookies, false],
    ['production', productionCookies, true],
  ])(
    'issues mode-specific %s cookies with the frozen attributes',
    async (_mode, cookies, secure) => {
      const issued: IssuedSessionCookies = {
        authenticationToken: AUTHENTICATION_TOKEN,
        csrfToken: CSRF_TOKEN,
        expiresAt: EXPIRES_AT,
      }
      const response = await request(
        createApplication(
          dependencies(
            {
              createSession: ({ response: outgoing }) => {
                issueSessionCookies(outgoing, cookies, issued)
                return { status: 201, body: SESSION_RESPONSE }
              },
            },
            store(),
            cookies,
          ),
        ),
      )
        .post('/api/v1/session')
        .set('Origin', ORIGIN)
        .set('Content-Type', 'application/json')
        .send('{}')

      const setCookies = response.headers['set-cookie'] as unknown as string[]
      expect(response.status).toBe(201)
      expect(setCookies[0]).toContain(
        `${cookies.session.name}=${AUTHENTICATION_TOKEN}`,
      )
      expect(setCookies[0]).toContain('HttpOnly')
      expect(setCookies[1]).toContain(`${cookies.csrf.name}=${CSRF_TOKEN}`)
      expect(setCookies[1]).not.toContain('HttpOnly')
      for (const value of setCookies) {
        expect(value).toContain('Path=/')
        expect(value).toContain('SameSite=Lax')
        expect(value.includes('Secure')).toBe(secure)
        expect(value).not.toContain('Domain=')
      }
    },
  )

  it.each([
    ['missing origin', undefined, CSRF_TOKEN, CSRF_TOKEN],
    ['wrong origin', 'https://evil.example', CSRF_TOKEN, CSRF_TOKEN],
    ['missing CSRF header', ORIGIN, undefined, CSRF_TOKEN],
    ['wrong CSRF header', ORIGIN, 'D'.repeat(43), CSRF_TOKEN],
    ['missing CSRF cookie', ORIGIN, CSRF_TOKEN, undefined],
  ])(
    'rejects gameplay mutation with %s before its handler',
    async (_case, origin, headerToken, cookieToken) => {
      const handler = vi.fn(() => ({ status: 500 as never, body: {} }))
      let call = request(
        createApplication(dependencies({ startCurrentAttempt: handler })),
      )
        .post('/api/v1/cases/current/attempt')
        .set('Content-Type', 'application/json')
        .set('Idempotency-Key', '33333333-3333-4333-8333-333333333333')
        .set(
          'Cookie',
          `${localCookies.session.name}=${AUTHENTICATION_TOKEN}${cookieToken === undefined ? '' : `; ${localCookies.csrf.name}=${cookieToken}`}`,
        )
        .send('{}')
      if (origin !== undefined) call = call.set('Origin', origin)
      if (headerToken !== undefined)
        call = call.set('X-CSRF-Token', headerToken)
      const response = await call

      expect(response.status).toBe(403)
      expect(errorCode(response)).toBe('REQUEST_FORBIDDEN')
      expect(handler).not.toHaveBeenCalled()
    },
  )

  it('accepts a mutation only when the double-submit token is bound to the session', async () => {
    const handler = vi.fn(() => ({
      status: 200 as const,
      body: START_RESPONSE,
    }))
    const response = await request(
      createApplication(dependencies({ startCurrentAttempt: handler })),
    )
      .post('/api/v1/cases/current/attempt')
      .set('Origin', ORIGIN)
      .set('Content-Type', 'application/json')
      .set('Idempotency-Key', '33333333-3333-4333-8333-333333333333')
      .set('X-CSRF-Token', CSRF_TOKEN)
      .set('Cookie', cookieHeader())
      .send('{}')

    expect(response.status).toBe(200)
    expect(handler).toHaveBeenCalledOnce()
  })

  it('rejects matching double-submit tokens that are not bound to the authenticated session', async () => {
    const handler = vi.fn(() => ({
      status: 200 as const,
      body: START_RESPONSE,
    }))
    const sessions = store({ verifyCsrfToken: () => false })
    const response = await request(
      createApplication(
        dependencies({ startCurrentAttempt: handler }, sessions),
      ),
    )
      .post('/api/v1/cases/current/attempt')
      .set('Origin', ORIGIN)
      .set('Content-Type', 'application/json')
      .set('Idempotency-Key', '33333333-3333-4333-8333-333333333333')
      .set('X-CSRF-Token', CSRF_TOKEN)
      .set('Cookie', cookieHeader())
      .send('{}')

    expect(response.status).toBe(403)
    expect(errorCode(response)).toBe('REQUEST_FORBIDDEN')
    expect(handler).not.toHaveBeenCalled()
  })

  it('rejects missing bootstrap Origin and client-selected identity fields', async () => {
    const handler = vi.fn(() => ({
      status: 201 as const,
      body: SESSION_RESPONSE,
    }))
    const application = createApplication(
      dependencies({ createSession: handler }),
    )
    const missingOrigin = await request(application)
      .post('/api/v1/session')
      .set('Content-Type', 'application/json')
      .send('{}')
    const selectedIdentity = await request(application)
      .post('/api/v1/session')
      .set('Origin', ORIGIN)
      .set('Content-Type', 'application/json')
      .send({ guestId: identity.guestId, sessionId: identity.sessionId })

    expect(missingOrigin.status).toBe(403)
    expect(errorCode(missingOrigin)).toBe('REQUEST_FORBIDDEN')
    expect(selectedIdentity.status).toBe(400)
    expect(errorCode(selectedIdentity)).toBe('INVALID_REQUEST')
    expect(handler).not.toHaveBeenCalled()
  })

  it('emits exact credentialed CORS headers and never a wildcard', async () => {
    const application = createApplication(
      dependencies({
        healthLive: () => ({ status: 200, body: { status: 'ok' } }),
      }),
    )
    const allowed = await request(application)
      .get('/health/live')
      .set('Origin', ORIGIN)
    const denied = await request(application)
      .get('/health/live')
      .set('Origin', 'https://evil.example')

    expect(allowed.status).toBe(200)
    expect(allowed.headers).toMatchObject({
      'access-control-allow-origin': ORIGIN,
      'access-control-allow-credentials': 'true',
      vary: 'Origin',
    })
    expect(JSON.stringify(allowed.headers)).not.toContain('*')
    expect(denied.status).toBe(403)
    expect(denied.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('allows only the explicit preflight method and header allowlists', async () => {
    const application = createApplication(dependencies({}))
    const allowed = await request(application)
      .options('/api/v1/session')
      .set('Origin', ORIGIN)
      .set('Access-Control-Request-Method', 'POST')
      .set(
        'Access-Control-Request-Headers',
        'Content-Type, X-CSRF-Token, Idempotency-Key',
      )
    const badMethod = await request(application)
      .options('/api/v1/session')
      .set('Origin', ORIGIN)
      .set('Access-Control-Request-Method', 'DELETE')
    const badHeader = await request(application)
      .options('/api/v1/session')
      .set('Origin', ORIGIN)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'Authorization')

    expect(allowed.status).toBe(204)
    expect(allowed.headers).toMatchObject({
      'access-control-allow-origin': ORIGIN,
      'access-control-allow-credentials': 'true',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers':
        'Content-Type, Idempotency-Key, X-CSRF-Token',
      vary: 'Origin',
    })
    expect(badMethod.status).toBe(403)
    expect(badHeader.status).toBe(403)
  })
})
