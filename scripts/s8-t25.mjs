import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { asterQuayContentPack } from '../packages/database/dist/content/fixtures/aster-quay.js'
import { createTestStack, writeSyntheticFixture } from './s8-test-stack.mjs'

const override = resolve('deploy/compose/t25.override.yaml')
const stack = createTestStack('t25', {
  files: [override],
  environment: { LOREMASTER_S8_COMPOSE_OVERRIDE: override },
})
const image = `loremaster/postgres-t25:${stack.project.slice(-8)}`
const clockFile = join(stack.temporary, 'clock')
const packFile = join(stack.temporary, 'pack.json')
stack.environment.LOREMASTER_T25_POSTGRES_IMAGE = image
stack.environment.LOREMASTER_T25_TIME_FILE = clockFile
stack.environment.LOREMASTER_S8_CONTENT_FILE = packFile
const day = new Date().toISOString().slice(0, 10)
const next = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000)
  .toISOString()
  .slice(0, 10)
const result = { project: stack.project, image, slot: day, passed: false }
const effects = [
  'attempts',
  'guesses',
  'command_receipts',
  'attempt_finalizations',
  'participation_days',
  'knowledge_contributions',
  'regional_knowledge',
  'leaderboard_entries',
]
function counts() {
  return Object.fromEntries(
    effects.map((table) => [
      table,
      Number(stack.sql(`SELECT count(*) FROM loremaster.${table};`)),
    ]),
  )
}
function clockMs() {
  return Number(
    stack.sql('SELECT (extract(epoch from clock_timestamp()) * 1000)::bigint;'),
  )
}

try {
  stack.docker('info')
  writeSyntheticFixture(clockFile, `@${day} 23:30:00\n`)
  writeSyntheticFixture(
    packFile,
    JSON.stringify({
      ...asterQuayContentPack,
      opensAt: `${day}T00:00:00.000Z`,
      closesAt: `${next}T00:00:00.000Z`,
      slotId: day,
    }),
  )
  stack.run('docker', [
    'build',
    '--pull=false',
    '-t',
    image,
    '-f',
    resolve('deploy/compose/t25-postgres.dockerfile'),
    stack.temporary,
  ])
  const inspection = JSON.parse(stack.docker('image', 'inspect', image))[0]
  assert(
    inspection.Config.Env.every((entry) => !entry.startsWith('LD_PRELOAD=')),
  )
  stack.wrapper('config')
  stack.wrapper('bootstrap')
  stack.wrapper('import', '--dry-run')
  stack.wrapper('import')
  const before = counts()
  assert(
    effects.every((table) => before[table] === 0),
    'T25 fixture began with effects',
  )
  stack.wrapper('start')
  for (const service of [
    'postgres',
    'redis',
    'api',
    'worker',
    'observer',
    'web',
  ])
    await stack.health(service)
  const mount = stack
    .inspect('postgres')
    .Mounts.find((entry) => entry.Destination === '/run/t25/clock')
  assert(mount && mount.RW === false, 'PostgreSQL clock control is writable')
  let runtimeCouldWrite = false
  try {
    stack.compose(
      'exec',
      '-T',
      '-u',
      '70',
      'postgres',
      'sh',
      '-c',
      'printf forbidden >> /run/t25/clock',
    )
    runtimeCouldWrite = true
  } catch {
    // Read-only mount must reject the runtime UID.
  }
  assert.equal(
    runtimeCouldWrite,
    false,
    'PostgreSQL runtime changed the test clock',
  )
  assert(
    stack
      .inspect('postgres')
      .Config.Env.includes('FAKETIME_DONT_FAKE_MONOTONIC=1'),
  )
  writeFileSync(clockFile, `@${day} 23:59:50\n`)
  assert(
    clockMs() < Date.parse(`${next}T00:00:00Z`),
    'Initial database time is already closed',
  )
  writeFileSync(clockFile, `@${next} 00:00:05\n`)
  await stack.until(
    'PostgreSQL clock crossed close',
    () => clockMs() > Date.parse(`${next}T00:00:00Z`),
    15_000,
  )
  result.closedClock = new Date(clockMs()).toISOString()
  // The API producer's scheduled reconciliation runs every 60 seconds.
  await delay(65_000)
  const after = counts()
  assert.deepEqual(
    after,
    before,
    'Scheduled observation synthesized gameplay effects',
  )
  result.effectsBefore = before
  result.effectsAfter = after
  result.passed = true
} catch (error) {
  result.error = error instanceof Error ? error.message : String(error)
  try {
    result.postgresLogs = stack
      .compose('logs', '--tail', '25', 'postgres')
      .slice(-3000)
  } catch {
    // A failed build has no PostgreSQL container.
  }
  process.exitCode = 1
} finally {
  try {
    stack.cleanup()
    result.teardown = 'PASS'
    stack.docker('image', 'rm', image)
  } catch (error) {
    result.teardown = error instanceof Error ? error.message : String(error)
    result.passed = false
    process.exitCode = 1
  }
  mkdirSync(resolve('.cache'), { recursive: true })
  writeFileSync(
    resolve('.cache/s8-t25.json'),
    JSON.stringify(result, null, 2) + '\n',
  )
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
}
