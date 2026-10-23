import { existsSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import {
  apply,
  cluster,
  imageValues,
  json,
  kubeconfig,
  kubectl,
  root,
  run,
  save,
  state,
  tool,
} from './s9-common.mjs'

const result = {
  passed: false,
  checkedAt: new Date().toISOString(),
  checks: [],
}
const output = resolve(state, 'runtime.json')
let forward
const snapshot = existsSync(imageValues)
  ? readFileSync(imageValues, 'utf8')
  : null
const get = (kind, name, namespace = 'loremaster') =>
  JSON.parse(kubectl(['get', '-n', namespace, kind, name, '-o', 'json']))
async function waitFor(description, check, timeout = 180000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (await check()) return Date.now() - start
    await delay(1500)
  }
  throw Error('Timed out: ' + description)
}
async function synced() {
  return waitFor('Argo desired revision healthy and synced', () => {
    const app = get('application', 'loremaster-local', 'argocd')
    const desired = json(resolve(state, 'gitops-source.json')).desiredRevision
    return (
      app.status?.sync?.status === 'Synced' &&
      app.status?.health?.status === 'Healthy' &&
      app.status.sync.revision === desired
    )
  })
}
function execNode(deployment, source) {
  return kubectl([
    'exec',
    '-n',
    'loremaster',
    `deployment/${deployment}`,
    '--',
    '/usr/local/bin/node',
    '-e',
    source,
  ])
}
function cacheProbe(deployment, key, value) {
  const field =
    deployment === 'api'
      ? 'LOREMASTER_REDIS_CACHE_URL_FILE'
      : 'LOREMASTER_WORKER_CACHE_REDIS_URL_FILE'
  return execNode(
    deployment,
    `const fs=require('node:fs'),{createRequire}=require('node:module');const app=createRequire('/app/dist/index.js'),cache=createRequire(app.resolve('@loremaster/cache'));const {Redis}=cache('ioredis');(async()=>{const redis=new Redis(fs.readFileSync(process.env.${field},'utf8'),{lazyConnect:true,enableOfflineQueue:false,connectTimeout:2000,maxRetriesPerRequest:0,retryStrategy:()=>null});redis.on('error',()=>{});try{await redis.connect();${value === undefined ? `if(await redis.get(${JSON.stringify(key)})!=='s9-persisted')throw Error('cache persistence');` : `await redis.set(${JSON.stringify(key)},${JSON.stringify(value)},'EX',600);`} }finally{redis.disconnect(false);}})().catch(()=>process.exitCode=1);`,
  )
}
function tcp(host, port, expected) {
  return `const net=require('node:net');require('node:dns').lookup(${JSON.stringify(host)},{family:4},(error,address)=>{if(error){process.stderr.write('DNS failed');process.exitCode=1;return;}const s=net.connect({host:address,port:${port}});let done=false;function finish(ok){if(done)return;done=true;s.destroy();if(ok!==${expected})process.exitCode=1;}s.on('connect',()=>finish(true));s.on('error',()=>finish(false));setTimeout(()=>finish(false),2500).unref();});`
}
async function recover(name) {
  const before = get('pod', name + '-0')
  const claim = get('pvc', 'data-' + name + '-0').metadata.uid
  const start = Date.now()
  kubectl([
    'delete',
    '-n',
    'loremaster',
    'pod',
    name + '-0',
    '--wait=true',
    '--timeout=45s',
  ])
  await waitFor(name + ' recovered', () => {
    // A missing replacement is a normal transient; only NotFound is retried.
    try {
      const after = get('pod', name + '-0')
      return (
        after.metadata.uid !== before.metadata.uid &&
        after.status.conditions?.some(
          (condition) =>
            condition.type === 'Ready' && condition.status === 'True',
        )
      )
    } catch (error) {
      if (error.message.includes('NotFound')) return false
      throw error
    }
  })
  if (get('pvc', 'data-' + name + '-0').metadata.uid !== claim)
    throw Error('PVC changed during recovery')
  return Date.now() - start
}
try {
  run(process.execPath, ['scripts/s9-local.mjs', 'status'])
  const nodes = JSON.parse(kubectl(['get', 'nodes', '-o', 'json'])).items
  if (
    nodes.length !== 4 ||
    nodes.filter((node) =>
      Object.hasOwn(
        node.metadata.labels,
        'node-role.kubernetes.io/control-plane',
      ),
    ).length !== 1
  )
    throw Error('Expected one control plane and three workers')
  await synced()
  result.checks.push({ name: 'four-node GitOps sync', passed: true })
  execNode('api', tcp('postgres', 5432, true))
  execNode('worker', tcp('redis', 6379, true))
  execNode('observer', tcp('postgres', 5432, false))
  execNode('api', tcp('1.1.1.1', 443, false))
  const pod = {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: 's9-policy-probe',
      labels: { 'app.kubernetes.io/name': 's9-policy-probe' },
    },
    spec: {
      runtimeClassName: 'loremaster',
      restartPolicy: 'Never',
      activeDeadlineSeconds: 30,
      automountServiceAccountToken: false,
      securityContext: {
        runAsNonRoot: true,
        runAsUser: 10002,
        runAsGroup: 10002,
        seccompProfile: { type: 'RuntimeDefault' },
      },
      containers: [
        {
          name: 'probe',
          image: json(imageValues).images.api,
          command: ['/usr/local/bin/node', '-e', tcp('api', 3000, false)],
          resources: {
            requests: { cpu: '50m', memory: '32Mi' },
            limits: { cpu: '100m', memory: '64Mi' },
          },
          securityContext: {
            allowPrivilegeEscalation: false,
            readOnlyRootFilesystem: true,
            capabilities: { drop: ['ALL'] },
          },
        },
      ],
    },
  }
  apply(pod)
  try {
    kubectl([
      'wait',
      '-n',
      'loremaster',
      'pod/s9-policy-probe',
      '--for=jsonpath={.status.phase}=Succeeded',
      '--timeout=45s',
    ])
  } finally {
    kubectl([
      'delete',
      '-n',
      'loremaster',
      'pod/s9-policy-probe',
      '--ignore-not-found',
      '--timeout=30s',
    ])
  }
  result.checks.push({ name: 'allowed and denied network paths', passed: true })
  const limits = execNode(
    'api',
    "const fs=require('node:fs');const f=fs.readFileSync('/proc/self/limits','utf8');if(!/Max open files\\s+1024\\s+1024/u.test(f))process.exit(1);process.stdout.write('nofile=1024');",
  )
  result.checks.push({
    name: 'effective FD ceiling',
    passed: limits === 'nofile=1024',
  })
  const redisPod = get('pod', 'redis-0')
  const containerId =
    redisPod.status.containerStatuses[0].containerID.split('://')[1]
  const redisSpec = JSON.parse(
    run('docker', [
      'exec',
      redisPod.spec.nodeName,
      'crictl',
      'inspect',
      containerId,
    ]),
  ).info.runtimeSpec
  const pids = kubectl([
    'exec',
    '-n',
    'loremaster',
    'redis-0',
    '--',
    'sh',
    '-c',
    'if test -f /sys/fs/cgroup/pids.max; then cat /sys/fs/cgroup/pids.max; else cat /sys/fs/cgroup/pids/pids.max; fi',
  ])
  if (
    redisPod.spec.runtimeClassName !== 'loremaster-redis' ||
    redisSpec.linux.resources.pids.limit !== 64 ||
    pids !== '64'
  )
    throw Error('Redis PID ceiling not effective')
  result.checks.push({
    name: 'effective Redis PID ceiling',
    passed: true,
    runtimeClass: redisPod.spec.runtimeClassName,
    ociLimit: redisSpec.linux.resources.pids.limit,
    kernelPidsMax: Number(pids),
  })
  const wrongRuntime = {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name: 's9-redis-runtime-rejection' },
    spec: { ...redisPod.spec, runtimeClassName: 'loremaster' },
  }
  let rejected = false
  try {
    kubectl(['create', '-n', 'loremaster', '--dry-run=server', '-f', '-'], {
      input: JSON.stringify(wrongRuntime),
    })
  } catch (error) {
    if (!error.message.includes('Redis requires its dedicated 64-PID runtime'))
      throw error
    rejected = true
  }
  if (!rejected) throw Error('Redis runtime admission bypassed')
  result.checks.push({
    name: 'Redis runtime escape denied by admission',
    passed: true,
  })
  for (const name of ['api', 'worker', 'observer']) {
    execNode(
      name,
      "const fs=require('node:fs');for(const k of Object.keys(process.env).filter(k=>k.endsWith('_FILE'))){const p=process.env[k],s=fs.lstatSync(p);if(!s.isFile()||s.isSymbolicLink()||![0,process.getuid()].includes(s.uid)||![256,288,292].includes(s.mode&511))process.exit(1);}",
    )
  }
  result.checks.push({
    name: 'effective secret file ownership and modes',
    passed: true,
  })
  kubectl(['scale', '-n', 'loremaster', 'deployment/api', '--replicas=1'])
  const healedMs = await waitFor(
    'Argo repairs replica drift',
    () => get('deployment', 'api').spec.replicas === 2,
  )
  await synced()
  result.checks.push({
    name: 'replica drift repair',
    passed: true,
    elapsedMs: healedMs,
  })
  const counts = () =>
    kubectl([
      'exec',
      '-n',
      'loremaster',
      'postgres-0',
      '--',
      'psql',
      '-U',
      'migration',
      '-d',
      'loremaster',
      '-Atc',
      "SELECT count(*) FROM information_schema.tables WHERE table_schema='loremaster'",
    ])
  const beforeCount = counts()
  result.checks.push({
    name: 'PostgreSQL pod/PVC recovery',
    passed: true,
    elapsedMs: await recover('postgres'),
  })
  if (counts() !== beforeCount || Number(beforeCount) === 0)
    throw Error('Database schema was lost')
  const cacheKey = `loremaster:v1:revision:${randomUUID()}:suggestions`
  cacheProbe('worker', cacheKey, 's9-persisted')
  await delay(1500)
  result.checks.push({
    name: 'Redis AOF/PVC recovery',
    passed: true,
    elapsedMs: await recover('redis'),
  })
  cacheProbe('api', cacheKey)
  cacheProbe('worker', cacheKey, '')
  await synced()
  const values = JSON.parse(snapshot)
  values.components = { api: { replicas: 1 } }
  save(imageValues, values)
  run(process.execPath, ['scripts/s9-local.mjs', 'sync'])
  await synced()
  if (get('deployment', 'api').spec.replicas !== 1)
    throw Error('Desired Git change did not roll out')
  save(imageValues, JSON.parse(snapshot))
  run(process.execPath, ['scripts/s9-local.mjs', 'sync'])
  await synced()
  if (get('deployment', 'api').spec.replicas !== 2)
    throw Error('Git rollback did not restore replicas')
  result.checks.push({ name: 'desired Git change and rollback', passed: true })
  const gateway = JSON.parse(
    kubectl([
      'get',
      'pods',
      '-n',
      'loremaster',
      '-l',
      'app.kubernetes.io/name=web',
      '-o',
      'json',
    ]),
  ).items
  if (gateway.length !== 1 || gateway[0].status.podIP !== '10.244.240.10')
    throw Error('Gateway does not have its exact trusted IP')
  result.checks.push({ name: 'fixed gateway identity', passed: true })
  let forwardOutput = '',
    forwardError
  forward = spawn(
    tool('kubectl'),
    [
      '--kubeconfig',
      kubeconfig,
      '--context',
      `kind-${cluster}`,
      '-n',
      'loremaster',
      'port-forward',
      '--address=127.0.0.1',
      'service/web',
      '18080:8080',
    ],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  forward.stdout.on('data', (chunk) => {
    forwardOutput += chunk.toString()
  })
  forward.stderr.on('data', (chunk) => {
    forwardOutput += chunk.toString()
  })
  forward.on('error', (error) => {
    forwardError = error
  })
  forward.on('exit', (code) => {
    if (code !== null) forwardError = Error('port-forward exited: ' + code)
  })
  await waitFor(
    'gateway port-forward',
    () => {
      if (forwardError) throw forwardError
      return forwardOutput.includes('Forwarding from 127.0.0.1:18080')
    },
    15000,
  )
  const page = await globalThis.fetch('http://127.0.0.1:18080/', {
    signal: globalThis.AbortSignal.timeout(10000),
  })
  if (!page.ok || !(await page.text()).includes('<html'))
    throw Error('Packaged web did not respond')
  const session = await globalThis.fetch(
    'http://127.0.0.1:18080/api/v1/session',
    {
      method: 'POST',
      headers: {
        Origin: 'http://localhost:8080',
        'Content-Type': 'application/json',
      },
      body: '{}',
      signal: globalThis.AbortSignal.timeout(10000),
    },
  )
  if (
    !session.ok ||
    !session.headers.get('set-cookie')?.includes('loremaster_local_')
  )
    throw Error('Real gateway/API session bootstrap failed')
  result.checks.push({
    name: 'packaged gateway HTML and guest session',
    passed: true,
  })
  result.passed = result.checks.every((check) => check.passed)
  if (!result.passed) throw Error('A runtime check failed')
  process.stdout.write('S9 runtime: PASS\n')
} catch (error) {
  result.failure = error instanceof Error ? error.message : String(error)
  process.stderr.write(result.failure + '\n')
  process.exitCode = 1
} finally {
  forward?.kill()
  if (snapshot && readFileSync(imageValues, 'utf8') !== snapshot) {
    save(imageValues, JSON.parse(snapshot))
    // Restore desired state through Git even when a test failed mid-rollout.
    try {
      run(process.execPath, ['scripts/s9-local.mjs', 'sync'])
    } catch (error) {
      result.restoreFailure = error.message
      result.passed = false
      process.exitCode = 1
    }
  }
  result.cluster = cluster
  result.sourceRevision = run('git', ['-C', root, 'rev-parse', 'HEAD'])
  save(output, result)
}
