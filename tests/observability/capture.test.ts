import { describe, expect, it } from 'vitest'

import {
  CaptureMetricSink,
  CaptureRequestLogSink,
} from '../../packages/observability/src/index.js'

describe('S5.3e telemetry capture adapters', () => {
  it('copies and serializes only the request log allowlist', () => {
    const sink = new CaptureRequestLogSink()
    const entry = {
      durationMs: 12,
      requestId: 'server-id',
      routeTemplate: '/api/v1/attempts/:attemptId/commands',
      status: 409,
      secret: 'token-shaped-secret',
    }

    sink.write(entry)

    expect(sink.entries).toEqual([
      {
        durationMs: 12,
        requestId: 'server-id',
        routeTemplate: '/api/v1/attempts/:attemptId/commands',
        status: 409,
      },
    ])
    expect(sink.serialize()).not.toContain('token-shaped-secret')
  })

  it('copies and serializes only fixed metric fields and labels', () => {
    const sink = new CaptureMetricSink()
    const point = {
      labels: {
        operation: 'commandAttempt',
        statusClass: '4xx' as const,
        guestId: 'guest-shaped-secret',
      },
      name: 'api.request.total' as const,
      value: 1,
      rawUrl: '/attempts/private-id?guess=private-answer',
    }

    sink.record(point)

    expect(sink.points).toEqual([
      {
        labels: { operation: 'commandAttempt', statusClass: '4xx' },
        name: 'api.request.total',
        value: 1,
      },
    ])
    expect(sink.serialize()).not.toMatch(
      /guest-shaped|private-id|private-answer/u,
    )
  })
})
