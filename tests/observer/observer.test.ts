import { describe, expect, it } from 'vitest'
import { createQueueObservation } from '../../apps/queue-observer/src/index.js'
import { renderQueueMetrics } from '../../packages/observability/src/index.js'
import type { BoundedRedisConnection } from '../../packages/cache/src/index.js'

function observation(overrides: Record<string, unknown> = {}) {
  const reads: unknown[][] = []
  const client = {
    llen: async (...args: unknown[]) => {
      reads.push(args)
      return 0
    },
    zcard: async (...args: unknown[]) => {
      reads.push(args)
      return 0
    },
    zrange: async (...args: unknown[]) => {
      reads.push(args)
      return ['PRIVATE-JOB-ID', String(Date.now() - 10000)]
    },
    get: async (...args: unknown[]) => {
      reads.push(args)
      return '1'
    },
    ...overrides,
  }
  const connection = {
    run: async (work: (value: typeof client) => unknown) => work(client),
  } as unknown as BoundedRedisConnection
  return { ...createQueueObservation(connection), reads }
}
describe('bounded read-only queue observation', () => {
  it('exports fixed labels and aggregates while discarding Redis identifiers', async () => {
    const runtime = observation()
    const text = renderQueueMetrics(
      await runtime.inspect(new AbortController().signal),
    )
    expect(text).not.toContain('PRIVATE-JOB-ID')
    expect(text).toContain('queue="loremaster-warm-v1",version="1"')
    expect(text.match(/# TYPE/g)).toHaveLength(8)
    expect(runtime.reads.filter((args) => args.length > 1)).toEqual([
      ['loremaster:v1:queue:loremaster-warm-v1:completed', 0, 0, 'WITHSCORES'],
      ['loremaster:v1:queue:loremaster-warm-v1:failed', 0, 0, 'WITHSCORES'],
    ])
    expect(runtime.ready()).toBe(true)
  })
  it.each([
    { zcard: async () => 129 },
    { zrange: async () => ['secret', 'NaN'] },
    { get: async () => 'token' },
    {
      llen: async () => {
        throw new Error('credential')
      },
    },
  ])('fails malformed or unavailable Redis data closed', async (overrides) => {
    const runtime = observation(overrides)
    const value = await runtime.inspect(new AbortController().signal)
    expect(value.degraded).toBe(1)
    expect(runtime.ready()).toBe(false)
    expect(renderQueueMetrics(value)).not.toMatch(/secret|token|credential/u)
  })
})
