import type { RequestHandler } from 'express'

import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'

import { createApplication } from '../../apps/api/src/app.js'
import type {
  KernelDependencies,
  KernelHandler,
  KernelHandlers,
  OperationMiddleware,
} from '../../apps/api/src/http/dependencies.js'
import { MAXIMUM_JSON_BODY_BYTES } from '../../apps/api/src/http/raw-json.js'

const expiresAt = '2030-01-01T00:00:00.000Z'
const attemptId = '11111111-1111-4111-8111-111111111111'

function dependencies(
  handlers: KernelHandlers,
  events: string[] = [],
): KernelDependencies {
  const globalControl =
    (name: string): RequestHandler =>
    (_request, _response, next) => {
      events.push(name)
      next()
    }
  const operationControl = (name: string): OperationMiddleware => ({
    forOperation: (operationId) => (_request, _response, next) => {
      events.push(`${name}:${operationId}`)
      next()
    },
  })
  const controller = new AbortController()
  return {
    clock: { now: () => 1_700_000_000_000 },
    controls: {
      auth: {
        ...operationControl('auth'),
        identityFor: () => undefined,
        sessionFor: () => undefined,
      },
      cors: globalControl('cors'),
      csrf: operationControl('csrf'),
      deadline: {
        contextFor: () => ({
          deadlineAt: 1_700_000_005_000,
          signal: controller.signal,
          now: () => 1_700_000_000_000,
        }),
        middleware: globalControl('deadline'),
      },
      limiter: operationControl('limiter'),
      logger: globalControl('logger'),
      policy: operationControl('policy'),
    },
    handlers,
    repository: {},
  }
}

function createSessionHandler(
  implementation?: KernelHandler,
): ReturnType<typeof vi.fn<KernelHandler>> {
  return vi.fn<KernelHandler>(
    implementation ?? (() => ({ status: 201, body: { data: { expiresAt } } })),
  )
}

describe('S5.3a Express kernel', () => {
  it('delivers validated input to an injected handler through the fixed control seams', async () => {
    const events: string[] = []
    const handler = createSessionHandler((context) => {
      events.push('handler')
      expect(context).toMatchObject({
        body: {},
        headers: {
          contentType: 'application/json',
          origin: 'http://localhost:5173',
        },
        operationId: 'createSession',
        receivedAt: 1_700_000_000_000,
      })
      expect(context.requestId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      )
      return { status: 201, body: { data: { expiresAt } } }
    })
    const response = await request(
      createApplication(dependencies({ createSession: handler }, events)),
    )
      .post('/api/v1/session')
      .set('Content-Type', 'application/json')
      .set('Origin', 'http://localhost:5173')
      .set('X-Request-ID', 'client-selected')
      .send('{}')

    expect(response.status).toBe(201)
    expect(response.body).toEqual({ data: { expiresAt } })
    expect(response.headers['x-request-id']).not.toBe('client-selected')
    expect(response.headers).toMatchObject({
      'cache-control': 'no-store',
      'content-security-policy':
        "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
      'permissions-policy': 'camera=(), geolocation=(), microphone=()',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
    })
    expect(response.headers['x-powered-by']).toBeUndefined()
    expect(events).toEqual([
      'logger',
      'deadline',
      'cors',
      'policy:createSession',
      'auth:createSession',
      'csrf:createSession',
      'limiter:createSession',
      'handler',
    ])
  })

  it('accepts exactly 16 KiB and rejects the next byte before the handler', async () => {
    const handler = createSessionHandler()
    const application = createApplication(
      dependencies({ createSession: handler }),
    )
    const atLimit = Buffer.concat([
      Buffer.from('{}'),
      Buffer.alloc(MAXIMUM_JSON_BODY_BYTES - 2, 0x20),
    ])
    const accepted = await request(application)
      .post('/api/v1/session')
      .set('Content-Type', 'application/json')
      .set('Origin', 'http://localhost:5173')
      .send(atLimit.toString('utf8'))
    const rejected = await request(application)
      .post('/api/v1/session')
      .set('Content-Type', 'application/json')
      .set('Origin', 'http://localhost:5173')
      .send(Buffer.concat([atLimit, Buffer.from(' ')]).toString('utf8'))

    expect(accepted.status).toBe(201)
    expect(rejected.status).toBe(413)
    expect(rejected.body.error.code).toBe('BODY_TOO_LARGE')
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it.each([
    [
      'malformed JSON',
      'application/json',
      '{"broken":',
      400,
      'INVALID_REQUEST',
    ],
    [
      'duplicate object key',
      'application/json',
      '{"duplicate":1,"duplicate":2}',
      400,
      'INVALID_REQUEST',
    ],
    [
      'unknown object key',
      'application/json',
      '{"secret-marker":true}',
      400,
      'INVALID_REQUEST',
    ],
    ['wrong media type', 'text/plain', '{}', 415, 'UNSUPPORTED_MEDIA_TYPE'],
    [
      'parameterized media type',
      'application/json; charset=utf-8',
      '{}',
      415,
      'UNSUPPORTED_MEDIA_TYPE',
    ],
  ] as const)(
    'rejects %s without echoing input',
    async (_label, contentType, body, status, code) => {
      const handler = createSessionHandler()
      const response = await request(
        createApplication(dependencies({ createSession: handler })),
      )
        .post('/api/v1/session')
        .set('Content-Type', contentType)
        .set('Origin', 'http://localhost:5173')
        .send(body)

      expect(response.status).toBe(status)
      expect(response.body.error).toMatchObject({ code })
      if (_label === 'duplicate object key') {
        expect(response.body.error.fields).toEqual([
          { path: '$', code: 'DUPLICATE_FIELD' },
        ])
      }
      expect(response.body.error.requestId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      )
      expect(response.text).not.toContain('secret-marker')
      expect(response.text).not.toContain('broken')
      expect(handler).not.toHaveBeenCalled()
    },
  )

  it('rejects nested duplicate command keys with a stable public field path', async () => {
    const handler = vi.fn<KernelHandler>()
    const response = await request(
      createApplication(dependencies({ runGameplayCommand: handler })),
    )
      .post(`/api/v1/attempts/${attemptId}/commands`)
      .set('Content-Type', 'application/json')
      .set('Origin', 'http://localhost:5173')
      .set('Idempotency-Key', 'command-1')
      .set('X-CSRF-Token', Buffer.alloc(32, 1).toString('base64url'))
      .send(
        '{"expectedVersion":0,"command":{"kind":"REVEAL","kind":"GIVE_UP"}}',
      )

    expect(response.status).toBe(400)
    expect(response.body.error.fields).toEqual([
      { path: '$.command.kind', code: 'DUPLICATE_FIELD' },
    ])
    expect(handler).not.toHaveBeenCalled()
  })

  it('maps schema failures to the frozen public field paths', async () => {
    const handler = createSessionHandler()
    const response = await request(
      createApplication(dependencies({ createSession: handler })),
    )
      .post('/api/v1/session')
      .set('Content-Type', 'application/json')
      .send('{}')

    expect(response.status).toBe(400)
    expect(response.body.error.fields).toContainEqual({
      path: '$.headers.origin',
      code: 'REQUIRED',
    })
    expect(handler).not.toHaveBeenCalled()
  })

  it('rejects repeated security headers and query parameters', async () => {
    const sessionHandler = createSessionHandler()
    const repeatedHeader = await request(
      createApplication(dependencies({ createSession: sessionHandler })),
    )
      .post('/api/v1/session')
      .set('Content-Type', 'application/json')
      .set('Origin', ['http://localhost:5173', 'http://localhost:5173'])
      .send('{}')

    const suggestionsHandler = vi.fn<KernelHandler>()
    const repeatedQuery = await request(
      createApplication(dependencies({ getSuggestions: suggestionsHandler })),
    ).get(`/api/v1/attempts/${attemptId}/suggestions?q=one&q=two`)

    expect(repeatedHeader.status).toBe(400)
    expect(repeatedHeader.body.error.fields).toEqual([
      { path: '$.headers.origin', code: 'DUPLICATE_FIELD' },
    ])
    expect(repeatedQuery.status).toBe(400)
    expect(repeatedQuery.body.error.fields).toEqual([
      { path: '$.q', code: 'DUPLICATE_FIELD' },
    ])
    expect(sessionHandler).not.toHaveBeenCalled()
    expect(suggestionsHandler).not.toHaveBeenCalled()
  })

  it('converts invalid handler output and unknown routes to non-disclosing envelopes', async () => {
    const application = createApplication(
      dependencies({
        createSession: createSessionHandler(() => ({
          status: 201,
          body: { databaseRow: 'must-not-escape' },
        })),
      }),
    )
    const invalidOutput = await request(application)
      .post('/api/v1/session')
      .set('Content-Type', 'application/json')
      .set('Origin', 'http://localhost:5173')
      .send('{}')
    const unknown = await request(application).get('/not-a-route')

    expect(invalidOutput.status).toBe(500)
    expect(invalidOutput.body.error.code).toBe('INTERNAL_ERROR')
    expect(invalidOutput.text).not.toContain('databaseRow')
    expect(unknown.status).toBe(404)
    expect(unknown.body.error.code).toBe('RESOURCE_NOT_FOUND')
  })
})
