import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import process, { env, execPath, stderr } from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'

const POSTGRES_IMAGE =
  'postgres:17.6-alpine@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94'
const containerName = `loremaster-db-test-${randomUUID()}`
const password = randomUUID()
let started = false

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: 'pipe',
    ...options,
  })
}

async function waitForDatabase(connectionString) {
  const { database, closeDatabase } =
    await import('../packages/database/dist/index.js')
  const deadline = Date.now() + 30_000
  let lastError
  while (Date.now() < deadline) {
    const db = database(connectionString)
    try {
      await db.query('SELECT 1')
      await closeDatabase(db)
      return
    } catch (error) {
      lastError = error
      await closeDatabase(db).catch(() => undefined)
      await delay(250)
    }
  }
  throw new Error('PostgreSQL did not become ready within 30 seconds', {
    cause: lastError,
  })
}

try {
  try {
    run('docker', ['info'])
  } catch (error) {
    throw new Error(
      'Database tests require a running Docker daemon. Start Docker and retry `pnpm test:database`.',
      { cause: error },
    )
  }

  run(
    execPath,
    [
      'node_modules/typescript/bin/tsc',
      '-p',
      'packages/database/tsconfig.json',
    ],
    { stdio: 'inherit' },
  )

  run('docker', [
    'run',
    '--detach',
    '--rm',
    '--name',
    containerName,
    '--env',
    'POSTGRES_DB=loremaster_test',
    '--env',
    'POSTGRES_USER=loremaster_migration',
    '--env',
    `POSTGRES_PASSWORD=${password}`,
    '--publish',
    '127.0.0.1::5432',
    POSTGRES_IMAGE,
  ])
  started = true

  const portOutput = run('docker', ['port', containerName, '5432/tcp']).trim()
  const port = portOutput.match(/:(\d+)$/)?.[1]
  if (port === undefined)
    throw new Error('Docker did not publish PostgreSQL port 5432')

  const connectionString = `postgresql://loremaster_migration:${password}@127.0.0.1:${port}/loremaster_test`
  await waitForDatabase(connectionString)

  const { database, closeDatabase, migrateToLatest } =
    await import('../packages/database/dist/index.js')
  const db = database(connectionString)
  try {
    const applied = await migrateToLatest(db)
    if (applied.length === 0)
      throw new Error('Clean database applied no migrations')
  } finally {
    await closeDatabase(db)
  }

  const result = spawnSync(
    execPath,
    ['node_modules/vitest/vitest.mjs', 'run', 'tests/database'],
    {
      stdio: 'inherit',
      env: { ...env, LOREMASTER_TEST_DATABASE_URL: connectionString },
    },
  )
  if (result.error !== undefined) throw result.error
  process.exitCode = result.status ?? 1
} catch (error) {
  stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
} finally {
  if (started) {
    try {
      run('docker', ['rm', '--force', containerName])
    } catch {
      stderr.write(
        `Failed to remove disposable database container ${containerName}\n`,
      )
      process.exitCode = 1
    }
  }
}
