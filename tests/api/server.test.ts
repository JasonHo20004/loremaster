import { EventEmitter } from 'node:events'
import { createServer as createNetServer } from 'node:net'

import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'

import {
  createApiRuntime,
  installSignalHandlers,
  type SignalSource,
} from '../../apps/api/src/server.js'
import { parseServerEnvironment } from '../../packages/config/src/index.js'
import type { Database } from '../../packages/database/src/migrate.js'

function configuration() {
  return parseServerEnvironment({
    LOREMASTER_API_MODE: 'local',
    DATABASE_URL: 'postgresql://runtime:placeholder@127.0.0.1:5432/loremaster',
    LOREMASTER_API_ORIGIN: 'http://localhost:5173',
    LOREMASTER_API_CURSOR_ACTIVE_VERSION: 'test',
    LOREMASTER_API_CURSOR_ACTIVE_KEY: Buffer.alloc(32, 0x11).toString(
      'base64url',
    ),
  })
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      probe.close(() =>
        typeof address === 'object' && address !== null
          ? resolve(address.port)
          : reject(new Error('No probe port')),
      )
    })
  })
}

describe('S5.6 API runtime', () => {
  it('serves liveness without PostgreSQL, keeps readiness secret-safe, and closes the pool', async () => {
    const end = vi.fn(async () => undefined)
    const db = {
      connect: vi.fn(async () => {
        throw new Error('postgresql://runtime:do-not-disclose@database/private')
      }),
      end,
    } as unknown as Database
    const runtime = createApiRuntime({
      config: configuration(),
      database: db,
      drainTimeoutMs: 100,
      listenPort: 0,
    })
    const port = await runtime.start()
    const api = request(`http://127.0.0.1:${port}`)

    await api.get('/health/live').expect(200, { status: 'ok' })
    const readiness = await api.get('/health/ready').expect(503)
    expect(readiness.body).toMatchObject({
      error: { code: 'SERVICE_UNAVAILABLE' },
    })
    expect(JSON.stringify(readiness.body)).not.toContain('do-not-disclose')

    await runtime.stop()
    expect(end).toHaveBeenCalledOnce()
  })

  it('serves Prometheus text only on the configured private metrics port', async () => {
    const metricsPort = await freePort()
    const db = {
      connect: vi.fn(async () => {
        throw new Error('unavailable')
      }),
      end: vi.fn(async () => undefined),
    } as unknown as Database
    const runtime = createApiRuntime({
      config: {
        ...configuration(),
        metrics: { port: metricsPort, host: '127.0.0.1' },
      },
      database: db,
      drainTimeoutMs: 100,
      listenPort: 0,
      metricsSource: () => 'loremaster_api_requests_total 0\n',
    })
    const port = await runtime.start()
    try {
      const metrics = await request(`http://127.0.0.1:${metricsPort}`)
        .get('/metrics')
        .expect(200)
      expect(metrics.headers['content-type']).toContain('text/plain')
      expect(metrics.text).toContain('loremaster_api_requests_total 0')
      expect(metrics.text).toContain('process_resident_memory_bytes')
      await request(`http://127.0.0.1:${port}`).get('/metrics').expect(404)
    } finally {
      await runtime.stop()
    }
  })

  it('handles repeated termination signals with one graceful stop', async () => {
    const signals = new EventEmitter() as SignalSource & EventEmitter
    const stop = vi.fn(async () => undefined)
    const onStopped = vi.fn()
    const installed = installSignalHandlers({ stop }, { signals, onStopped })

    signals.emit('SIGTERM')
    signals.emit('SIGINT')
    await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(onStopped).toHaveBeenCalledOnce())
    installed.remove()
  })
})
