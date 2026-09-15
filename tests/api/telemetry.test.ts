import type { RequestHandler } from 'express'

import request from 'supertest'
import { describe, expect, it } from 'vitest'

import { createApplication } from '../../apps/api/src/app.js'
import type {
  KernelDependencies,
  OperationMiddleware,
} from '../../apps/api/src/http/dependencies.js'
import { createTelemetryMiddleware } from '../../apps/api/src/http/telemetry.js'
import { createCaptureTelemetry } from '../../packages/observability/src/index.js'

const secret = 'secret-token-guess-attempt-11111111-1111-4111-8111-111111111111'

function dependencies(): {
  readonly capture: ReturnType<typeof createCaptureTelemetry>
  readonly value: KernelDependencies
} {
  let now = 100
  const clock = { now: () => (now += 7) }
  const pass: RequestHandler = (_request, _response, next) => next()
  const operation: OperationMiddleware = { forOperation: () => pass }
  const controller = new AbortController()
  const capture = createCaptureTelemetry()
  return {
    capture,
    value: {
      clock,
      controls: {
        auth: {
          ...operation,
          identityFor: () => undefined,
          sessionFor: () => undefined,
        },
        cors: pass,
        csrf: operation,
        deadline: {
          contextFor: () => ({
            deadlineAt: 5_000,
            now: clock.now,
            signal: controller.signal,
          }),
          middleware: pass,
        },
        limiter: operation,
        logger: createTelemetryMiddleware(capture, clock),
        policy: operation,
      },
      handlers: {
        createSession: () => ({
          body: { data: { expiresAt: '2030-01-01T00:00:00.000Z' } },
          status: 201,
        }),
      },
      repository: {},
    },
  }
}

describe('S5.3e API telemetry', () => {
  it('records an allowlisted route template and bounded metric labels', async () => {
    const setup = dependencies()
    const response = await request(createApplication(setup.value))
      .post(`/api/v1/session?private=${secret}`)
      .set('Content-Type', 'application/json')
      .set('Cookie', `__Host-session=${secret}`)
      .set('Origin', 'http://localhost:5173')
      .send('{}')

    expect(response.status).toBe(201)
    expect(setup.capture.logs.entries).toEqual([
      {
        durationMs: 7,
        requestId: response.headers['x-request-id'],
        routeTemplate: '/api/v1/session',
        status: 201,
      },
    ])
    expect(setup.capture.metrics.points).toEqual([
      {
        labels: { operation: 'createSession', statusClass: '2xx' },
        name: 'api.request.total',
        value: 1,
      },
      {
        labels: { operation: 'createSession', statusClass: '2xx' },
        name: 'api.request.duration',
        value: 7,
      },
    ])
    expect(JSON.stringify(setup.capture)).not.toContain(secret)
  })

  it('uses a constant unmatched label and never captures a raw URL', async () => {
    const setup = dependencies()
    const response = await request(createApplication(setup.value)).get(
      `/not-found/${secret}?guess=${secret}`,
    )

    expect(response.status).toBe(404)
    expect(setup.capture.logs.entries[0]).toMatchObject({
      routeTemplate: 'UNMATCHED',
      status: 404,
    })
    expect(setup.capture.metrics.points[0]).toMatchObject({
      labels: { operation: 'unmatched', statusClass: '4xx' },
    })
    expect(JSON.stringify(setup.capture)).not.toContain(secret)
  })
})
