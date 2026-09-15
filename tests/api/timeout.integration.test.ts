import type { CookieConfiguration } from '@loremaster/config'
import { PassThrough } from 'node:stream'
import type { RequestHandler } from 'express'
import type { Request } from 'express'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'

import { DatabaseTimeoutError } from '../../packages/database/dist/index.js'

import { createApplication } from '../../apps/api/src/app.js'
import { createDeadlineControl } from '../../apps/api/src/http/deadline.js'
import { parseBoundedJsonBody } from '../../apps/api/src/http/raw-json.js'
import type {
  AuthenticationControl,
  KernelDependencies,
  KernelHandlers,
  OperationMiddleware,
} from '../../apps/api/src/http/dependencies.js'
import {
  createAuthenticationControl,
  type SessionSecurityStore,
} from '../../apps/api/src/security/auth.js'

const TOKEN = 'A'.repeat(43)
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

function noOpOperation(): OperationMiddleware {
  return { forOperation: () => (_request, _response, next) => next() }
}

function dependencies(
  handlers: KernelHandlers,
  timeoutMs: number,
  createAuth?: (
    deadline: ReturnType<typeof createDeadlineControl>,
  ) => AuthenticationControl,
): KernelDependencies {
  const clock = { now: () => Date.now() }
  const deadline = createDeadlineControl({ clock, timeoutMs })
  const noOp: RequestHandler = (_request, _response, next) => next()
  const auth = createAuth?.(deadline) ?? {
    ...noOpOperation(),
    identityFor: () => undefined,
    sessionFor: () => undefined,
  }
  return {
    clock,
    controls: {
      auth,
      cors: noOp,
      csrf: noOpOperation(),
      deadline,
      limiter: noOpOperation(),
      logger: noOp,
      policy: noOpOperation(),
    },
    handlers,
    repository: {},
  }
}

describe('S5.3c request deadline integration', () => {
  it('interrupts an incomplete request body when its deadline is cancelled', async () => {
    const stream = Object.assign(new PassThrough(), {
      headers: {} as Request['headers'],
    }) as unknown as Request
    const controller = new AbortController()
    const parsing = parseBoundedJsonBody(stream, controller.signal)
    controller.abort('DEADLINE')

    await expect(parsing).rejects.toMatchObject({
      code: 'REQUEST_TIMEOUT',
      status: 504,
    })
  })

  it('returns the frozen timeout envelope only after cancellation cleanup completes', async () => {
    let cleanupComplete = false
    const handler = vi.fn(async ({ deadline }) => {
      await new Promise<void>((resolve) =>
        deadline.signal.addEventListener('abort', () => resolve(), {
          once: true,
        }),
      )
      await new Promise((resolve) => setTimeout(resolve, 25))
      cleanupComplete = true
      throw new DatabaseTimeoutError('DEADLINE')
    })
    const startedAt = Date.now()
    const response = await request(
      createApplication(dependencies({ healthLive: handler }, 20)),
    ).get('/health/live')

    expect(response.status).toBe(504)
    expect(response.body.error.code).toBe('REQUEST_TIMEOUT')
    expect(response.body.error.requestId).toMatch(/^[0-9a-f-]{36}$/u)
    expect(cleanupComplete).toBe(true)
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(35)
    expect(handler).toHaveBeenCalledOnce()
  })

  it('threads the same deadline through authentication and preserves timeout classification', async () => {
    let observedBudget = 0
    const sessions: SessionSecurityStore = {
      authenticate: async (_token, deadline) => {
        observedBudget = deadline.deadlineAt - deadline.now()
        await new Promise<void>((resolve) =>
          deadline.signal.addEventListener('abort', () => resolve(), {
            once: true,
          }),
        )
        throw new DatabaseTimeoutError('POOL')
      },
      verifyCsrfToken: () => false,
    }
    const response = await request(
      createApplication(
        dependencies(
          {
            getSession: () => ({
              status: 200,
              body: { data: { expiresAt: '2030-01-01T00:00:00.000Z' } },
            }),
          },
          25,
          (deadline) =>
            createAuthenticationControl({
              clock: { now: () => Date.now() },
              cookies,
              deadline,
              sessions,
            }),
        ),
      ),
    )
      .get('/api/v1/session')
      .set('Cookie', `${cookies.session.name}=${TOKEN}`)

    expect(response.status).toBe(504)
    expect(response.body.error.code).toBe('REQUEST_TIMEOUT')
    expect(observedBudget).toBeGreaterThan(0)
    expect(observedBudget).toBeLessThanOrEqual(25)
    expect(response.headers['set-cookie']).toBeUndefined()
  })
})
