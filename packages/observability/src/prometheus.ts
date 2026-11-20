import { monitorEventLoopDelay } from 'node:perf_hooks'

import type {
  ApiMetricLabels,
  ApiMetricPoint,
  HttpStatusClass,
  MetricSink,
} from './index.js'

export const API_PROMETHEUS_METRIC_NAMES = Object.freeze({
  requests: 'loremaster_api_requests_total',
  duration: 'loremaster_api_request_duration_seconds',
})

/** Seconds; covers fast reads through the 5 s command deadline. */
export const API_DURATION_BUCKETS_SECONDS = Object.freeze([
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
])

/** Operation labels are allowlisted route IDs; this caps any regression. */
export const MAXIMUM_API_METRIC_SERIES = 128

const operationPattern = /^[A-Za-z][A-Za-z0-9]{0,63}$/u
const statusClasses: ReadonlySet<HttpStatusClass> = new Set([
  '2xx',
  '3xx',
  '4xx',
  '5xx',
])

interface Series {
  readonly labels: ApiMetricLabels
  requests: number
  durationCount: number
  durationSum: number
  readonly buckets: number[]
}

function labelText(labels: ApiMetricLabels): string {
  return `operation="${labels.operation}",status_class="${labels.statusClass}"`
}

function formatNumber(value: number): string {
  return Number.isFinite(value) ? String(value) : '0'
}

export interface PrometheusMetricSink extends MetricSink {
  render(): string
}

/**
 * Aggregates API points into Prometheus counters and a duration histogram.
 * Points with labels outside the bounded vocabulary are dropped, never
 * rendered, so a raw path or identifier cannot become a series.
 */
export function createPrometheusMetricSink(): PrometheusMetricSink {
  const series = new Map<string, Series>()
  let dropped = 0

  function seriesFor(labels: ApiMetricLabels): Series | undefined {
    if (
      !operationPattern.test(labels.operation) ||
      !statusClasses.has(labels.statusClass)
    )
      return undefined
    const key = labelText(labels)
    const existing = series.get(key)
    if (existing !== undefined) return existing
    if (series.size >= MAXIMUM_API_METRIC_SERIES) return undefined
    const created: Series = {
      labels: Object.freeze({
        operation: labels.operation,
        statusClass: labels.statusClass,
      }),
      requests: 0,
      durationCount: 0,
      durationSum: 0,
      buckets: API_DURATION_BUCKETS_SECONDS.map(() => 0),
    }
    series.set(key, created)
    return created
  }

  return {
    record(point: ApiMetricPoint): void {
      const target = seriesFor(point.labels)
      if (
        target === undefined ||
        !Number.isFinite(point.value) ||
        point.value < 0
      ) {
        dropped += 1
        return
      }
      if (point.name === 'api.request.total') {
        target.requests += point.value
        return
      }
      const seconds = point.value / 1000
      target.durationCount += 1
      target.durationSum += seconds
      API_DURATION_BUCKETS_SECONDS.forEach((bound, index) => {
        if (seconds <= bound)
          target.buckets[index] = (target.buckets[index] ?? 0) + 1
      })
    },
    render(): string {
      const { requests, duration } = API_PROMETHEUS_METRIC_NAMES
      const lines = [
        `# HELP ${requests} Completed API requests by operation and status class.`,
        `# TYPE ${requests} counter`,
      ]
      for (const entry of series.values())
        lines.push(`${requests}{${labelText(entry.labels)}} ${entry.requests}`)
      lines.push(
        `# HELP ${duration} API request duration in seconds.`,
        `# TYPE ${duration} histogram`,
      )
      for (const entry of series.values()) {
        const labels = labelText(entry.labels)
        API_DURATION_BUCKETS_SECONDS.forEach((bound, index) => {
          lines.push(
            `${duration}_bucket{${labels},le="${bound}"} ${entry.buckets[index] ?? 0}`,
          )
        })
        lines.push(
          `${duration}_bucket{${labels},le="+Inf"} ${entry.durationCount}`,
          `${duration}_sum{${labels}} ${formatNumber(entry.durationSum)}`,
          `${duration}_count{${labels}} ${entry.durationCount}`,
        )
      }
      lines.push(
        '# HELP loremaster_api_metric_points_dropped_total Metric points rejected by the label policy.',
        '# TYPE loremaster_api_metric_points_dropped_total counter',
        `loremaster_api_metric_points_dropped_total ${dropped}`,
      )
      return `${lines.join('\n')}\n`
    },
  }
}

export interface ProcessMetrics {
  render(): string
  stop(): void
}

/** Node process gauges and counters; no labels, no request data. */
export function createProcessMetrics(): ProcessMetrics {
  const loop = monitorEventLoopDelay({ resolution: 20 })
  loop.enable()
  const startedAtSeconds = Math.floor(Date.now() / 1000 - process.uptime())
  return {
    render(): string {
      const memory = process.memoryUsage()
      const cpu = process.cpuUsage()
      const p99 = loop.percentile(99) / 1e9
      const metrics: readonly (readonly [string, string, string, number])[] = [
        [
          'process_cpu_seconds_total',
          'counter',
          'User and system CPU time in seconds.',
          (cpu.user + cpu.system) / 1e6,
        ],
        [
          'process_resident_memory_bytes',
          'gauge',
          'Resident set size in bytes.',
          memory.rss,
        ],
        [
          'process_start_time_seconds',
          'gauge',
          'Process start time since the Unix epoch in seconds.',
          startedAtSeconds,
        ],
        [
          'nodejs_heap_used_bytes',
          'gauge',
          'V8 heap used in bytes.',
          memory.heapUsed,
        ],
        [
          'nodejs_heap_total_bytes',
          'gauge',
          'V8 heap total in bytes.',
          memory.heapTotal,
        ],
        [
          'nodejs_eventloop_lag_p99_seconds',
          'gauge',
          'Event loop delay 99th percentile in seconds.',
          p99,
        ],
      ]
      return metrics
        .map(
          ([name, type, help, value]) =>
            `# HELP ${name} ${help}\n# TYPE ${name} ${type}\n${name} ${formatNumber(value)}\n`,
        )
        .join('')
    },
    stop(): void {
      loop.disable()
    },
  }
}
