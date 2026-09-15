import { EventEmitter } from 'node:events'

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
