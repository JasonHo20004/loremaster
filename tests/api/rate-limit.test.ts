import { createHash } from 'node:crypto'

import type {
  CookieConfiguration,
  ServerConfiguration,
  TrustedProxy,
} from '@loremaster/config'
import type { RequestHandler } from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'

import { createApplication } from '../../apps/api/src/app.js'
import { createDeadlineControl } from '../../apps/api/src/http/deadline.js'
import type {
  AuthenticatedSession,
  Clock,
  KernelDependencies,
  KernelHandlers,
  OperationMiddleware,
} from '../../apps/api/src/http/dependencies.js'
import {
  createAuthenticationControl,
  type SessionSecurityStore,
} from '../../apps/api/src/security/auth.js'
import { createRateLimitControl } from '../../apps/api/src/security/rate-limit.js'
import { createSourceIpResolver } from '../../apps/api/src/security/source-ip.js'

const ORIGIN = 'http://localhost:5173'
const TOKEN_A = 'A'.repeat(43)
const TOKEN_B = 'B'.repeat(43)
const CSRF_TOKEN = 'C'.repeat(43)
const cookies = {
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

class MutableClock implements Clock {
  value = 1_000

  now(): number {
    return this.value
  }
}

function limiterConfig(
  overrides: Partial<ServerConfiguration['limiter']> = {},
): ServerConfiguration['limiter'] {
  return {
    windowMs: 60_000,
    mutationsPerGuest: 30,
    mutationsPerIp: 120,
    autocompletePerGuest: 120,
    autocompletePerIp: 300,
    sessionCreationsPerIp: 10,
    guestCapacity: 10,
    ipCapacity: 10,
    ...overrides,
  }
}

function session(token: string): AuthenticatedSession | null {
  const guest = token === TOKEN_A ? 'a' : token === TOKEN_B ? 'b' : undefined
  if (guest === undefined) return null
  return {
    csrfHash: new Uint8Array(createHash('sha256').update(CSRF_TOKEN).digest()),
    expiresAt: new Date('2030-01-01T00:00:00.000Z'),
    guestId: `${guest === 'a' ? '11111111' : '22222222'}-1111-4111-8111-111111111111`,
    pseudonym: `Guest-${guest}`,
    sessionId: `${guest === 'a' ? '33333333' : '44444444'}-3333-4333-8333-333333333333`,
  }
}

function noOpOperation(): OperationMiddleware {
  return { forOperation: () => (_request, _response, next) => next() }
}

function dependencies(options: {
  readonly clock: MutableClock
  readonly config: ServerConfiguration['limiter']
  readonly handlers: KernelHandlers
  readonly trustedProxies?: readonly TrustedProxy[]
}): KernelDependencies {
  const deadline = createDeadlineControl({
    clock: options.clock,
    timeoutMs: 5_000,
  })
  const sessions: SessionSecurityStore = {
    authenticate: async (token) => session(token),
    verifyCsrfToken: () => true,
  }
  const auth = createAuthenticationControl({
    clock: options.clock,
    cookies,
    deadline,
    sessions,
  })
  const noOp: RequestHandler = (_request, _response, next) => next()
  return {
    clock: options.clock,
    controls: {
      auth,
      cors: noOp,
      csrf: noOpOperation(),
      deadline,
      limiter: createRateLimitControl({
        auth,
        clock: options.clock,
        config: options.config,
        sourceIp: createSourceIpResolver(options.trustedProxies ?? []),
      }),
      logger: noOp,
      policy: noOpOperation(),
    },
    handlers: options.handlers,
    repository: {},
  }
}

function bootstrap(
  application: ReturnType<typeof createApplication>,
  forwarded?: string,
) {
  let call = request(application)
    .post('/api/v1/session')
    .set('Origin', ORIGIN)
    .set('Content-Type', 'application/json')
    .send('{}')
  if (forwarded !== undefined) call = call.set('X-Forwarded-For', forwarded)
  return call
}

describe('S5.3d trusted source IP and bounded abuse controls', () => {
  it('enforces the exact session-creation limit and deterministic Retry-After', async () => {
    const clock = new MutableClock()
    const application = createApplication(
      dependencies({
        clock,
        config: limiterConfig({ sessionCreationsPerIp: 2 }),
        handlers: {
          createSession: () => ({
            status: 201,
            body: { data: { expiresAt: '2030-01-01T00:00:00.000Z' } },
          }),
        },
      }),
    )

    expect((await bootstrap(application)).status).toBe(201)
    expect((await bootstrap(application)).status).toBe(201)
    const limited = await bootstrap(application)
    expect(limited.status).toBe(429)
    expect(limited.body.error.code).toBe('RATE_LIMITED')
    expect(limited.headers['retry-after']).toBe('59')

    clock.value = 60_001
    expect((await bootstrap(application)).status).toBe(201)
  })

  it('rejects forwarding headers from an untrusted socket', async () => {
    const clock = new MutableClock()
    const response = await bootstrap(
      createApplication(
        dependencies({
          clock,
          config: limiterConfig(),
          handlers: {
            createSession: () => ({
              status: 201,
              body: { data: { expiresAt: '2030-01-01T00:00:00.000Z' } },
            }),
          },
        }),
      ),
      '198.51.100.7',
    )

    expect(response.status).toBe(403)
    expect(response.body.error.code).toBe('REQUEST_FORBIDDEN')
  })

  it('stops at the first untrusted forwarding hop so left-side spoofing cannot evade a limit', async () => {
    const clock = new MutableClock()
    const application = createApplication(
      dependencies({
        clock,
        config: limiterConfig({ sessionCreationsPerIp: 1 }),
        handlers: {
          createSession: () => ({
            status: 201,
            body: { data: { expiresAt: '2030-01-01T00:00:00.000Z' } },
          }),
        },
        trustedProxies: [
          { address: '127.0.0.1', prefixLength: 32, version: 4 },
          { address: '10.0.0.0', prefixLength: 8, version: 4 },
        ],
      }),
    )

    expect(
      (await bootstrap(application, '203.0.113.9, 198.51.100.7, 10.0.0.5'))
        .status,
    ).toBe(201)
    const spoofed = await bootstrap(
      application,
      '192.0.2.1, 198.51.100.7, 10.0.0.5',
    )
    expect(spoofed.status).toBe(429)
  })

  it('rejects new IP identities when bounded storage is full', async () => {
    const clock = new MutableClock()
    const application = createApplication(
      dependencies({
        clock,
        config: limiterConfig({ ipCapacity: 1 }),
        handlers: {
          createSession: () => ({
            status: 201,
            body: { data: { expiresAt: '2030-01-01T00:00:00.000Z' } },
          }),
        },
        trustedProxies: [
          { address: '127.0.0.1', prefixLength: 32, version: 4 },
        ],
      }),
    )

    expect((await bootstrap(application, '198.51.100.1')).status).toBe(201)
    expect((await bootstrap(application, '198.51.100.2')).status).toBe(429)
  })

  it('canonicalizes equivalent IPv6 identities and rejects malformed forwarding chains', async () => {
    const clock = new MutableClock()
    const application = createApplication(
      dependencies({
        clock,
        config: limiterConfig({ sessionCreationsPerIp: 1 }),
        handlers: {
          createSession: () => ({
            status: 201,
            body: { data: { expiresAt: '2030-01-01T00:00:00.000Z' } },
          }),
        },
        trustedProxies: [
          { address: '127.0.0.1', prefixLength: 32, version: 4 },
        ],
      }),
    )

    expect((await bootstrap(application, '2001:db8::1')).status).toBe(201)
    expect((await bootstrap(application, '2001:0db8:0:0:0:0:0:1')).status).toBe(
      429,
    )
    expect((await bootstrap(application, 'not-an-ip')).status).toBe(403)
    expect(
      (
        await bootstrap(
          application,
          Array.from({ length: 33 }, () => '10.0.0.1').join(', '),
        )
      ).status,
    ).toBe(403)
  })

  it('enforces guest autocomplete limits across source IPs', async () => {
    const clock = new MutableClock()
    const application = createApplication(
      dependencies({
        clock,
        config: limiterConfig({ autocompletePerGuest: 1 }),
        handlers: {
          getSuggestions: () => ({
            status: 200,
            body: { data: { items: [] } },
          }),
        },
        trustedProxies: [
          { address: '127.0.0.1', prefixLength: 32, version: 4 },
        ],
      }),
    )
    const suggest = (ip: string) =>
      request(application)
        .get(
          '/api/v1/attempts/44444444-4444-4444-8444-444444444444/suggestions?q=a',
        )
        .set('Cookie', `${cookies.session.name}=${TOKEN_A}`)
        .set('X-Forwarded-For', ip)

    expect((await suggest('198.51.100.1')).status).toBe(200)
    const limited = await suggest('198.51.100.2')
    expect(limited.status).toBe(429)
    expect(limited.body.error.code).toBe('RATE_LIMITED')
  })

  it('enforces guest mutation limits after authentication and before the handler', async () => {
    const clock = new MutableClock()
    const application = createApplication(
      dependencies({
        clock,
        config: limiterConfig({ mutationsPerGuest: 1 }),
        handlers: {
          startCurrentAttempt: () => ({ status: 200, body: START_RESPONSE }),
        },
      }),
    )
    const mutate = () =>
      request(application)
        .post('/api/v1/cases/current/attempt')
        .set('Origin', ORIGIN)
        .set('Content-Type', 'application/json')
        .set('Idempotency-Key', 'same-key')
        .set('X-CSRF-Token', CSRF_TOKEN)
        .set('Cookie', `${cookies.session.name}=${TOKEN_A}`)
        .send('{}')

    expect((await mutate()).status).toBe(200)
    const limited = await mutate()
    expect(limited.status).toBe(429)
    expect(limited.body.error.code).toBe('RATE_LIMITED')
  })
})
