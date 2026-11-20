import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

import {
  parseApiRedisConfiguration,
  parseServerEnvironment,
} from '@loremaster/config'
import { classifyErrorCause } from '@loremaster/observability'

import {
  createApiRuntime,
  createRuntimeDatabase,
  createStdoutTelemetry,
  installSignalHandlers,
} from './server.js'

export { createApplication } from './app.js'
export type {
  AuthenticatedIdentity,
  AuthenticatedSession,
  AuthenticationControl,
  ApiRepository,
  Clock,
  DeadlineControl,
  KernelControls,
  KernelDependencies,
  KernelHandler,
  KernelHandlerContext,
  KernelHandlerResult,
  KernelHandlers,
  OperationMiddleware,
} from './http/dependencies.js'
export { PublicHttpError } from './http/errors.js'
export { MAXIMUM_JSON_BODY_BYTES } from './http/raw-json.js'
export { createDeadlineControl } from './http/deadline.js'
export { createAuthenticationControl } from './security/auth.js'
export type { SessionSecurityStore } from './security/auth.js'
export { clearSessionCookies, issueSessionCookies } from './security/cookies.js'
export { createCorsMiddleware } from './security/cors.js'
export { createCsrfControl } from './security/csrf.js'
export { createRequestPolicy } from './security/policy.js'
export {
  createDatabaseGameplayRepository,
  createGameplayHandlers,
  type GameplayRouteRepository,
} from './routes/gameplay.js'
export {
  createDatabaseReportingRepository,
  createReportingHandlers,
  type LeaderboardCursorKeys,
  type ReportingRouteRepository,
} from './routes/reporting.js'
export { createRateLimitControl } from './security/rate-limit.js'
export {
  canonicalIpAddress,
  createSourceIpResolver,
  type SourceIpResolver,
} from './security/source-ip.js'
export {
  createApiRuntime,
  createComposedApplication,
  createRuntimeDatabase,
  createStdoutTelemetry,
  installSignalHandlers,
  type ApiRuntime,
  type ApiRuntimeOptions,
  type ComposedApplicationOptions,
  type InstalledSignalHandlers,
  type SignalSource,
} from './server.js'

/**
 * Logs a redacted fatal record and exits; the orchestrator restarts the
 * process. The error message and stack are never written.
 */
function installFatalHandlers(): void {
  const fatal = (event: string) => (error: unknown) => {
    process.stderr.write(
      `${JSON.stringify({
        ts: new Date().toISOString(),
        level: 'fatal',
        service: 'api',
        event,
        cause: classifyErrorCause(error),
      })}\n`,
    )
    process.exit(1)
  }
  process.once('uncaughtException', fatal('uncaught_exception'))
  process.once('unhandledRejection', fatal('unhandled_rejection'))
}

async function runProcess(): Promise<void> {
  installFatalHandlers()
  let runtime: ReturnType<typeof createApiRuntime> | undefined
  try {
    const config = parseServerEnvironment(process.env)
    const telemetry = createStdoutTelemetry()
    runtime = createApiRuntime({
      config,
      redis: parseApiRedisConfiguration(process.env, [
        config.cursor.active.key,
        ...(config.cursor.previous === undefined
          ? []
          : [config.cursor.previous.key]),
      ]),
      database: createRuntimeDatabase(config),
      telemetry,
      metricsSource: () => telemetry.metrics.render(),
    })
    installSignalHandlers(runtime, {
      onFailure: () => {
        process.stderr.write('Loremaster API shutdown failed\n')
        process.exitCode = 1
      },
    })
    const port = await runtime.start()
    process.stdout.write(
      `Loremaster API listening on ${config.listenHost}:${port}\n`,
    )
  } catch {
    process.stderr.write('Loremaster API failed to start\n')
    process.exitCode = 1
    await runtime?.stop().catch(() => undefined)
  }
}

const invokedPath = process.argv[1]
if (
  invokedPath !== undefined &&
  pathToFileURL(resolve(invokedPath)).href === import.meta.url
) {
  void runProcess()
}
