import { describe, expect, it } from 'vitest'

import {
  MAXIMUM_API_METRIC_SERIES,
  classifyErrorCause,
  createProcessMetrics,
  createPrometheusMetricSink,
  levelForStatus,
  toStructuredLogRecord,
  type ApiMetricPoint,
} from '../../packages/observability/src/index.js'

function point(
  name: ApiMetricPoint['name'],
  value: number,
  operation = 'createSession',
  statusClass: ApiMetricPoint['labels']['statusClass'] = '2xx',
): ApiMetricPoint {
  return { labels: { operation, statusClass }, name, value }
}

describe('S10 Prometheus API metric sink', () => {
  it('renders request counters and cumulative duration buckets in seconds', () => {
    const sink = createPrometheusMetricSink()
    sink.record(point('api.request.total', 1))
    sink.record(point('api.request.duration', 7))
    sink.record(point('api.request.total', 1))
    sink.record(point('api.request.duration', 300))

    const text = sink.render()
    const labels = 'operation="createSession",status_class="2xx"'
    expect(text).toContain('# TYPE loremaster_api_requests_total counter')
    expect(text).toContain(`loremaster_api_requests_total{${labels}} 2`)
    expect(text).toContain(
      '# TYPE loremaster_api_request_duration_seconds histogram',
    )
    expect(text).toContain(
      `loremaster_api_request_duration_seconds_bucket{${labels},le="0.005"} 0`,
    )
    expect(text).toContain(
      `loremaster_api_request_duration_seconds_bucket{${labels},le="0.01"} 1`,
    )
    expect(text).toContain(
      `loremaster_api_request_duration_seconds_bucket{${labels},le="0.5"} 2`,
    )
    expect(text).toContain(
      `loremaster_api_request_duration_seconds_bucket{${labels},le="+Inf"} 2`,
    )
    expect(text).toContain(
      `loremaster_api_request_duration_seconds_sum{${labels}} 0.307`,
    )
    expect(text).toContain(
      `loremaster_api_request_duration_seconds_count{${labels}} 2`,
    )
    expect(text.endsWith('\n')).toBe(true)
  })

  it('drops labels outside the bounded vocabulary instead of rendering them', () => {
    const sink = createPrometheusMetricSink()
    const secret = 'attempt/11111111-1111-4111-8111-111111111111'
    sink.record(point('api.request.total', 1, secret))
    sink.record(point('api.request.total', 1, 'x"} 1\nevil{a="'))
    sink.record(point('api.request.duration', Number.NaN))
    sink.record(point('api.request.duration', -1))

    const text = sink.render()
    expect(text).not.toContain(secret)
    expect(text).not.toContain('evil')
    expect(text).toContain('loremaster_api_metric_points_dropped_total 4')
  })

  it('caps the number of series', () => {
    const sink = createPrometheusMetricSink()
    for (let index = 0; index < MAXIMUM_API_METRIC_SERIES + 10; index += 1)
      sink.record(point('api.request.total', 1, `operation${index}`))

    const series = sink
      .render()
      .split('\n')
      .filter((line) => line.startsWith('loremaster_api_requests_total{'))
    expect(series).toHaveLength(MAXIMUM_API_METRIC_SERIES)
    expect(sink.render()).toContain(
      'loremaster_api_metric_points_dropped_total 10',
    )
  })

  it('renders unlabelled process metrics', () => {
    const metrics = createProcessMetrics()
    try {
      const text = metrics.render()
      for (const name of [
        'process_cpu_seconds_total',
        'process_resident_memory_bytes',
        'process_start_time_seconds',
        'nodejs_heap_used_bytes',
        'nodejs_heap_total_bytes',
        'nodejs_eventloop_lag_p99_seconds',
      ])
        expect(text).toMatch(new RegExp(`^${name} [0-9.e+-]+$`, 'mu'))
    } finally {
      metrics.stop()
    }
  })
})

describe('S10 structured request logs', () => {
  it('wraps the allowlisted entry with level, service, event and timestamp', () => {
    const record = toStructuredLogRecord(
      {
        durationMs: 12,
        requestId: 'request-1',
        routeTemplate: '/api/v1/session',
        status: 503,
        errorCode: 'SERVICE_UNAVAILABLE',
        cause: 'sqlstate:57P01',
      },
      'api',
      new Date('2030-01-01T00:00:00.000Z'),
    )

    expect(record).toEqual({
      ts: '2030-01-01T00:00:00.000Z',
      level: 'error',
      service: 'api',
      event: 'http_request',
      durationMs: 12,
      requestId: 'request-1',
      routeTemplate: '/api/v1/session',
      status: 503,
      errorCode: 'SERVICE_UNAVAILABLE',
      cause: 'sqlstate:57P01',
    })
    expect(levelForStatus(200)).toBe('info')
    expect(levelForStatus(409)).toBe('warn')
  })

  it('classifies causes without messages, stacks or unsafe names', () => {
    const secret = 'answer=entity-secret'
    const pgError = Object.assign(new Error(secret), { code: '40P01' })
    expect(classifyErrorCause(pgError)).toBe('sqlstate:40P01')
    expect(classifyErrorCause(new TypeError(secret))).toBe('TypeError')
    expect(
      classifyErrorCause(Object.assign(new Error(secret), { name: secret })),
    ).toBe('unknown')
    expect(classifyErrorCause(secret)).toBe('unknown')
    expect(classifyErrorCause(undefined)).toBe('unknown')
  })
})
