export interface RequestLogEntry {
  readonly durationMs: number
  readonly requestId: string
  readonly routeTemplate: string
  readonly status: number
  /** Public API error code; present only for error responses. */
  readonly errorCode?: string
  /** Redacted internal cause class for 5xx, e.g. `sqlstate:40P01`. */
  readonly cause?: string
}

export interface RequestLogSink {
  write(entry: RequestLogEntry): void
}

export const API_METRIC_NAMES = [
  'api.request.duration',
  'api.request.total',
] as const

export type ApiMetricName = (typeof API_METRIC_NAMES)[number]

export type HttpStatusClass = '2xx' | '3xx' | '4xx' | '5xx'

export interface ApiMetricLabels {
  readonly operation: string
  readonly statusClass: HttpStatusClass
}

export interface ApiMetricPoint {
  readonly labels: ApiMetricLabels
  readonly name: ApiMetricName
  readonly value: number
}

export interface MetricSink {
  record(point: ApiMetricPoint): void
}

export interface ApiTelemetry {
  readonly logs: RequestLogSink
  readonly metrics: MetricSink
}

function copyLog(entry: RequestLogEntry): RequestLogEntry {
  return Object.freeze({
    durationMs: entry.durationMs,
    requestId: entry.requestId,
    routeTemplate: entry.routeTemplate,
    status: entry.status,
    ...(entry.errorCode === undefined ? {} : { errorCode: entry.errorCode }),
    ...(entry.cause === undefined ? {} : { cause: entry.cause }),
  })
}

const sqlStatePattern = /^[0-9A-Z]{5}$/u
const errorNamePattern = /^[A-Za-z][A-Za-z0-9]{0,63}$/u

/**
 * Classifies an internal failure without its message, stack or properties,
 * which may carry query values or narrative. Only a SQLSTATE or a plain
 * constructor name survives.
 */
export function classifyErrorCause(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const code: unknown = (error as { code?: unknown }).code
    if (typeof code === 'string' && sqlStatePattern.test(code))
      return `sqlstate:${code}`
    const name: unknown = (error as { name?: unknown }).name
    if (typeof name === 'string' && errorNamePattern.test(name)) return name
  }
  return 'unknown'
}

export type LogLevel = 'info' | 'warn' | 'error' | 'fatal'

export interface StructuredLogRecord extends RequestLogEntry {
  readonly ts: string
  readonly level: LogLevel
  readonly service: string
  readonly event: 'http_request'
}

export function levelForStatus(status: number): LogLevel {
  if (status >= 500) return 'error'
  if (status >= 400) return 'warn'
  return 'info'
}

/** Wraps an allowlisted request entry; never adds request-derived fields. */
export function toStructuredLogRecord(
  entry: RequestLogEntry,
  service: string,
  now: Date = new Date(),
): StructuredLogRecord {
  return {
    ts: now.toISOString(),
    level: levelForStatus(entry.status),
    service,
    event: 'http_request',
    ...copyLog(entry),
  }
}

function copyMetric(point: ApiMetricPoint): ApiMetricPoint {
  return Object.freeze({
    labels: Object.freeze({
      operation: point.labels.operation,
      statusClass: point.labels.statusClass,
    }),
    name: point.name,
    value: point.value,
  })
}

export class CaptureRequestLogSink implements RequestLogSink {
  readonly entries: RequestLogEntry[] = []

  write(entry: RequestLogEntry): void {
    this.entries.push(copyLog(entry))
  }

  serialize(): string {
    return this.entries.map((entry) => JSON.stringify(entry)).join('\n')
  }
}

export class CaptureMetricSink implements MetricSink {
  readonly points: ApiMetricPoint[] = []

  record(point: ApiMetricPoint): void {
    this.points.push(copyMetric(point))
  }

  serialize(): string {
    return this.points.map((point) => JSON.stringify(point)).join('\n')
  }
}

export function createCaptureTelemetry(): ApiTelemetry & {
  readonly logs: CaptureRequestLogSink
  readonly metrics: CaptureMetricSink
} {
  return {
    logs: new CaptureRequestLogSink(),
    metrics: new CaptureMetricSink(),
  }
}

export const noOpTelemetry: ApiTelemetry = Object.freeze({
  logs: Object.freeze({ write: () => undefined }),
  metrics: Object.freeze({ record: () => undefined }),
})
export * from './health.js'
export * from './prometheus.js'
export * from './queue.js'
