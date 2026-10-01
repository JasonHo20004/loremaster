import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { createPrivateHealthServer } from '../../packages/observability/src/index.js'

describe('private worker probes', () => {
  it('closes an in-progress bind when shutdown arrives during startup', async () => {
    const runtime = createPrivateHealthServer({
      port: 0,
      ready: async () => true,
    })
    const starting = runtime.start()
    await runtime.stop()
    await starting
    expect(runtime.server.listening).toBe(false)
    await expect(runtime.start()).rejects.toThrow(
      'Health already started or stopped',
    )
  })
  it('keeps liveness independent of PG/Redis and marks drain immediately', async () => {
    let pg = true,
      redis = true
    const runtime = createPrivateHealthServer({
      port: 0,
      ready: async () => pg && redis,
    })
    await runtime.start()
    try {
      expect(runtime.server.address()).toMatchObject({ address: '127.0.0.1' })
      await request(runtime.server)
        .get('/health/ready')
        .expect(200, { status: 'ready' })
      for (const failure of ['pg', 'redis']) {
        pg = failure !== 'pg'
        redis = failure !== 'redis'
        await request(runtime.server)
          .get('/health/ready')
          .expect(503, { status: 'unavailable' })
        await request(runtime.server)
          .get('/health/live')
          .expect(200, { status: 'ok' })
      }
      runtime.drain()
      await request(runtime.server)
        .get('/health/ready')
        .expect(503, { status: 'draining' })
      await request(runtime.server)
        .get('/health/live')
        .expect(200, { status: 'ok' })
      await request(runtime.server).post('/health/live').expect(405)
      await request(runtime.server)
        .get('/health/live?secret=hidden')
        .expect(404)
    } finally {
      await runtime.stop()
    }
  })
  it('bounds and cancels stalled probes without disclosing errors', async () => {
    let cancelled = false
    const runtime = createPrivateHealthServer({
      port: 0,
      ready: async (signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              cancelled = true
              reject(new Error('secret database URL'))
            },
            { once: true },
          )
        }),
    })
    await runtime.start()
    try {
      await request(runtime.server)
        .get('/health/ready')
        .expect(503, { status: 'unavailable' })
      expect(cancelled).toBe(true)
    } finally {
      await runtime.stop()
    }
  })
})
