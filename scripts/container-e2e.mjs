import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import process from 'node:process'
import { asterQuayContentPack } from '../packages/database/dist/content/fixtures/aster-quay.js'
import { createTestStack, writeSyntheticFixture } from './s8-test-stack.mjs'

const override = resolve('deploy/compose/t25.override.yaml')
const stack = createTestStack('e2e', {
  files: [override],
  environment: { LOREMASTER_S8_COMPOSE_OVERRIDE: override },
})
const image = `loremaster/postgres-t25:${stack.project.slice(-8)}`
const clockFile = join(stack.temporary, 'clock')
const packFile = join(stack.temporary, 'pack.json')
stack.environment.LOREMASTER_T25_POSTGRES_IMAGE = image
stack.environment.LOREMASTER_T25_TIME_FILE = clockFile
stack.environment.LOREMASTER_S8_CONTENT_FILE = packFile
const first = new Date().toISOString().slice(0, 10)
const second = new Date(Date.parse(`${first}T00:00:00Z`) + 86_400_000)
  .toISOString()
  .slice(0, 10)
const third = new Date(Date.parse(`${second}T00:00:00Z`) + 86_400_000)
  .toISOString()
  .slice(0, 10)
const hostileMarker =
  'img src=//127.0.0.1:9/loremaster-hostile onerror=globalThis.__loremaster_xss=1'
const result = { project: stack.project, slot: first, passed: false }

try {
  stack.docker('info')
  writeSyntheticFixture(clockFile, `@${first} 12:00:00\n`)
  stack.run('docker', [
    'build',
    '--pull=false',
    '-t',
    image,
    '-f',
    resolve('deploy/compose/t25-postgres.dockerfile'),
    stack.temporary,
  ])
  stack.wrapper('bootstrap')
  const packs = [
    {
      ...asterQuayContentPack,
      opensAt: `${first}T00:00:00.000Z`,
      closesAt: `${second}T00:00:00.000Z`,
      slotId: first,
    },
    {
      ...asterQuayContentPack,
      stableKey: 'aster-quay-rollover',
      caseId: 'missing-ninth-bell-rollover',
      contentVersion: '1.0.1',
      briefing: `${asterQuayContentPack.briefing} ${hostileMarker}`,
      opensAt: `${second}T00:00:00.000Z`,
      closesAt: `${third}T00:00:00.000Z`,
      slotId: second,
    },
  ]
  for (const pack of packs) {
    writeSyntheticFixture(packFile, JSON.stringify(pack))
    stack.wrapper('import', '--dry-run')
    stack.wrapper('import')
  }
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
  assert.equal((await stack.gateway('/health/ready')).status, 200)
  const browserEnvironment = {
    ...stack.environment,
    LOREMASTER_E2E_FIRST_SLOT: first,
    LOREMASTER_E2E_SECOND_SLOT: second,
    LOREMASTER_E2E_CLOCK_FILE: clockFile,
    LOREMASTER_E2E_HOSTILE_MARKER: hostileMarker,
  }
  const test = stack.run(
    process.execPath,
    [
      'apps/web/node_modules/@playwright/test/cli.js',
      'test',
      '--config',
      'tests/containers/playwright.config.ts',
    ],
    undefined,
    browserEnvironment,
    600_000,
  )
  result.browserOutput = test.slice(-1000)
  result.passed = true
} catch (error) {
  result.error = error instanceof Error ? error.message : String(error)
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
    resolve('.cache/s8-e2e.json'),
    JSON.stringify(result, null, 2) + '\n',
  )
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
}
