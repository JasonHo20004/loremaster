import { createServer, type Server } from 'node:http'

import type { ServerConfiguration } from '@loremaster/config'
import {
  authenticateSession,
  closeDatabase,
  createGuestSession,
  database as createDatabase,
  isDatabaseTimeoutError,
  transaction,
  verifySessionCsrfToken,
  type Database,
} from '@loremaster/database'
import {
  noOpTelemetry,
  type ApiTelemetry,
  type RequestLogEntry,
} from '@loremaster/observability'

import { createApplication } from './app.js'
import type {
  Clock,
  KernelHandlerContext,
  KernelHandlers,
} from './http/dependencies.js'
import { createDeadlineControl } from './http/deadline.js'
import { PublicHttpError } from './http/errors.js'
import { createTelemetryMiddleware } from './http/telemetry.js'
import {
  createDatabaseGameplayRepository,
  createGameplayHandlers,
} from './routes/gameplay.js'
import {
  createDatabaseReportingRepository,
  createReportingHandlers,
} from './routes/reporting.js'
import { createAuthenticationControl } from './security/auth.js'
import { issueSessionCookies } from './security/cookies.js'
import { createCorsMiddleware } from './security/cors.js'
import { createCsrfControl } from './security/csrf.js'
import { createRequestPolicy } from './security/policy.js'
import { createRateLimitControl } from './security/rate-limit.js'
import { createSourceIpResolver } from './security/source-ip.js'

const DEFAULT_DRAIN_TIMEOUT_MS = 10_000

export interface ComposedApplicationOptions {
  readonly clock?: Clock
  readonly config: ServerConfiguration
  readonly database: Database
  readonly telemetry?: ApiTelemetry
}

export interface ApiRuntimeOptions extends ComposedApplicationOptions {
  readonly drainTimeoutMs?: number
  readonly listenPort?: number
}

export interface ApiRuntime {
  readonly application: ReturnType<typeof createApplication>
  readonly server: Server
  start(): Promise<number>
  stop(): Promise<void>
}

export interface SignalSource {
  off(signal: 'SIGINT' | 'SIGTERM', listener: () => void): this
  once(signal: 'SIGINT' | 'SIGTERM', listener: () => void): this
}

export interface InstalledSignalHandlers {
  remove(): void
}

const systemClock: Clock = Object.freeze({ now: () => Date.now() })

function requireIdentity(context: KernelHandlerContext) {
  if (context.identity === undefined)
    throw new PublicHttpError('AUTHENTICATION_REQUIRED')
  return context.identity
}

function createSessionHandlers(
  db: Database,
  config: ServerConfiguration,
): Pick<KernelHandlers, 'createSession' | 'getSession'> {
  return {
    createSession: async (context) => {
      try {
        const session = await createGuestSession(db, context.deadline)
        issueSessionCookies(context.response, config.cookies, session)
        return {
          status: 201,
          body: { data: { expiresAt: session.expiresAt.toISOString() } },
        }
      } catch (error) {
        if (isDatabaseTimeoutError(error)) throw error
        throw new PublicHttpError('SERVICE_UNAVAILABLE')
      }
    },
    getSession: (context) => {
      const identity = requireIdentity(context)
      return {
        status: 200,
        body: { data: { expiresAt: identity.expiresAt.toISOString() } },
      }
    },
  }
}

function createHealthHandlers(
  db: Database,
): Pick<KernelHandlers, 'healthLive' | 'healthReady'> {
  return {
    healthLive: () => ({ status: 200, body: { status: 'ok' } }),
    healthReady: async (context) => {
      try {
        await transaction(
          db,
          async (client) => {
            await client.query('SELECT 1')
          },
          { deadline: context.deadline, readOnly: true },
        )
        return { status: 200, body: { status: 'ready' } }
      } catch {
        throw new PublicHttpError('SERVICE_UNAVAILABLE')
      }
    },
  }
}

export function createComposedApplication(
  options: ComposedApplicationOptions,
): ReturnType<typeof createApplication> {
  const clock = options.clock ?? systemClock
  const telemetry = options.telemetry ?? noOpTelemetry
  const deadline = createDeadlineControl({
    clock,
    timeoutMs: options.config.timeouts.commandMs,
  })
  const sessions = {
    authenticate: (
      token: string,
      context: Parameters<typeof authenticateSession>[2],
    ) => authenticateSession(options.database, token, context),
    verifyCsrfToken: verifySessionCsrfToken,
  }
  const auth = createAuthenticationControl({
    clock,
    cookies: options.config.cookies,
    deadline,
    sessions,
  })
  const sourceIp = createSourceIpResolver(options.config.trustedProxies)
  const handlers: KernelHandlers = {
    ...createSessionHandlers(options.database, options.config),
    ...createGameplayHandlers(
      createDatabaseGameplayRepository(options.database),
    ),
    ...createReportingHandlers(
      createDatabaseReportingRepository(options.database),
      options.config.cursor,
    ),
    ...createHealthHandlers(options.database),
  }
  return createApplication({
    clock,
    controls: {
      auth,
      cors: createCorsMiddleware(options.config.origin),
      csrf: createCsrfControl({
        auth,
        csrfCookie: options.config.cookies.csrf,
        sessions,
      }),
      deadline,
      limiter: createRateLimitControl({
        auth,
        clock,
        config: options.config.limiter,
        sourceIp,
      }),
      logger: createTelemetryMiddleware(telemetry, clock),
      policy: createRequestPolicy(options.config.origin),
    },
    handlers,
    repository: options.database,
  })
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    server.once('error', onError)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError)
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('API server did not expose a TCP address'))
        return
      }
      resolve(address.port)
    })
  })
}

export function createApiRuntime(options: ApiRuntimeOptions): ApiRuntime {
  const application = createComposedApplication(options)
  const server = createServer(application)
  const listenPort = options.listenPort ?? options.config.port
  const drainTimeoutMs = options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS
  if (
    !Number.isSafeInteger(listenPort) ||
    listenPort < 0 ||
    listenPort > 65_535
  )
    throw new RangeError('listenPort must be a valid TCP port')
  if (!Number.isSafeInteger(drainTimeoutMs) || drainTimeoutMs < 1)
    throw new RangeError('drainTimeoutMs must be a positive safe integer')

  let started = false
  let stopping: Promise<void> | undefined
  return {
    application,
    server,
    async start() {
      if (started) throw new Error('API runtime is already started')
      const port = await listen(server, listenPort)
      started = true
      return port
    },
    stop() {
      stopping ??= (async () => {
        if (started) {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
              server.closeAllConnections()
            }, drainTimeoutMs)
            timer.unref()
            server.close((error) => {
              clearTimeout(timer)
              if (error === undefined) resolve()
              else reject(error)
            })
          })
          started = false
        }
        await closeDatabase(options.database)
      })()
      return stopping
    },
  }
}

export function installSignalHandlers(
  runtime: Pick<ApiRuntime, 'stop'>,
  options: {
    readonly onFailure?: () => void
    readonly onStopped?: () => void
    readonly signals?: SignalSource
  } = {},
): InstalledSignalHandlers {
  const signals = options.signals ?? process
  let handling = false
  const shutdown = () => {
    if (handling) return
    handling = true
    void runtime.stop().then(options.onStopped, options.onFailure)
  }
  signals.once('SIGINT', shutdown)
  signals.once('SIGTERM', shutdown)
  return {
    remove() {
      signals.off('SIGINT', shutdown)
      signals.off('SIGTERM', shutdown)
    },
  }
}

export function createStdoutTelemetry(
  write: (entry: RequestLogEntry) => void = (entry) => {
    process.stdout.write(`${JSON.stringify(entry)}\n`)
  },
): ApiTelemetry {
  return {
    logs: { write },
    metrics: noOpTelemetry.metrics,
  }
}

export function createRuntimeDatabase(config: ServerConfiguration): Database {
  return createDatabase(config.databaseUrl)
}
