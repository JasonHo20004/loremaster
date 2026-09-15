import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createApiRuntime, type ApiRuntime } from '../../apps/api/src/server.js'
import { parseServerEnvironment } from '../../packages/config/src/index.js'
import { database } from '../../packages/database/src/migrate.js'

const connectionString = process.env.LOREMASTER_TEST_RUNTIME_DATABASE_URL
if (connectionString === undefined) {
  throw new Error(
    'LOREMASTER_TEST_RUNTIME_DATABASE_URL is required; run `pnpm test:api:database`',
  )
}

const origin = 'http://localhost:5173'
let runtime: ApiRuntime
let api: ReturnType<typeof request.agent>

beforeAll(async () => {
  const config = parseServerEnvironment({
    LOREMASTER_API_MODE: 'local',
    DATABASE_URL: connectionString,
    LOREMASTER_API_ORIGIN: origin,
    LOREMASTER_API_CURSOR_ACTIVE_VERSION: 'integration',
    LOREMASTER_API_CURSOR_ACTIVE_KEY: Buffer.alloc(32, 0x33).toString(
      'base64url',
    ),
  })
  runtime = createApiRuntime({
    config,
    database: database(connectionString),
    listenPort: 0,
  })
  const port = await runtime.start()
  api = request.agent(`http://127.0.0.1:${port}`)
})

afterAll(async () => runtime.stop())

describe('S5.6 composed API with least-privilege PostgreSQL', () => {
  it('becomes ready, bootstraps a session, and exercises authenticated gameplay', async () => {
    await api.get('/health/live').expect(200, { status: 'ok' })
    await api.get('/health/ready').expect(200, { status: 'ready' })

    const created = await api
      .post('/api/v1/session')
      .set('Origin', origin)
      .send({})
      .expect(201)
    expect(created.body.data.expiresAt).toMatch(/Z$/u)
    const setCookies = created.headers['set-cookie']
    expect(setCookies).toHaveLength(2)
    const csrfCookie = setCookies?.find((value: string) =>
      value.startsWith('loremaster_local_csrf='),
    )
    const csrfToken = /^loremaster_local_csrf=([^;]+)/u.exec(
      csrfCookie ?? '',
    )?.[1]
    expect(csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/u)

    await api.get('/api/v1/session').expect(200, created.body)
    const profile = await api.get('/api/v1/profile').expect(200)
    expect(profile.body.data).toMatchObject({
      currentStreak: 0,
      longestStreak: 0,
      solvedCount: 0,
      failedCount: 0,
      accuracyPercentage: 0,
    })
    expect(profile.body.data.regionalKnowledge).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          regionId: 'aster-quay',
          sampleCount: 0,
        }),
      ]),
    )
  })
})
