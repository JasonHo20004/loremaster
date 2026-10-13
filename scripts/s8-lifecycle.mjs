import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { request } from 'node:http'
import { performance } from 'node:perf_hooks'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { URL } from 'node:url'
import { createTestStack } from './s8-test-stack.mjs'

const stack = createTestStack('lifecycle')
const results = { project: stack.project, checks: [], passed: false }
const record = (name, value) => results.checks.push({ name, ...value })
const check = (condition, label) => assert(condition, label)

function privateStatus(service, path) {
  return stack.serviceHttp(service, path).status
}
function container(id) {
  return JSON.parse(stack.docker('inspect', id))[0]
}
async function stopAndRestart(service, maximumMs) {
  const id = stack.inspect(service).Id
  const start = performance.now()
  stack.compose('stop', '-t', '15', service)
  const elapsedMs = Math.round(performance.now() - start)
  const stopped = container(id)
  check(!stopped.State.Running, `${service} remained running`)
  check(
    stopped.State.ExitCode === 0,
    `${service} exited ${stopped.State.ExitCode}`,
  )
  check(!stopped.State.OOMKilled, `${service} was OOM killed`)
  check(elapsedMs <= maximumMs, `${service} drain took ${elapsedMs} ms`)
  stack.compose('start', service)
  const recoveryMs = await stack.health(service)
  check(stack.inspect(service).Id === id, `${service} was recreated`)
  return { elapsedMs, recoveryMs, exitCode: stopped.State.ExitCode }
}
function pendingRequest() {
  const call = request({
    host: '127.0.0.1',
    port: 8080,
    path: '/api/v1/session',
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'http://localhost:8080',
      'transfer-encoding': 'chunked',
    },
  })
  call.on('error', () => {})
  call.write('{')
  return call
}

try {
  stack.docker('info')
  stack.wrapper('config')
  stack.wrapper('bootstrap')
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
  check(
    (await stack.gateway('/health/ready')).status === 200,
    'gateway is not ready',
  )
  check(privateStatus('api', '/health/live') === 200, 'API live probe failed')
  check(privateStatus('api', '/health/ready') === 200, 'API ready probe failed')
  for (const service of ['worker', 'observer']) {
    check(
      privateStatus(service, '/health/live') === 200,
      `${service} live probe failed`,
    )
    check(
      privateStatus(service, '/health/ready') === 200,
      `${service} ready probe failed`,
    )
  }
  record('initial_probes', { status: 'PASS' })

  const apiId = stack.inspect('api').Id
  const webId = stack.inspect('web').Id
  stack.compose('stop', 'postgres')
  check(
    privateStatus('api', '/health/live') === 200,
    'API liveness followed PostgreSQL',
  )
  await stack.health('api', 'unhealthy')
  record('postgres_loss', {
    status: 'PASS',
    apiLive: 200,
    apiReady: 'unhealthy',
  })
  stack.compose('start', 'postgres')
  const pgRecoveryMs = await stack.health('postgres')
  const apiRecoveryMs = await stack.until(
    'API PostgreSQL recovery',
    () => privateStatus('api', '/health/ready') === 200,
  )
  check(
    stack.inspect('api').Id === apiId,
    'API recreated after PostgreSQL recovery',
  )
  record('postgres_recovery', { status: 'PASS', pgRecoveryMs, apiRecoveryMs })

  stack.compose('stop', 'redis')
  check(
    privateStatus('api', '/health/live') === 200,
    'API liveness followed Redis',
  )
  check(
    privateStatus('api', '/health/ready') === 200,
    'Redis loss blocked PostgreSQL readiness',
  )
  const session = await stack.gateway('/api/v1/session', {
    method: 'POST',
    headers: {
      Origin: 'http://localhost:8080',
      'Content-Type': 'application/json',
    },
    body: '{}',
  })
  check(
    session.status === 201,
    `PostgreSQL session path returned ${session.status} without Redis`,
  )
  await stack.until(
    'worker not ready without Redis',
    () => privateStatus('worker', '/health/ready') === 503,
    15_000,
  )
  await stack.until(
    'observer not ready without Redis',
    () => privateStatus('observer', '/health/ready') === 503,
    15_000,
  )
  record('redis_loss', {
    status: 'PASS',
    apiReady: 200,
    session: session.status,
  })
  stack.compose('start', 'redis')
  const redisRecoveryMs = await stack.health('redis')
  const workerRecoveryMs = await stack.until(
    'worker Redis recovery',
    () => privateStatus('worker', '/health/ready') === 200,
  )
  const observerRecoveryMs = await stack.until(
    'observer Redis recovery',
    () => privateStatus('observer', '/health/ready') === 200,
  )
  check(stack.inspect('api').Id === apiId, 'API recreated after Redis recovery')
  check(stack.inspect('web').Id === webId, 'web recreated after Redis recovery')
  record('redis_recovery', {
    status: 'PASS',
    redisRecoveryMs,
    workerRecoveryMs,
    observerRecoveryMs,
  })

  const requestInFlight = pendingRequest()
  let requestClosed = false
  requestInFlight.once('close', () => {
    requestClosed = true
  })
  try {
    await delay(250)
    const stopped = await stopAndRestart('api', 16_000)
    await stack.until(
      'API in-flight connection closure',
      () => requestClosed,
      2_000,
    )
    record('api_term_drain', { status: 'PASS', ...stopped, requestClosed })
  } finally {
    requestInFlight.destroy()
  }
  record('worker_term_drain', {
    status: 'PASS',
    ...(await stopAndRestart('worker', 16_000)),
  })
  const apiContainer = stack.inspect('api')
  const deniedWrite = stack.docker(
    'exec',
    apiContainer.Id,
    '/usr/local/bin/node',
    '-e',
    "try{require('fs').writeFileSync('/s8-denied','x');process.exitCode=1}catch(error){console.log(error.code)}",
  )
  check(deniedWrite === 'EROFS', `API root write returned ${deniedWrite}`)
  const diskFull = stack.docker(
    'exec',
    apiContainer.Id,
    '/usr/local/bin/node',
    '-e',
    "const fs=require('fs'),path='/tmp/s8-fill',fd=fs.openSync(path,'w'),part=Buffer.alloc(1048576,1);let code='';try{for(let i=0;i<40;i++)fs.writeSync(fd,part)}catch(error){code=error.code}finally{fs.closeSync(fd);fs.unlinkSync(path)}console.log(code)",
  )
  check(diskFull === 'ENOSPC', `bounded tmpfs fill returned ${diskFull}`)
  check(
    privateStatus('api', '/health/ready') === 200,
    'API failed after bounded disk fill',
  )
  record('readonly_and_disk_full', {
    status: 'PASS',
    root: deniedWrite,
    tmpfs: diskFull,
  })

  const oomName = `${stack.project}-oom`
  stack.docker(
    'create',
    '--name',
    oomName,
    '--memory=48m',
    '--network=none',
    '--entrypoint=/usr/local/bin/node',
    'loremaster/api:s8',
    '-e',
    'const chunks=[];for(let i=0;i<1024;i++)chunks.push(Buffer.alloc(1048576,1))',
  )
  try {
    spawnSync('docker', ['start', '-a', oomName], {
      env: stack.environment,
      encoding: 'utf8',
      timeout: 30_000,
    })
    const failed = JSON.parse(stack.docker('inspect', oomName))[0].State
    check(
      failed.OOMKilled === true,
      'isolated memory failure did not register OOMKilled',
    )
    record('bounded_oom', { status: 'PASS', oomKilled: true })
  } finally {
    stack.docker('rm', '-f', oomName)
  }
  const logs = stack.compose(
    'logs',
    '--tail',
    '100',
    'api',
    'worker',
    'observer',
    'postgres',
    'redis',
  )
  for (const name of readdirSync(
    stack.environment.LOREMASTER_S8_SECRET_DIR,
  ).filter((entry) => !entry.startsWith('.'))) {
    const secret = readFileSync(
      join(stack.environment.LOREMASTER_S8_SECRET_DIR, name),
      'utf8',
    )
    if (name !== 'redis_acl')
      check(!logs.includes(secret), `log contains ${name}`)
    if (secret.startsWith('redis://') || secret.startsWith('postgresql://'))
      check(
        !logs.includes(new URL(secret).password),
        `log contains ${name} password`,
      )
  }
  record('bounded_redacted_logs', {
    status: 'PASS',
    lines: logs.split(/\r?\n/u).length,
  })
  check(
    (await stack.gateway('/health/ready')).status === 200,
    'gateway path failed after restart',
  )
  record('post_restart_gameplay', { status: 'PASS' })
  results.passed = true
} catch (error) {
  results.error = error instanceof Error ? error.message : String(error)
  process.exitCode = 1
} finally {
  try {
    stack.cleanup()
    results.teardown = 'PASS'
  } catch (error) {
    results.teardown = error instanceof Error ? error.message : String(error)
    results.passed = false
    process.exitCode = 1
  }
  mkdirSync(resolve('.cache'), { recursive: true })
  writeFileSync(
    resolve('.cache/s8-lifecycle.json'),
    JSON.stringify(results, null, 2) + '\n',
  )
  process.stdout.write(JSON.stringify(results, null, 2) + '\n')
}
