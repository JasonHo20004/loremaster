import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { URL } from 'node:url'

const require = createRequire(
  new URL('../packages/cache/package.json', import.meta.url),
)
const Redis = require('ioredis')
const image =
  'redis:7.4.5-alpine@sha256:bb186d083732f669da90be8b0f975a37812b15e913465bb14d845db72a4e3e08'
const name = `loremaster-redis-test-${randomUUID()}`
let started = false
try {
  execFileSync('docker', ['info'], { stdio: 'pipe' })
  execFileSync(
    'docker',
    [
      'run',
      '--detach',
      '--rm',
      '--name',
      name,
      '--publish',
      '127.0.0.1::6379',
      image,
      'redis-server',
      '--save',
      '',
      '--appendonly',
      'no',
      '--maxmemory',
      '128mb',
      '--maxmemory-policy',
      'noeviction',
    ],
    { stdio: 'pipe' },
  )
  started = true
  const port = execFileSync('docker', ['port', name, '6379/tcp'], {
    encoding: 'utf8',
  })
    .trim()
    .match(/:(\d+)$/u)?.[1]
  if (!port) throw new Error('Redis test port unavailable')
  const url = `redis://127.0.0.1:${port}`
  let ready = false
  for (let attempt = 0; attempt < 60; attempt++) {
    const client = new Redis(url, {
      lazyConnect: true,
      connectTimeout: 500,
      retryStrategy: () => null,
    })
    try {
      await client.ping()
      ready = true
      client.disconnect()
      break
    } catch {
      client.disconnect()
      await delay(250)
    }
  }
  if (!ready) throw new Error('Redis test instance did not become ready')
  const result = spawnSync(
    process.execPath,
    [
      'node_modules/vitest/vitest.mjs',
      'run',
      'tests/redis/runtime.integration.test.ts',
    ],
    {
      env: { ...process.env, LOREMASTER_TEST_REDIS_URL: url },
      stdio: 'inherit',
    },
  )
  if (result.status !== 0) process.exitCode = result.status ?? 1
} finally {
  if (started) execFileSync('docker', ['stop', name], { stdio: 'pipe' })
}
