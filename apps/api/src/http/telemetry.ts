import type { Request, RequestHandler } from 'express'

import type { ApiTelemetry, HttpStatusClass } from '@loremaster/observability'

import type { Clock } from './dependencies.js'

interface RequestTelemetryState {
  operation: string
  routeTemplate: string
}

const unmatchedState: RequestTelemetryState = Object.freeze({
  operation: 'unmatched',
  routeTemplate: 'UNMATCHED',
})
const requestTelemetry = new WeakMap<Request, RequestTelemetryState>()

function statusClass(status: number): HttpStatusClass {
  if (status < 300) return '2xx'
  if (status < 400) return '3xx'
  if (status < 500) return '4xx'
  return '5xx'
}

export function identifyTelemetryOperation(
  operation: string,
  routeTemplate: string,
): RequestHandler {
  return (request, _response, next) => {
    requestTelemetry.set(request, { operation, routeTemplate })
    next()
  }
}

export function createTelemetryMiddleware(
  telemetry: ApiTelemetry,
  clock: Clock,
): RequestHandler {
  return (request, response, next) => {
    const startedAt = clock.now()
    let recorded = false
    const record = (): void => {
      if (recorded) return
      recorded = true
      const state = requestTelemetry.get(request) ?? unmatchedState
      const durationMs = Math.max(0, Math.round(clock.now() - startedAt))
      const requestId = response.getHeader('X-Request-ID')
      const safeRequestId =
        typeof requestId === 'string' ? requestId : 'unavailable'

      telemetry.logs.write({
        durationMs,
        requestId: safeRequestId,
        routeTemplate: state.routeTemplate,
        status: response.statusCode,
      })
      const labels = {
        operation: state.operation,
        statusClass: statusClass(response.statusCode),
      } as const
      telemetry.metrics.record({
        labels,
        name: 'api.request.total',
        value: 1,
      })
      telemetry.metrics.record({
        labels,
        name: 'api.request.duration',
        value: durationMs,
      })
    }

    response.once('finish', record)
    response.once('close', record)
    next()
  }
}
