import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

import { parseServerEnvironment } from '@loremaster/config'

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

async function runProcess(): Promise<void> {
  let runtime: ReturnType<typeof createApiRuntime> | undefined
  try {
    const config = parseServerEnvironment(process.env)
    runtime = createApiRuntime({
      config,
      database: createRuntimeDatabase(config),
      telemetry: createStdoutTelemetry(),
    })
    installSignalHandlers(runtime, {
      onFailure: () => {
        process.stderr.write('Loremaster API shutdown failed\n')
        process.exitCode = 1
      },
    })
    const port = await runtime.start()
    process.stdout.write(`Loremaster API listening on 127.0.0.1:${port}\n`)
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
