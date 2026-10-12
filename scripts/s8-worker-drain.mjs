import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { asterQuayContentPack } from '../packages/database/dist/content/fixtures/aster-quay.js'
import { createTestStack } from './s8-test-stack.mjs'

const stack = createTestStack('worker-drain')
const packFile = join(stack.temporary, 'pack.json')
stack.environment.LOREMASTER_S8_CONTENT_FILE = packFile
const day = new Date().toISOString().slice(0, 10)
const next = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000)
  .toISOString()
  .slice(0, 10)
const result = { project: stack.project, passed: false }
let lock

function metric(name) {
  const response = stack.serviceHttp('observer', '/metrics')
  assert.equal(response.status, 200)
  const value = response.body.match(
    new RegExp(
      `^loremaster_queue_${name}\\{queue="loremaster-warm-v1",version="1"\\} (\\d+)$`,
      'mu',
    ),
  )?.[1]
  assert(value !== undefined, `Missing ${name} metric`)
  return Number(value)
}
function lockCount() {
  return Number(
    stack.sql(
      "SELECT count(*) FROM pg_locks l JOIN pg_class relation ON relation.oid=l.relation WHERE relation.relname='case_entities' AND l.mode='AccessExclusiveLock' AND l.granted;",
    ),
  )
}
async function releaseLock() {
  if (!lock) return
  if (lock.exitCode === null) {
    lock.stdin.write('COMMIT;\n')
    lock.stdin.end()
    await Promise.race([
      new Promise((resolveExit) => lock.once('exit', resolveExit)),
      delay(5_000),
    ])
  }
  if (lock.exitCode === null) lock.kill()
  lock = undefined
}

try {
  stack.docker('info')
  writeFileSync(
    packFile,
    JSON.stringify({
      ...asterQuayContentPack,
      opensAt: `${day}T00:00:00.000Z`,
      closesAt: `${next}T00:00:00.000Z`,
      slotId: day,
    }),
    { mode: 0o600 },
  )
  stack.wrapper('bootstrap')
  stack.wrapper('import')
  assert.equal(
    Number(
      stack.sql(
        "SELECT count(*) FROM loremaster.case_revisions WHERE status='PUBLISHED';",
      ),
    ),
    1,
  )
  stack.compose('up', '-d', 'api', 'observer')
  await stack.health('api')
  await stack.health('observer')
  const args = [
    'compose',
    '-p',
    stack.project,
    ...stack.files.flatMap((file) => ['-f', file]),
    'exec',
    '-T',
    'postgres',
    'psql',
    '-X',
    '-q',
    '-v',
    'ON_ERROR_STOP=1',
    '-U',
    'migration',
    '-d',
    'loremaster',
  ]
  lock = spawn('docker', args, {
    env: stack.environment,
    stdio: ['pipe', 'ignore', 'pipe'],
  })
  lock.stdin.write(
    'BEGIN; LOCK TABLE loremaster.case_entities IN ACCESS EXCLUSIVE MODE;\n',
  )
  await stack.until(
    'held worker-read table lock',
    () => lockCount() === 1,
    15_000,
  )
  stack.compose('up', '-d', 'worker')
  await stack.health('worker')
  await stack.until(
    'active warm job blocked by PostgreSQL',
    () => metric('active') > 0,
    20_000,
  )
  const workerId = stack.inspect('worker').Id
  const started = performance.now()
  stack.compose('stop', '-t', '15', 'worker')
  const drainMs = Math.round(performance.now() - started)
  const stopped = JSON.parse(stack.docker('inspect', workerId))[0]
  assert.equal(stopped.State.ExitCode, 0)
  assert(!stopped.State.OOMKilled)
  assert(drainMs <= 16_000, `Active worker drain took ${drainMs} ms`)
  await releaseLock()
  stack.compose('start', 'worker')
  const recoveryMs = await stack.health('worker')
  assert.equal(stack.inspect('worker').Id, workerId)
  const replayMs = await stack.until(
    'warm job replay',
    () => metric('completed') >= 1,
    45_000,
  )
  assert.equal(
    Number(stack.sql('SELECT count(*) FROM loremaster.attempts;')),
    0,
  )
  result.drainMs = drainMs
  result.recoveryMs = recoveryMs
  result.replayMs = replayMs
  result.completed = metric('completed')
  result.passed = true
} catch (error) {
  result.error = error instanceof Error ? error.message : String(error)
  process.exitCode = 1
} finally {
  try {
    await releaseLock()
  } catch {
    result.passed = false
    process.exitCode = 1
  }
  try {
    stack.cleanup()
    result.teardown = 'PASS'
  } catch (error) {
    result.teardown = error instanceof Error ? error.message : String(error)
    result.passed = false
    process.exitCode = 1
  }
  mkdirSync(resolve('.cache'), { recursive: true })
  writeFileSync(
    resolve('.cache/s8-worker-drain.json'),
    JSON.stringify(result, null, 2) + '\n',
  )
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
}
