import { Buffer } from 'node:buffer'
import { URL } from 'node:url'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { request } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import process from 'node:process'
import {
  removeTrackedContainer,
  startTrackedContainer,
} from './s8-image-resources.mjs'

const scope = process.argv[2] ?? 'all'
if (!['all', 'node', 'operator', 'web'].includes(scope))
  throw Error('Unknown image suite')
const id = 'loremaster-s8-' + randomUUID().slice(0, 8)
const containers = []
const networks = []
const volumes = []
const secrets = []
const node = '/usr/local/bin/node'
const image = (name) => 'loremaster/' + name + ':s8'
function docker(args, options = {}) {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    timeout: 60000,
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  })
  if (result.status !== 0)
    throw Error('Docker operation failed: ' + args.slice(0, 2).join(' '))
  return result.stdout.trim()
}
function check(args, options = {}) {
  return spawnSync('docker', args, {
    encoding: 'utf8',
    timeout: 30000,
    ...options,
  })
}
const harden = [
  '--read-only',
  '--cap-drop=ALL',
  '--security-opt=no-new-privileges:true',
  '--pids-limit=128',
  '--memory=256m',
  '--cpus=1',
  '--ulimit',
  'nofile=1024:1024',
  '--tmpfs',
  '/tmp:rw,noexec,nosuid,size=32m',
]
function createVolume(suffix) {
  const name = id + '-' + suffix
  docker(['volume', 'create', name])
  volumes.push(name)
  return name
}
function start(name, args) {
  const full = id + '-' + name
  return startTrackedContainer(containers, full, args, docker)
}
async function eventually(fn, ms = 30000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try {
      if (await fn()) return
    } catch {
      /* A dependency may be starting; the deadline below remains fatal. */
    }
    await delay(150)
  }
  throw Error('Image condition did not become ready')
}
function writeVolume(volume, entries) {
  const program =
    "const fs=require('fs'); const entries=JSON.parse(fs.readFileSync(0,'utf8')); for(const entry of entries){ const p='/target/'+entry.name; fs.writeFileSync(p,entry.bytes ? Buffer.from(entry.bytes) : entry.value,{mode:0o400}); fs.chownSync(p,entry.uid,entry.uid); fs.chmodSync(p,entry.mode ?? 0o400); }"
  docker(
    [
      'run',
      '--rm',
      '-i',
      '--network=none',
      '--user',
      '0:0',
      '--mount',
      'type=volume,src=' + volume + ',dst=/target',
      '--entrypoint',
      node,
      image('api'),
      '-e',
      program,
    ],
    { input: JSON.stringify(entries) },
  )
}
function secret(name, value, uid) {
  secrets.push(value)
  return { name, value, uid }
}
function env(values) {
  return Object.entries(values).flatMap(([k, v]) => ['--env', k + '=' + v])
}
function http(path, method = 'GET', headers = [], body = '') {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: '127.0.0.1',
        port: 8080,
        path,
        method,
        headers: ['Host', 'localhost:8080', ...headers],
      },
      (res) => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (v) => (text += v))
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, text }),
        )
      },
    )
    req.on('error', reject)
    req.setTimeout(5000, () => req.destroy(Error('HTTP timeout')))
    req.end(body)
  })
}
function probe(container, port, path = '/health/ready') {
  const result = check([
    'exec',
    container,
    node,
    '-e',
    "fetch('http://127.0.0.1:" +
      port +
      path +
      "').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
  ])
  return result.status === 0
}
const postgres =
  'postgres:17.11-alpine@sha256:eee6c6e1b0894fa4fe0075eb054af9fd1cf39a35321c2d4110626cfe506411fb'
const redisImage =
  'redis:7.4.11-alpine@sha256:57e4255cc971b1c8d6f8a6ca283ac01bc3ecdd914273ef6bfaede87aaecd6541'
try {
  docker(['info'])
  for (const [name, uid] of Object.entries({
    api: 10002,
    worker: 10003,
    observer: 10004,
    migration: 10005,
    importer: 10006,
    web: 10001,
  })) {
    const config = JSON.parse(docker(['image', 'inspect', image(name)]))[0]
      .Config
    assert.equal(config.User, uid + ':' + uid)
    assert(Array.isArray(config.Entrypoint))
    if (name !== 'web') {
      assert.equal(config.Entrypoint[0], node)
      assert(config.Entrypoint.includes('--unhandled-rejections=strict'))
      const rejection = check([
        'run',
        '--rm',
        '--network=none',
        '--entrypoint',
        node,
        image(name),
        '--unhandled-rejections=strict',
        '-e',
        "Promise.reject(Error('expected rejection'))",
      ])
      assert.notEqual(rejection.status, 0)
    }
    assert(
      !config.Env.some((x) =>
        /(?:password|postgres(?:ql)?:\/\/|redis:\/\/)/iu.test(x),
      ),
    )
  }
  const backend = id + '-backend'
  docker(['network', 'create', '--internal', backend])
  networks.push(backend)
  const credentials = createVolume('credentials'),
    content = createVolume('content')
  const pass = randomUUID()
  const dbName = 'loremaster_s8_test'
  writeVolume(credentials, [
    secret('postgres-password', pass, 70),
    secret(
      'migration-url',
      'postgresql://migration:' + pass + '@postgres/' + dbName,
      10005,
    ),
  ])
  const mount = [
    '--mount',
    'type=volume,src=' + credentials + ',dst=/run/secrets,readonly',
  ]
  const pg = start('postgres', [
    '--network',
    backend,
    '--network-alias',
    'postgres',
    ...mount,
    ...env({
      POSTGRES_USER: 'migration',
      POSTGRES_DB: dbName,
      POSTGRES_PASSWORD_FILE: '/run/secrets/postgres-password',
    }),
    postgres,
  ])
  await eventually(
    () =>
      check([
        'exec',
        pg,
        'pg_isready',
        '-h',
        '127.0.0.1',
        '-U',
        'migration',
        '-d',
        dbName,
      ]).status === 0,
  )
  function sql(statement) {
    return docker(
      [
        'exec',
        '-i',
        pg,
        'psql',
        '-v',
        'ON_ERROR_STOP=1',
        '-U',
        'migration',
        '-d',
        dbName,
        '-At',
      ],
      { input: statement },
    )
  }
  function operator(name, options = [], extraEnv = {}) {
    return check(
      [
        'run',
        '--rm',
        ...harden,
        '--network',
        backend,
        ...mount,
        ...(name === 'importer'
          ? [
              '--mount',
              'type=volume,src=' + content + ',dst=/run/content,readonly',
            ]
          : []),
        ...env({
          [name === 'migration'
            ? 'LOREMASTER_MIGRATION_DATABASE_URL_FILE'
            : 'LOREMASTER_IMPORT_DATABASE_URL_FILE']:
            '/run/secrets/' + name + '-url',
          ...extraEnv,
        }),
        image(name),
        ...options,
      ],
      { timeout: 60000 },
    )
  }
  let result = operator('migration')
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).status, 'APPLIED')
  result = operator('migration')
  assert.equal(result.status, 0)
  assert.equal(JSON.parse(result.stdout).status, 'NO_OP')
  const roleSecrets = []
  for (const [login, role, uid] of [
    ['api', 'loremaster_runtime', 10002],
    ['importer', 'loremaster_importer', 10006],
    ['worker', 'loremaster_cache_worker', 10003],
  ]) {
    const password = randomUUID()
    sql(
      'CREATE ROLE ' +
        login +
        " LOGIN PASSWORD '" +
        password +
        "' NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE; GRANT " +
        role +
        ' TO ' +
        login +
        ';',
    )
    roleSecrets.push(
      secret(
        login + '-url',
        'postgresql://' + login + ':' + password + '@postgres/' + dbName,
        uid,
      ),
    )
  }
  roleSecrets.push(
    secret('cursor', randomBytes(32).toString('base64url'), 10002),
  )
  writeVolume(credentials, roleSecrets)
  const { asterQuayContentPack } =
    await import('../packages/database/dist/content/fixtures/aster-quay.js')
  const day = new Date().toISOString().slice(0, 10)
  const open = new Date(day + 'T00:00:00.000Z'),
    close = new Date(open.getTime() + 86400000)
  const pack = {
    ...asterQuayContentPack,
    opensAt: open.toISOString(),
    closesAt: close.toISOString(),
    slotId: day,
  }
  writeVolume(content, [
    { name: 'pack.json', value: JSON.stringify(pack), uid: 10006 },
  ])
  result = operator('importer', ['--dry-run'])
  assert.equal(result.status, 0, result.stdout + result.stderr)
  result = operator('importer')
  assert.equal(result.status, 0, result.stdout + result.stderr)
  result = operator('importer')
  assert.equal(result.status, 2)
  assert(JSON.parse(result.stdout).codes.includes('DUPLICATE_REVISION'))
  if (scope === 'operator' || scope === 'all') {
    assert.notEqual(operator('migration', ['down']).status, 0)
    for (const entry of [
      { value: 'x'.repeat(262145), uid: 10006 },
      { bytes: [255], uid: 10006 },
      { value: JSON.stringify(pack), uid: 10002 },
      { value: JSON.stringify(pack), uid: 10006, mode: 0o644 },
    ]) {
      writeVolume(content, [{ name: 'pack.json', ...entry }])
      assert.notEqual(operator('importer').status, 0)
    }
    writeVolume(content, [
      { name: 'pack.json', value: '{"malformed":true}', uid: 10006 },
    ])
    assert.equal(operator('importer').status, 2)
    writeVolume(content, [
      { name: 'pack.json', value: JSON.stringify(pack), uid: 10006 },
    ])
    assert.notEqual(operator('importer', ['--file', '/etc/passwd']).status, 0)
    // A symlink mount is rejected before content is read.
    const makeLink =
      "const fs=require('fs');fs.renameSync('/target/pack.json','/target/original');fs.symlinkSync('original','/target/pack.json')"
    docker([
      'run',
      '--rm',
      '--network=none',
      '--user',
      '0:0',
      '--mount',
      'type=volume,src=' + content + ',dst=/target',
      '--entrypoint',
      node,
      image('api'),
      '-e',
      makeLink,
    ])
    assert.notEqual(operator('importer').status, 0)
  }
  const api = start('api', [
    ...harden,
    '--network',
    backend,
    '--network-alias',
    'api',
    ...mount,
    ...env({
      LOREMASTER_API_MODE: 'local',
      DATABASE_URL_FILE: '/run/secrets/api-url',
      LOREMASTER_API_ORIGIN: 'http://localhost:8080',
      LOREMASTER_API_CURSOR_ACTIVE_VERSION: 's8',
      LOREMASTER_API_CURSOR_ACTIVE_KEY_FILE: '/run/secrets/cursor',
      LOREMASTER_API_TRUSTED_PROXIES: '172.30.80.2/32',
    }),
    image('api'),
  ])
  await eventually(() => probe(api, 3000))
  const effective = JSON.parse(docker(['inspect', api]))[0]
  assert.equal(effective.HostConfig.ReadonlyRootfs, true)
  assert.deepEqual(effective.HostConfig.CapDrop, ['ALL'])
  assert(effective.HostConfig.SecurityOpt.includes('no-new-privileges:true'))
  assert.equal(effective.HostConfig.Memory, 256 * 1024 * 1024)
  assert.equal(effective.HostConfig.PidsLimit, 128)
  assert.equal(effective.HostConfig.NanoCpus, 1e9)
  assert(
    effective.Mounts.filter((x) => x.Destination === '/run/secrets').every(
      (x) => !x.RW,
    ),
  )
  const denied =
    "import fs from 'node:fs';const {database}=await import('@loremaster/database/runtime');const db=database(fs.readFileSync('/run/secrets/api-url','utf8'));for(const sql of ['CREATE TABLE public.s8_forbidden(id int)','SET ROLE loremaster_importer']){try{await db.query(sql);process.exit(1)}catch(e){if(e.code!=='42501')process.exit(2)}}await db.end()"
  assert.equal(
    check(['exec', api, node, '--input-type=module', '-e', denied]).status,
    0,
  )
  if (scope === 'node' || scope === 'all') {
    const redis = start('redis', [
      '--network',
      backend,
      '--network-alias',
      'redis',
      redisImage,
      'redis-server',
      '--save',
      '',
      '--appendonly',
      'no',
      '--maxmemory',
      '128mb',
      '--maxmemory-policy',
      'noeviction',
    ])
    await eventually(
      () =>
        check(['exec', redis, 'redis-cli', 'ping']).stdout.trim() === 'PONG',
    )
    const policy = JSON.parse(
        readFileSync('ops/redis/acl-policy.json', 'utf8'),
      ),
      inventory = JSON.parse(
        readFileSync('ops/redis/bullmq-script-inventory.json', 'utf8'),
      )
    const entries = []
    for (const [role, rule] of Object.entries(policy.roles)) {
      const password = randomUUID(),
        commands = new Set([
          'auth',
          'hello',
          'ping',
          'quit',
          'client|setname',
          'client|setinfo',
          ...rule.commands,
        ])
      for (const script of Object.values(inventory.scripts))
        if (script.roles.includes(rule.bullmqRole))
          for (const cmd of script.commands) commands.add(cmd)
      const args = [
        'ACL',
        'SETUSER',
        role,
        'reset',
        'on',
        '>' + password,
        ...rule.patterns,
        ...[...commands].map((x) => '+' + x),
      ]
      const wire =
        '*' +
        args.length +
        '\r\n' +
        args
          .map((x) => '$' + Buffer.byteLength(x) + '\r\n' + x + '\r\n')
          .join('')
      docker(['exec', '-i', redis, 'redis-cli', '--pipe'], { input: wire })
      const uid = role === 'loremaster_observer' ? 10004 : 10003
      entries.push(
        secret(role, 'redis://' + role + ':' + password + '@redis', uid),
      )
    }
    writeVolume(credentials, entries)
    const worker = start('worker', [
      ...harden,
      '--network',
      backend,
      ...mount,
      ...env({
        LOREMASTER_WORKER_DATABASE_URL_FILE: '/run/secrets/worker-url',
        LOREMASTER_WORKER_REDIS_URL_FILE: '/run/secrets/loremaster_worker',
        LOREMASTER_WORKER_CACHE_REDIS_URL_FILE:
          '/run/secrets/loremaster_worker_cache',
      }),
      image('worker'),
    ])
    const observer = start('observer', [
      ...harden,
      '--network',
      backend,
      ...mount,
      ...env({
        LOREMASTER_OBSERVER_REDIS_URL_FILE: '/run/secrets/loremaster_observer',
      }),
      image('observer'),
    ])
    await eventually(() => probe(worker, 3001))
    await eventually(() => probe(observer, 3002))
    for (const [container, port] of [
      [worker, 3001],
      [observer, 3002],
    ]) {
      assert(probe(container, port, '/health/live'))
      const start = Date.now()
      docker(['kill', '--signal=SIGTERM', container])
      await eventually(
        () =>
          JSON.parse(docker(['inspect', container]))[0].State.Running === false,
        15000,
      )
      assert(Date.now() - start < 15000)
      assert.equal(
        JSON.parse(docker(['inspect', container]))[0].State.ExitCode,
        0,
      )
    }
  }
  if (scope === 'web' || scope === 'all') {
    const edge = id + '-edge'
    docker(['network', 'create', '--subnet', '172.30.80.0/28', edge])
    networks.push(edge)
    docker([
      'network',
      'connect',
      '--ip',
      '172.30.80.3',
      '--alias',
      'api',
      edge,
      api,
    ])
    const web = start('web', [
      ...harden,
      '--network',
      edge,
      '--ip',
      '172.30.80.2',
      '--publish',
      '127.0.0.1:8080:8080',
      image('web'),
    ])
    await eventually(async () => (await http('/health/live')).status === 200)
    for (const route of ['/', '/profile', '/leaderboard']) {
      const response = await http(route)
      assert.equal(response.status, 200)
      assert.match(
        response.headers['content-security-policy'],
        /frame-ancestors 'none'/u,
      )
      assert.match(response.headers['cache-control'], /no-cache/u)
    }
    for (const route of [
      '/api',
      '/health/missing',
      '/assets/missing.js',
      '/.env',
      '/missing.css',
    ])
      assert.equal((await http(route)).status, 404)
    const page = await http('/')
    const asset = page.text.match(/src="(\/assets\/[^"]+\.js)"/u)?.[1]
    assert(asset)
    const servedAsset = await http(asset)
    assert.match(servedAsset.headers['cache-control'], /immutable/u)
    const servedMap = await http(asset + '.map')
    assert.equal(servedMap.status, 200)
    for (const body of [page.text, servedAsset.text, servedMap.text])
      assert(
        !/(?:content\/fixtures|answerentityid|database_url|postgresql:\/\/|redis:\/\/|-----BEGIN [A-Z ]*PRIVATE KEY-----)/iu.test(
          body,
        ),
        'Private marker in served public response',
      )
    const contentType = ['Content-Type', 'application/json']
    const good = await http(
      '/api/v1/session',
      'POST',
      [...contentType, 'Origin', 'http://localhost:8080'],
      '{}',
    )
    assert.equal(good.status, 201)
    assert(
      good.headers['set-cookie'].some(
        (x) =>
          x.startsWith('loremaster_local_session=') && x.includes('HttpOnly'),
      ),
    )
    for (const headers of [
      contentType,
      [...contentType, 'Origin', 'http://evil.example'],
      [
        ...contentType,
        'Origin',
        'http://localhost:8080',
        'Origin',
        'http://localhost:8080',
      ],
    ])
      assert.equal(
        (await http('/api/v1/session', 'POST', headers, '{}')).status,
        403,
      )
    const { chromium } = await import('@playwright/test')
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      await page.goto('http://localhost:8080/profile')
      await page.waitForSelector('main')
      await page.reload()
      assert.equal(new URL(page.url()).pathname, '/profile')
    } finally {
      await browser.close()
    }

    docker(['network', 'disconnect', edge, api])
    const echoCode =
      "require('http').createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(req.headers))}).listen(3000,'0.0.0.0')"
    const echo = start('echo', [
      ...harden,
      '--network',
      edge,
      '--ip',
      '172.30.80.3',
      '--network-alias',
      'api',
      '--entrypoint',
      node,
      image('api'),
      '-e',
      echoCode,
    ])
    await eventually(() => probe(echo, 3000, '/'))
    await eventually(async () => (await http('/api/echo')).status === 200)
    const forwarded = await http('/api/echo', 'GET', [
      'Origin',
      'http://EXAMPLE.test:8080',
      'X-Forwarded-For',
      '9.9.9.9',
      'X-Forwarded-Proto',
      'https',
      'X-Forwarded-Unknown',
      'spoof',
      'Forwarded',
      'for=9.9.9.9',
      'X-Real-IP',
      '9.9.9.9',
    ])
    const echoed = JSON.parse(forwarded.text)
    assert.equal(echoed.origin, 'http://EXAMPLE.test:8080')
    assert.notEqual(echoed['x-forwarded-for'], '9.9.9.9')
    for (const field of [
      'forwarded',
      'x-forwarded-proto',
      'x-forwarded-unknown',
      'x-real-ip',
    ])
      assert.equal(echoed[field], undefined)
    const clients = id + '-clients'
    docker(['network', 'create', '--internal', clients])
    networks.push(clients)
    docker(['network', 'connect', '--alias', 'gateway', clients, web])
    const clientCode =
      "fetch('http://gateway:8080/api/echo',{headers:{'X-Forwarded-For':'9.9.9.9'}}).then(r=>r.json()).then(value=>console.log(JSON.stringify(value)));setInterval(()=>{},1000)"
    const addresses = []
    for (const label of ['client-a', 'client-b']) {
      const client = start(label, [
        ...harden,
        '--network',
        clients,
        '--entrypoint',
        node,
        image('api'),
        '-e',
        clientCode,
      ])
      await eventually(() => Boolean(docker(['logs', client])))
      const response = JSON.parse(docker(['logs', client]))
      const address = JSON.parse(docker(['inspect', client]))[0].NetworkSettings
        .Networks[clients].IPAddress
      assert.equal(response['x-forwarded-for'], address)
      addresses.push(address)
    }
    assert.notEqual(addresses[0], addresses[1])

    docker(['kill', '--signal=SIGQUIT', web])
    await eventually(
      () => !JSON.parse(docker(['inspect', web]))[0].State.Running,
    )
    assert.equal(JSON.parse(docker(['inspect', web]))[0].State.ExitCode, 0)
  }
  const started = Date.now()
  docker(['kill', '--signal=SIGTERM', api])
  await eventually(
    () => !JSON.parse(docker(['inspect', api]))[0].State.Running,
    15000,
  )
  assert(Date.now() - started < 15000)
  assert.equal(JSON.parse(docker(['inspect', api]))[0].State.ExitCode, 0)
  for (const container of containers.filter(
    (x) => !x.endsWith('-postgres') && !x.endsWith('-redis'),
  )) {
    const inspection = docker(['inspect', container])
    const logs = docker(['logs', container])
    for (const value of secrets) {
      assert(!inspection.includes(value))
      assert(!logs.includes(value))
    }
  }
  process.stdout.write('S8 ' + scope + ' image behavior passed\n')
} catch (error) {
  for (const container of containers.filter(
    (x) => !x.endsWith('-postgres') && !x.endsWith('-redis'),
  )) {
    const result = check(['logs', container])
    let output = (result.stdout ?? '') + (result.stderr ?? '')
    for (const value of secrets) output = output.replaceAll(value, '[REDACTED]')
    process.stderr.write(container + ': ' + output.slice(-3000) + '\n')
  }
  throw error
} finally {
  const failures = []
  for (const container of containers.reverse())
    if (!removeTrackedContainer(container, check)) failures.push(container)
  for (const network of networks.reverse())
    if (check(['network', 'rm', network]).status !== 0) failures.push(network)
  for (const volume of volumes.reverse())
    if (check(['volume', 'rm', volume]).status !== 0) failures.push(volume)
  if (failures.length) {
    process.stderr.write(
      'S8 test cleanup failed for ' + failures.join(', ') + '\n',
    )
    process.exitCode = 1
  }
}
