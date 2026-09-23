import { execFileSync, spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, URL } from 'node:url'

const POSTGRES_IMAGE =
  'postgres:17.6-alpine@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94'
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const containerName = `loremaster-web-e2e-${randomUUID()}`
const password = randomUUID()
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'loremaster-web-e2e-'))
const children = []
let containerStarted = false
let cleanupPromise

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: 'pipe',
    ...options,
  })
}

function runVisible(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: repositoryRoot,
    stdio: 'inherit',
    ...options,
  })
  children.push(child)
  return new Promise((resolveRun, rejectRun) => {
    child.once('error', rejectRun)
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolveRun()
        return
      }
      rejectRun(
        new Error(
          `${command} failed${signal === null ? ` with exit code ${code}` : ` from ${signal}`}`,
        ),
      )
    })
  })
}

async function availablePort() {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('Could not reserve a loopback port')
  }
  await new Promise((resolve) => server.close(resolve))
  return address.port
}

async function waitFor(url, label) {
  const deadline = Date.now() + 60_000
  let lastError
  while (Date.now() < deadline) {
    try {
      const response = await globalThis.fetch(url)
      if (response.ok) return
      lastError = new Error(`${label} returned ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await delay(200)
  }
  throw new Error(`${label} did not become ready`, { cause: lastError })
}

async function stopChild(child) {
  if (child.exitCode !== null) return
  if (process.platform === 'win32') {
    try {
      run('taskkill', ['/pid', String(child.pid), '/t', '/f'])
    } catch {
      // The process may have exited between the check and taskkill.
    }
    return
  }
  const exited = new Promise((resolveExit) => child.once('exit', resolveExit))
  child.kill('SIGTERM')
  await Promise.race([exited, delay(5_000)])
  if (child.exitCode === null) child.kill('SIGKILL')
}

function cleanup() {
  cleanupPromise ??= (async () => {
    for (const child of children.reverse()) await stopChild(child)
    if (containerStarted) {
      try {
        run('docker', ['rm', '--force', containerName])
      } catch {
        process.stderr.write(`Failed to remove ${containerName}\n`)
        process.exitCode = 1
      }
    }
    await rm(temporaryDirectory, { recursive: true, force: true })
  })()
  return cleanupPromise
}

const signalHandlers = new Map(
  [
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ].map(([signal, exitCode]) => [
    signal,
    () => {
      void cleanup().then(
        () => process.exit(exitCode),
        (error) => {
          process.stderr.write(
            `E2E cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`,
          )
          process.exit(1)
        },
      )
    },
  ]),
)
for (const [signal, handler] of signalHandlers) process.once(signal, handler)

function utcSlot(offsetDays) {
  const date = new Date()
  date.setUTCDate(date.getUTCDate() + offsetDays)
  return date.toISOString().slice(0, 10)
}

try {
  try {
    run('docker', ['info'])
  } catch (error) {
    throw new Error(
      'Web E2E tests require a running Docker daemon. Start Docker and retry `pnpm test:web:e2e`.',
      { cause: error },
    )
  }

  for (const project of [
    'packages/domain/tsconfig.json',
    'packages/database/tsconfig.json',
    'packages/config/tsconfig.json',
    'packages/contracts/tsconfig.json',
    'packages/observability/tsconfig.json',
    'apps/api/tsconfig.json',
  ]) {
    await runVisible(process.execPath, [
      'node_modules/typescript/bin/tsc',
      '-p',
      project,
    ])
  }

  run(
    'docker',
    [
      'run',
      '--detach',
      '--rm',
      '--name',
      containerName,
      '--env',
      'POSTGRES_DB=loremaster_e2e',
      '--env',
      'POSTGRES_USER=loremaster_migration',
      '--env',
      'POSTGRES_PASSWORD',
      '--publish',
      '127.0.0.1::5432',
      POSTGRES_IMAGE,
    ],
    { env: { ...process.env, POSTGRES_PASSWORD: password } },
  )
  containerStarted = true
  const databasePort = run('docker', ['port', containerName, '5432/tcp'])
    .trim()
    .match(/:(\d+)$/u)?.[1]
  if (databasePort === undefined)
    throw new Error('PostgreSQL port was not published')
  const migrationUrl = `postgresql://loremaster_migration:${password}@127.0.0.1:${databasePort}/loremaster_e2e`

  const { closeDatabase, database, migrateToLatest } =
    await import('../packages/database/dist/index.js')
  const migrationDatabase = database(migrationUrl)
  let runtimeUrl
  try {
    const deadline = Date.now() + 30_000
    while (true) {
      try {
        await migrationDatabase.query('SELECT 1')
        break
      } catch (error) {
        if (Date.now() >= deadline) throw error
        await delay(200)
      }
    }
    const applied = await migrateToLatest(migrationDatabase)
    if (applied.length === 0)
      throw new Error('Clean database applied no migrations')
    const login = `loremaster_e2e_${randomUUID().replaceAll('-', '')}`
    const runtimePassword = randomUUID()
    const createRole = await migrationDatabase.query(
      `SELECT format('CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT', $1::text, $2::text) AS sql`,
      [login, runtimePassword],
    )
    await migrationDatabase.query(createRole.rows[0].sql)
    const grant = await migrationDatabase.query(
      "SELECT format('GRANT loremaster_runtime TO %I', $1::text) AS sql",
      [login],
    )
    await migrationDatabase.query(grant.rows[0].sql)
    const url = new URL(migrationUrl)
    url.username = login
    url.password = runtimePassword
    runtimeUrl = url.toString()
  } finally {
    await closeDatabase(migrationDatabase)
  }

  const firstSlot = utcSlot(0)
  const secondSlot = utcSlot(1)
  const { asterQuayContentPack } =
    await import('../packages/database/dist/content/fixtures/aster-quay.js')
  const firstPack = {
    ...asterQuayContentPack,
    opensAt: `${firstSlot}T00:00:00.000Z`,
    closesAt: `${secondSlot}T00:00:00.000Z`,
    slotId: firstSlot,
  }
  const hostileMarker =
    'img src=//127.0.0.1:9/loremaster-hostile onerror=globalThis.__loremaster_xss=1'
  const rawHostileMarker =
    '<img src="http://127.0.0.1:9/loremaster-hostile" onerror="globalThis.__loremaster_xss=1"><script>globalThis.__loremaster_xss=1</script>'
  const thirdSlot = utcSlot(2)
  const secondPack = {
    ...asterQuayContentPack,
    stableKey: 'aster-quay-rollover',
    caseId: 'missing-ninth-bell-rollover',
    revisionNumber: 1,
    contentVersion: '1.0.1',
    briefing: `${asterQuayContentPack.briefing} ${hostileMarker}`,
    opensAt: `${secondSlot}T00:00:00.000Z`,
    closesAt: `${thirdSlot}T00:00:00.000Z`,
    slotId: secondSlot,
  }
  for (const [name, pack] of [
    ['current.json', firstPack],
    ['rollover.json', secondPack],
  ]) {
    const path = join(temporaryDirectory, name)
    await writeFile(path, JSON.stringify(pack), {
      encoding: 'utf8',
      mode: 0o600,
    })
    await runVisible(
      process.execPath,
      ['packages/database/dist/content/cli.js', '--file', path],
      {
        env: { ...process.env, LOREMASTER_IMPORT_DATABASE_URL: migrationUrl },
      },
    )
  }

  const apiPort = await availablePort()
  const webPort = await availablePort()
  const accessibilityPort = await availablePort()
  const controlToken = randomBytes(32).toString('base64url')
  const apiOrigin = `http://127.0.0.1:${apiPort}`
  const webOrigin = `http://127.0.0.1:${webPort}`
  const apiEnvironment = {
    ...process.env,
    DATABASE_URL: runtimeUrl,
    LOREMASTER_API_MODE: 'local',
    LOREMASTER_API_ORIGIN: webOrigin,
    LOREMASTER_API_CURSOR_ACTIVE_VERSION: 'e2e-v1',
    LOREMASTER_API_CURSOR_ACTIVE_KEY: randomBytes(32).toString('base64url'),
    LOREMASTER_E2E_ADMIN_DATABASE_URL: migrationUrl,
    LOREMASTER_E2E_CONTROL_TOKEN: controlToken,
    LOREMASTER_E2E_DISPOSABLE: 'true',
    LOREMASTER_E2E_FIRST_SLOT: firstSlot,
    LOREMASTER_E2E_RAW_HOSTILE_MARKER: rawHostileMarker,
    PORT: String(apiPort),
  }
  const api = spawn(process.execPath, ['scripts/web-e2e-api.mjs'], {
    cwd: repositoryRoot,
    env: apiEnvironment,
    stdio: 'inherit',
  })
  children.push(api)
  await waitFor(`${apiOrigin}/__e2e/ready`, 'E2E API')

  await runVisible(process.execPath, [
    'node_modules/typescript/bin/tsc',
    '-b',
    'apps/web/tsconfig.json',
  ])
  await runVisible(
    process.execPath,
    ['node_modules/vite/bin/vite.js', 'build'],
    {
      cwd: resolve(repositoryRoot, 'apps/web'),
      env: { ...process.env, VITE_API_BASE_URL: `${apiOrigin}/api/v1` },
    },
  )
  const web = spawn(
    process.execPath,
    [
      resolve(repositoryRoot, 'apps/web/node_modules/vite/bin/vite.js'),
      'preview',
      '--host',
      '127.0.0.1',
      '--port',
      String(webPort),
    ],
    { cwd: resolve(repositoryRoot, 'apps/web'), stdio: 'inherit' },
  )
  children.push(web)
  await waitFor(webOrigin, 'web preview')

  await runVisible(
    process.execPath,
    [
      'apps/web/node_modules/@playwright/test/cli.js',
      'test',
      '--config',
      'tests/web/playwright.config.ts',
    ],
    {
      env: {
        ...process.env,
        LOREMASTER_E2E_API_ORIGIN: apiOrigin,
        LOREMASTER_E2E_BASE_URL: webOrigin,
        LOREMASTER_E2E_CONTROL_ORIGIN: apiOrigin,
        LOREMASTER_E2E_CONTROL_TOKEN: controlToken,
        LOREMASTER_E2E_FIRST_SLOT: firstSlot,
        LOREMASTER_E2E_SECOND_SLOT: secondSlot,
        LOREMASTER_E2E_HOSTILE_MARKER: hostileMarker,
        LOREMASTER_E2E_RAW_HOSTILE_MARKER: rawHostileMarker,
      },
    },
  )
  await runVisible(
    process.execPath,
    [
      'apps/web/node_modules/@playwright/test/cli.js',
      'test',
      '--config',
      'apps/web/playwright.config.ts',
    ],
    {
      env: {
        ...process.env,
        LOREMASTER_WEB_TEST_PORT: String(accessibilityPort),
      },
    },
  )
} finally {
  await cleanup()
  for (const [signal, handler] of signalHandlers) process.off(signal, handler)
}
