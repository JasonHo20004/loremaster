import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { globSync } from 'node:fs'
import process, { env, execPath, stderr } from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { URL } from 'node:url'

const POSTGRES_IMAGE =
  'postgres:17.6-alpine@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94'
const containerName = `loremaster-db-test-${randomUUID()}`
const password = randomUUID()
const target = process.argv[2] ?? 'database'
let started = false

if (target !== 'database' && target !== 'api') {
  throw new Error('Database test target must be `database` or `api`')
}

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

  const projects =
    target === 'api'
      ? [
          'packages/domain/tsconfig.json',
          'packages/database/tsconfig.json',
          'packages/config/tsconfig.json',
          'packages/contracts/tsconfig.json',
          'packages/observability/tsconfig.json',
          'apps/api/tsconfig.json',
        ]
      : ['packages/domain/tsconfig.json', 'packages/database/tsconfig.json']
  for (const project of projects) {
    run(execPath, ['node_modules/typescript/bin/tsc', '-p', project], {
      stdio: 'inherit',
    })
  }

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
  let runtimeConnectionString
  try {
    const applied = await migrateToLatest(db)
    if (applied.length === 0)
      throw new Error('Clean database applied no migrations')

    const runtimeLogin = `loremaster_test_runtime_${randomUUID().replaceAll('-', '')}`
    const runtimePassword = randomUUID()
    const statement = await db.query(
      `SELECT format(
         'CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT',
         $1::text, $2::text
       ) AS sql`,
      [runtimeLogin, runtimePassword],
    )
    if (typeof statement.rows[0]?.sql !== 'string')
      throw new Error('Runtime login statement was not generated')
    await db.query(statement.rows[0].sql)
    const grant = await db.query(
      "SELECT format('GRANT loremaster_runtime TO %I', $1::text) AS sql",
      [runtimeLogin],
    )
    if (typeof grant.rows[0]?.sql !== 'string')
      throw new Error('Runtime role grant was not generated')
    await db.query(grant.rows[0].sql)
    const runtimeUrl = new URL(connectionString)
    runtimeUrl.username = runtimeLogin
    runtimeUrl.password = runtimePassword
    runtimeConnectionString = runtimeUrl.toString()
  } finally {
    await closeDatabase(db)
  }

  if (runtimeConnectionString === undefined)
    throw new Error('Runtime database login was not created')
  await waitForDatabase(runtimeConnectionString)

  const testFiles =
    target === 'database'
      ? ['tests/database']
      : globSync('tests/api/**/*.database.test.ts').sort()
  if (testFiles.length === 0)
    throw new Error(`No ${target} database tests were found`)
  const result = spawnSync(
    execPath,
    ['node_modules/vitest/vitest.mjs', 'run', ...testFiles],
    {
      stdio: 'inherit',
      env: {
        ...env,
        LOREMASTER_TEST_DATABASE_URL: connectionString,
        LOREMASTER_TEST_RUNTIME_DATABASE_URL: runtimeConnectionString,
      },
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
