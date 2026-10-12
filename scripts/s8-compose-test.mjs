import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { URL } from 'node:url'

const scope = process.argv[2]
if (!['data', 'compose'].includes(scope))
  throw Error('Expected data or compose')
const project = `loremaster-s8-test-${randomUUID().slice(0, 8)}`
const temporary = mkdtempSync(join(tmpdir(), `${project}-`))
const secrets = join(temporary, 'secrets')
const manifest = resolve('deploy/compose/compose.yaml')
const environment = {
  ...process.env,
  LOREMASTER_S8_PROJECT: project,
  LOREMASTER_S8_SECRET_DIR: secrets,
}
function run(executable, args, options = {}) {
  const { showOutput = false, ...spawnOptions } = options
  const result = spawnSync(executable, args, {
    encoding: 'utf8',
    timeout: 180000,
    maxBuffer: 8 * 1024 * 1024,
    env: environment,
    ...spawnOptions,
  })
  if (result.error) throw result.error
  if (result.status !== 0)
    throw Error(
      `${executable} ${args.slice(0, 3).join(' ')} failed: ${result.stderr.slice(-1000)}${showOutput ? result.stdout.slice(-500) : ''}`,
    )
  return result.stdout.trim()
}
function compose(args, options) {
  return run(
    'docker',
    ['compose', '-p', project, '-f', manifest, ...args],
    options,
  )
}
function serviceId(service) {
  return compose(['ps', '-q', service])
}
function inspect(service) {
  return JSON.parse(run('docker', ['inspect', serviceId(service)]))[0]
}
async function healthy(service) {
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    try {
      if (inspect(service).State.Health.Status === 'healthy') return
    } catch {
      // Startup is still in progress.
    }
    await delay(500)
  }
  throw Error(`${service} did not become healthy`)
}
function secret(name) {
  return readFileSync(join(secrets, name), 'utf8')
}
function redis(commands) {
  return compose(
    [
      'exec',
      '-T',
      'redis',
      'redis-cli',
      '--user',
      'loremaster_health',
      '--pass',
      '',
      '--raw',
    ],
    {
      input: commands.join('\n') + '\n',
    },
  )
}
function credential(name) {
  return new URL(secret(name)).password
}
function http(path) {
  return new Promise((resolveResult, reject) => {
    const call = request(
      { hostname: '127.0.0.1', port: 8080, path, timeout: 5000 },
      (response) => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (part) => (body += part))
        response.on('end', () =>
          resolveResult({ status: response.statusCode, body }),
        )
      },
    )
    call.on('error', reject)
    call.end()
  })
}
function checkHardened(service, memory, cpus) {
  const container = inspect(service)
  assert.equal(container.HostConfig.ReadonlyRootfs, true)
  assert.deepEqual(container.HostConfig.CapDrop, ['ALL'])
  assert(container.HostConfig.SecurityOpt.includes('no-new-privileges:true'))
  assert.equal(container.HostConfig.Memory, memory * 1024 * 1024)
  assert.equal(container.HostConfig.NanoCpus, cpus * 1e9)
  assert(container.HostConfig.PidsLimit > 0)
  assert(container.HostConfig.Ulimits.some((limit) => limit.Name === 'nofile'))
  assert.equal(container.HostConfig.LogConfig.Config['max-size'], '10m')
  assert.equal(container.HostConfig.LogConfig.Config['max-file'], '3')
  for (const mount of container.Mounts)
    if (mount.Destination === '/run/secrets') assert.equal(mount.RW, false)
  return container
}
function assertSecretMode(service, path) {
  const id = serviceId(service)
  const output = run('docker', [
    'exec',
    id,
    '/usr/local/bin/node',
    '-e',
    `const s=require('fs').statSync('${path}'); console.log(JSON.stringify({uid:s.uid,mode:s.mode&511}))`,
  ])
  const value = JSON.parse(output)
  assert.equal(value.uid, Number(inspect(service).Config.User.split(':')[0]))
  assert([0o400, 0o440, 0o444].includes(value.mode))
}

let created = false
try {
  run(process.execPath, ['scripts/s8-compose.mjs', 'config'])
  run('docker', ['info'])
  created = true
  run(process.execPath, ['scripts/s8-compose.mjs', 'bootstrap'])
  run(process.execPath, ['scripts/s8-compose.mjs', 'bootstrap'])
  await healthy('postgres')
  await healthy('redis')
  const resolved = compose(['config', '--format', 'json'])
  for (const name of readdirSync(secrets).filter(
    (name) => !name.startsWith('.'),
  ))
    assert(!resolved.includes(secret(name)))
  assert.equal(compose(['ps', '-q', 'migration']), '')
  assert.equal(compose(['ps', '-q', 'importer']), '')
  assert.equal(compose(['ps', '-q', 'content']), '')
  const pg = inspect('postgres')
  const redisContainer = checkHardened('redis', 192, 1)
  for (const [service, path, uid] of [
    ['postgres', '/run/secrets/postgres_password', 70],
    ['redis', '/run/secrets/redis_acl', 999],
  ]) {
    const stat = compose(['exec', '-T', service, 'stat', '-c', '%u:%a', path])
    assert.equal(stat, `${uid}:400`)
  }
  assert.equal(pg.HostConfig.ReadonlyRootfs, true)
  assert(pg.HostConfig.CapDrop.includes('ALL'))
  assert.equal(pg.HostConfig.Memory, 512 * 1024 * 1024)
  assert(redisContainer.Config.Cmd.includes('noeviction'))
  assert(redisContainer.Config.Cmd.includes('128mb'))
  assert(
    pg.Mounts.some(
      (mount) => mount.Destination === '/var/lib/postgresql/data' && mount.RW,
    ),
  )
  assert(
    redisContainer.Mounts.some(
      (mount) => mount.Destination === '/data' && mount.RW,
    ),
  )
  assert.equal(pg.NetworkSettings.Ports['5432/tcp'] ?? null, null)
  assert.equal(redisContainer.NetworkSettings.Ports['6379/tcp'] ?? null, null)
  assert.equal(
    compose([
      'exec',
      '-T',
      'postgres',
      'stat',
      '-c',
      '%u',
      '/var/lib/postgresql/data/pgdata',
    ]),
    '70',
  )
  assert.equal(
    compose(['exec', '-T', 'redis', 'stat', '-c', '%u', '/data']),
    '999',
  )
  assert.equal(Object.keys(pg.NetworkSettings.Networks).length, 1)
  assert.equal(Object.keys(redisContainer.NetworkSettings.Networks).length, 1)
  const pgSql = (sql) =>
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
        '-At',
      ],
      { input: sql },
    )
  assert.equal(
    pgSql(
      "SELECT count(*) > 0 FROM information_schema.tables WHERE table_schema = 'loremaster';",
    ),
    't',
  )
  for (const [login, role] of [
    ['api', 'loremaster_runtime'],
    ['producer', 'loremaster_cache_producer'],
    ['worker', 'loremaster_cache_worker'],
    ['importer', 'loremaster_importer'],
  ]) {
    assert.equal(
      pgSql(`SELECT pg_has_role('${login}', '${role}', 'MEMBER');`),
      't',
    )
    assert.equal(
      pgSql(
        `SELECT rolsuper::text || ':' || rolcreatedb::text || ':' || rolcreaterole::text FROM pg_roles WHERE rolname='${login}';`,
      ),
      'false:false:false',
    )
  }
  const denied = spawnSync(
    'docker',
    [
      'compose',
      '-p',
      project,
      '-f',
      manifest,
      'exec',
      '-T',
      'postgres',
      'psql',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'api',
      '-d',
      'loremaster',
      '-c',
      'CREATE TABLE public.s8_forbidden(id int)',
    ],
    { encoding: 'utf8', env: environment },
  )
  assert.notEqual(denied.status, 0)
  assert.match(denied.stderr, /permission denied/u)
  const wrongRole = spawnSync(
    'docker',
    [
      'compose',
      '-p',
      project,
      '-f',
      manifest,
      'exec',
      '-T',
      'postgres',
      'psql',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'api',
      '-d',
      'loremaster',
      '-c',
      'SET ROLE loremaster_importer',
    ],
    { encoding: 'utf8', env: environment },
  )
  assert.notEqual(wrongRole.status, 0)
  const wrongDatabasePassword = compose([
    'run',
    '--rm',
    '-T',
    '--entrypoint',
    '/usr/local/bin/node',
    'api',
    '--input-type=module',
    '-e',
    "import fs from 'node:fs';import {database} from '@loremaster/database/runtime';const url=new URL(fs.readFileSync('/run/secrets/api_database_url','utf8'));url.password='wrong';const db=database(url.toString(),{connectionTimeoutMs:2000});try{await db.query('SELECT 1');process.exitCode=1}catch(error){console.log(error.code)}finally{await db.end()}",
  ])
  assert.equal(wrongDatabasePassword, '28P01')
  const apiPassword = credential('redis_api_cache_url')
  assert.match(
    redis([`AUTH loremaster_api_cache ${apiPassword}`, 'PING']),
    /OK\s+PONG/u,
  )
  assert.match(
    redis([
      `AUTH loremaster_api_cache ${apiPassword}`,
      'SET loremaster:v1:revision:admission no',
    ]),
    /NOPERM/u,
  )
  assert.match(redis([`AUTH loremaster_api_cache wrong`, 'PING']), /WRONGPASS/u)
  for (const file of [
    'redis_api_cache_url',
    'redis_api_limiter_url',
    'redis_producer_url',
    'redis_worker_url',
    'redis_worker_cache_url',
    'redis_observer_url',
  ]) {
    const url = new URL(secret(file))
    assert.match(
      redis([`AUTH ${url.username} ${url.password}`, 'FLUSHALL']),
      /NOPERM/u,
    )
  }
  const producerPassword = credential('redis_producer_url')
  const marker = `s8-${randomUUID()}`
  const key = 'loremaster:v1:queue:loremaster-warm-v1:s8-persist'
  assert.match(
    redis([
      `AUTH loremaster_producer ${producerPassword}`,
      `SET ${key} ${marker}`,
    ]),
    /OK\s+OK/u,
  )
  pgSql(
    "CREATE TABLE public.s8_persistence_marker(value text); INSERT INTO public.s8_persistence_marker VALUES ('retained');",
  )
  compose(['restart', 'postgres', 'redis'])
  await healthy('postgres')
  await healthy('redis')
  assert.equal(
    pgSql('SELECT value FROM public.s8_persistence_marker;'),
    'retained',
  )
  assert(
    redis([
      `AUTH loremaster_producer ${producerPassword}`,
      `GET ${key}`,
    ]).includes(marker),
  )
  const packPath = join(temporary, 'pack.json')
  writeFileSync(packPath, '{"invalid":true}', { mode: 0o444 })
  environment.LOREMASTER_S8_CONTENT_FILE = packPath
  compose(['--profile', 'operator', 'run', '--rm', '-T', 'content'])
  const contentMode = compose([
    '--profile',
    'operator',
    'run',
    '--rm',
    '-T',
    '--entrypoint',
    '/usr/local/bin/node',
    'importer',
    '-e',
    "const s=require('fs').statSync('/run/content/pack.json');console.log(s.uid+':'+(s.mode&511).toString(8))",
  ])
  assert.equal(contentMode, '10006:400')
  const invalidImport = spawnSync(
    'docker',
    [
      'compose',
      '-p',
      project,
      '-f',
      manifest,
      '--profile',
      'operator',
      'run',
      '--rm',
      '-T',
      'importer',
      '--dry-run',
    ],
    { encoding: 'utf8', env: environment, timeout: 60000 },
  )
  assert.equal(invalidImport.status, 2)
  assert.equal(JSON.parse(invalidImport.stdout).status, 'REJECTED')
  const wrapperImport = spawnSync(
    process.execPath,
    ['scripts/s8-compose.mjs', 'import', '--dry-run'],
    { encoding: 'utf8', env: environment, timeout: 60000 },
  )
  assert.equal(wrapperImport.status, 1)
  assert.match(wrapperImport.stderr, /REJECTED/u)
  if (scope === 'compose') {
    const redisProbe = compose(
      [
        'run',
        '--rm',
        '-T',
        '--entrypoint',
        '/usr/local/bin/node',
        'worker',
        '-e',
        "const fs=require('fs'),net=require('net');const u=new URL(fs.readFileSync('/run/secrets/redis_worker_url','utf8'));let stage=0;const s=net.connect(6379,u.hostname);const send=a=>s.write('*'+a.length+'\\r\\n'+a.map(x=>'$'+Buffer.byteLength(x)+'\\r\\n'+x+'\\r\\n').join(''));s.on('connect',()=>send(['AUTH',u.username,u.password]));s.on('data',d=>{const v=d.toString();if(stage===0&&v.startsWith('+OK')){stage=1;send(['PING'])}else{console.log(v.trim());s.end();if(!v.startsWith('+PONG'))process.exitCode=1}});s.on('error',e=>{console.error(e.code);process.exitCode=1});s.setTimeout(3000,()=>{console.error('timeout');s.destroy();process.exitCode=1})",
      ],
      { showOutput: true },
    )
    assert.equal(redisProbe, '+PONG')
    run(process.execPath, ['scripts/s8-compose.mjs', 'start'])
    for (const service of ['api', 'worker', 'observer', 'web'])
      await healthy(service)
    const api = checkHardened('api', 256, 1)
    const worker = checkHardened('worker', 256, 1)
    const observer = checkHardened('observer', 128, 0.5)
    const web = checkHardened('web', 128, 0.5)
    assert.equal(Object.keys(api.NetworkSettings.Networks).length, 2)
    assert.equal(Object.keys(worker.NetworkSettings.Networks).length, 1)
    assert.equal(Object.keys(observer.NetworkSettings.Networks).length, 1)
    assert.equal(Object.keys(web.NetworkSettings.Networks).length, 1)
    assert.equal(
      api.NetworkSettings.Networks[`${project}_edge`].IPAddress,
      '172.30.80.3',
    )
    assert.equal(
      web.NetworkSettings.Networks[`${project}_edge`].IPAddress,
      '172.30.80.2',
    )
    assert.equal(web.NetworkSettings.Ports['8080/tcp'][0].HostIp, '127.0.0.1')
    assert.equal(web.NetworkSettings.Ports['8080/tcp'][0].HostPort, '8080')
    for (const service of [api, worker, observer])
      assert(
        Object.values(service.NetworkSettings.Ports).every(
          (entry) => entry === null,
        ),
      )
    assertSecretMode('api', '/run/secrets/api_database_url')
    assertSecretMode('worker', '/run/secrets/worker_database_url')
    assertSecretMode('observer', '/run/secrets/redis_observer_url')
    const page = await http('/')
    assert.equal(page.status, 200)
    assert.match(page.body, /<html/iu)
    assert.equal((await http('/health/ready')).status, 200)
    assert.equal((await http('/api/v1/')).status, 404)
  }
  process.stdout.write(`S8 ${scope} Compose test passed (${project})\n`)
} catch (error) {
  if (created) {
    const mount = spawnSync(
      'docker',
      [
        'compose',
        '-p',
        project,
        '-f',
        manifest,
        '--profile',
        'operator',
        'run',
        '--rm',
        '-T',
        '--entrypoint',
        '/usr/local/bin/node',
        'migration',
        '-e',
        "const s=require('fs').statSync('/run/secrets/migration_database_url');console.log(JSON.stringify({uid:s.uid,mode:s.mode&511,size:s.size}))",
      ],
      { encoding: 'utf8', env: environment, timeout: 30000 },
    )
    if (mount.status === 0)
      process.stderr.write(`Migration secret mount: ${mount.stdout}`)
    const logs = spawnSync(
      'docker',
      [
        'compose',
        '-p',
        project,
        '-f',
        manifest,
        'logs',
        '--tail',
        '30',
        'postgres',
        'redis',
        'api',
        'worker',
        'observer',
        'web',
      ],
      { encoding: 'utf8', env: environment, timeout: 30000 },
    )
    if (logs.status === 0) process.stderr.write(logs.stdout)
  }
  throw error
} finally {
  if (created) {
    const cleanup = spawnSync(
      'docker',
      [
        'compose',
        '-p',
        project,
        '-f',
        manifest,
        '--profile',
        'bootstrap',
        '--profile',
        'operator',
        'down',
        '--volumes',
        '--remove-orphans',
      ],
      { encoding: 'utf8', env: environment, timeout: 120000 },
    )
    const remaining =
      cleanup.status === 0
        ? spawnSync(
            'docker',
            [
              'volume',
              'ls',
              '--filter',
              `label=com.docker.compose.project=${project}`,
              '--format',
              '{{.Name}}',
            ],
            { encoding: 'utf8', env: environment, timeout: 30000 },
          )
        : undefined
    if (
      cleanup.status !== 0 ||
      remaining?.status !== 0 ||
      remaining.stdout.trim()
    ) {
      process.stderr.write(
        `Could not remove disposable Compose project ${project}\n`,
      )
      process.exitCode = 1
    } else rmSync(temporary, { recursive: true, force: true })
  } else rmSync(temporary, { recursive: true, force: true })
}
