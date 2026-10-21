import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, URL } from 'node:url'
import {
  assertFreshSecretVolume,
  validateContentFile,
} from './s8-compose-inputs.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const composeFile = resolve(root, 'deploy/compose/compose.yaml')
const overrideFile = process.env.LOREMASTER_S8_COMPOSE_OVERRIDE
if (overrideFile && !isAbsolute(overrideFile))
  throw Error('LOREMASTER_S8_COMPOSE_OVERRIDE must be an absolute path')
const project = process.env.LOREMASTER_S8_PROJECT ?? 'loremaster-s8'
const secretDir = resolve(
  process.env.LOREMASTER_S8_SECRET_DIR ??
    resolve(root, 'deploy/compose/local-secrets'),
)
const composeEnv = { ...process.env, LOREMASTER_S8_SECRET_DIR: secretDir }
const command = process.argv[2]
const secretNames = [
  'postgres_password',
  'redis_acl',
  'migration_database_url',
  'importer_database_url',
  'api_database_url',
  'producer_database_url',
  'worker_database_url',
  'cursor_key',
  'limiter_hmac_key',
  'redis_api_cache_url',
  'redis_api_limiter_url',
  'redis_producer_url',
  'redis_worker_url',
  'redis_worker_cache_url',
  'redis_observer_url',
]
if (!/^[a-z][a-z0-9-]{2,48}$/u.test(project))
  throw Error('LOREMASTER_S8_PROJECT must be a short lowercase project name')

function run(executable, args, options = {}) {
  const { redact = false, showOutput = false, ...spawnOptions } = options
  const result = spawnSync(executable, args, {
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 4 * 1024 * 1024,
    env: composeEnv,
    ...spawnOptions,
  })
  if (result.error)
    throw Error(`${executable} could not start: ${result.error.code}`)
  if (result.status !== 0)
    throw Error(
      `${executable} ${args.slice(0, 3).join(' ')} failed${redact ? '' : `: ${result.stderr.trim().slice(-1500)}${showOutput ? result.stdout.trim().slice(-1000) : ''}`}`,
    )
  return result.stdout.trim()
}
function compose(args, options) {
  return run(
    'docker',
    [
      'compose',
      '-p',
      project,
      '-f',
      composeFile,
      ...(overrideFile ? ['-f', overrideFile] : []),
      ...args,
    ],
    options,
  )
}
function password() {
  return randomBytes(32).toString('base64url')
}
function acl() {
  const { roles } = JSON.parse(
    readFileSync(resolve(root, 'ops/redis/acl-policy.json'), 'utf8'),
  )
  const { scripts } = JSON.parse(
    readFileSync(
      resolve(root, 'ops/redis/bullmq-script-inventory.json'),
      'utf8',
    ),
  )
  const entries = [
    `user default off >${password()} -@all`,
    'user loremaster_health on nopass -@all +ping',
  ]
  const urls = {}
  for (const [role, rule] of Object.entries(roles)) {
    const credential = password()
    const commands = new Set([
      'auth',
      'hello',
      'ping',
      'quit',
      'client|setname',
      'client|setinfo',
      ...rule.commands,
    ])
    for (const script of Object.values(scripts))
      if (script.roles.includes(rule.bullmqRole))
        for (const operation of script.commands) commands.add(operation)
    entries.push(
      [
        'user',
        role,
        'reset',
        'on',
        `>${credential}`,
        ...rule.patterns,
        ...[...commands].map((operation) => `+${operation}`),
      ].join(' '),
    )
    urls[role] = `redis://${role}:${credential}@redis:6379`
  }
  return { file: entries.join('\n') + '\n', urls }
}
function expectedSecrets() {
  const pgPassword = password()
  const db = (login, credential) =>
    `postgresql://${login}:${credential}@postgres:5432/loremaster`
  const redis = acl()
  return {
    postgres_password: pgPassword,
    redis_acl: redis.file,
    migration_database_url: db('migration', pgPassword),
    importer_database_url: db('importer', password()),
    api_database_url: db('api', password()),
    producer_database_url: db('producer', password()),
    worker_database_url: db('worker', password()),
    cursor_key: password(),
    limiter_hmac_key: password(),
    redis_api_cache_url: redis.urls.loremaster_api_cache,
    redis_api_limiter_url: redis.urls.loremaster_api_limiter,
    redis_producer_url: redis.urls.loremaster_producer,
    redis_worker_url: redis.urls.loremaster_worker,
    redis_worker_cache_url: redis.urls.loremaster_worker_cache,
    redis_observer_url: redis.urls.loremaster_observer,
  }
}
function verifySecrets() {
  if (!existsSync(secretDir) || lstatSync(secretDir).isSymbolicLink())
    throw Error('Secret directory is missing or is a symlink; run bootstrap')
  for (const name of secretNames) {
    const path = resolve(secretDir, name)
    if (!existsSync(path) || !lstatSync(path).isFile())
      throw Error(`Missing secret file: ${name}`)
    const bytes = readFileSync(path)
    if (!bytes.length || bytes.includes(0))
      throw Error(`Invalid secret file: ${name}`)
  }
}
function initializeSecrets() {
  if (existsSync(secretDir)) return verifySecrets()
  // Reusing a data volume with new credentials strands PostgreSQL and Redis.
  assertFreshSecretVolume(project, (args) => run('docker', args))
  const temporary = `${secretDir}.${process.pid}.tmp`
  mkdirSync(temporary, { recursive: true, mode: 0o700 })
  try {
    for (const [name, value] of Object.entries(expectedSecrets())) {
      const path = resolve(temporary, name)
      writeFileSync(path, value, { flag: 'wx', mode: 0o444 })
      chmodSync(path, 0o444)
    }
    renameSync(temporary, secretDir)
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true })
    throw error
  }
  verifySecrets()
}
function health(service) {
  const id = compose(['ps', '-q', service])
  if (!id) return false
  return (
    run('docker', ['inspect', '-f', '{{.State.Health.Status}}', id]) ===
    'healthy'
  )
}
async function waitHealth(service) {
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    if (health(service)) return
    await delay(500)
  }
  throw Error(
    `${service} did not become healthy within 60 seconds; inspect its Compose logs`,
  )
}
function provisionRoles() {
  const roles = [
    ['api', 'loremaster_runtime', 'api_database_url'],
    ['producer', 'loremaster_cache_producer', 'producer_database_url'],
    ['worker', 'loremaster_cache_worker', 'worker_database_url'],
    ['importer', 'loremaster_importer', 'importer_database_url'],
  ]
  let sql = ''
  for (const [login, group, file] of roles) {
    const credential = new URL(readFileSync(resolve(secretDir, file), 'utf8'))
      .password
    if (!/^[a-zA-Z0-9_-]{43}$/u.test(credential))
      throw Error(`Invalid generated credential: ${file}`)
    sql += `DO $role$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${login}') THEN CREATE ROLE ${login} LOGIN PASSWORD '${credential}' NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS; END IF; END $role$;\n`
    sql += `GRANT ${group} TO ${login};\n`
  }
  compose(
    [
      'exec',
      '-T',
      'postgres',
      'psql',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'migration',
      '-d',
      'loremaster',
    ],
    { input: sql, redact: true },
  )
}

try {
  switch (command) {
    case 'config':
      compose(['config', '--quiet'])
      break
    case 'bootstrap':
      initializeSecrets()
      compose(['--profile', 'bootstrap', 'run', '--rm', '-T', 'credentials'])
      compose(['up', '-d', 'postgres', 'redis'])
      await waitHealth('postgres')
      await waitHealth('redis')
      compose(['--profile', 'operator', 'run', '--rm', '-T', 'migration'])
      provisionRoles()
      writeFileSync(resolve(secretDir, '.bootstrapped'), 's8\n', {
        mode: 0o600,
      })
      process.stdout.write(`Bootstrapped ${project}\n`)
      break
    case 'start':
      verifySecrets()
      if (!existsSync(resolve(secretDir, '.bootstrapped')))
        throw Error('Run bootstrap before start')
      compose([
        'up',
        '-d',
        'postgres',
        'redis',
        'api',
        'worker',
        'observer',
        'web',
      ])
      process.stdout.write(`Started ${project}\n`)
      break
    case 'status':
      process.stdout.write(compose(['ps']) + '\n')
      break
    case 'logs':
      process.stdout.write(
        compose(['logs', '--tail', '100', ...process.argv.slice(3)]) + '\n',
      )
      break
    case 'stop':
      compose(['down', '--remove-orphans'])
      process.stdout.write(`Stopped ${project}; volumes retained\n`)
      break
    case 'import': {
      verifySecrets()
      if (!process.env.LOREMASTER_S8_CONTENT_FILE)
        throw Error('Set LOREMASTER_S8_CONTENT_FILE to a reviewed pack.json')
      validateContentFile(process.env.LOREMASTER_S8_CONTENT_FILE)
      compose(['--profile', 'operator', 'run', '--rm', '-T', 'content'])
      process.stdout.write(
        compose(
          [
            '--profile',
            'operator',
            'run',
            '--rm',
            '-T',
            'importer',
            ...process.argv.slice(3),
          ],
          { showOutput: true },
        ) + '\n',
      )
      break
    }
    default:
      throw Error(
        'Usage: node scripts/s8-compose.mjs <config|bootstrap|start|status|logs|stop|import>',
      )
  }
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  )
  process.exitCode = 1
}
