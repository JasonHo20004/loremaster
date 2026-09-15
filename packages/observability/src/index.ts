export interface RequestLogEntry {
  readonly durationMs: number
  readonly requestId: string
  readonly routeTemplate: string
  readonly status: number
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
  })
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
