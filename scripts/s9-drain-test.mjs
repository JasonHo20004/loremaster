import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { resolve } from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { asterQuayContentPack } from '../packages/database/dist/content/fixtures/aster-quay.js'
import { pendingHttpClientScript } from './s8-pending-client.mjs'
import {
  apply,
  cluster,
  documents,
  kubeconfig,
  kubectl,
  render,
  run,
  save,
  state,
} from './s9-common.mjs'
import { generateSecrets, roleSql, secretGroups } from './s9-secrets.mjs'

const namespace = 'loremaster-s9-drain-' + randomUUID().slice(0, 8)
const result = {
  passed: false,
  checkedAt: new Date().toISOString(),
  sourceRevision: run('git', ['rev-parse', 'HEAD']),
  namespace,
  checks: [],
}
let namespaceUid
let lock
let forward
let client
const get = (kind, name = '') =>
  JSON.parse(
    kubectl([
      'get',
      '-n',
      namespace,
      kind,
      ...(name ? [name] : []),
      '-o',
      'json',
    ]),
  )
const exec = (pod, args, options) =>
  kubectl(
    [
      'exec',
      '-n',
      namespace,
      ...(options?.input ? ['-i'] : []),
      pod,
      '--',
      ...args,
    ],
    options,
  )
const sql = (query) =>
  exec(
    'postgres-0',
    [
      'psql',
      '-X',
      '-qAt',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'migration',
      '-d',
      'loremaster',
    ],
    { input: query, sensitive: true },
  )
async function until(description, check, timeout = 90000, interval = 500) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (await check()) return Date.now() - start
    await delay(interval)
  }
  throw Error('Timed out: ' + description)
}
function child(command, args) {
  const proc = spawn(command, args, {
    cwd: process.cwd(),
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  proc.output = ''
  proc.stdout.on('data', (chunk) => {
    proc.output = (proc.output + chunk.toString()).slice(-4096)
  })
  // Never retain stderr from processes that could report connection credentials.
  proc.stderr.resume()
  proc.stdin.on('error', () => {
    proc.failed = true
  })
  proc.on('error', () => {
    proc.failed = true
  })
  return proc
}
function kubeChild(args) {
  return child('kubectl', [
    '--kubeconfig',
    kubeconfig,
    '--context',
    `kind-${cluster}`,
    '-n',
    namespace,
    ...args,
  ])
}
async function releaseLock() {
  if (!lock) return
  if (lock.exitCode === null) {
    lock.stdin.end('COMMIT;\n')
    await until('SQL lock released', () => lock.exitCode !== null, 5000)
  }
  assert.equal(lock.exitCode, 0, 'Lock session failed')
  lock = undefined
}
function ready(name, kind = 'deployment') {
  kubectl(
    ['rollout', 'status', '-n', namespace, `${kind}/${name}`, '--timeout=150s'],
    { timeout: 160000 },
  )
}
function pod(name) {
  const pods = get('pods').items.filter(
    (item) =>
      item.metadata.labels?.['app.kubernetes.io/name'] === name &&
      !item.metadata.deletionTimestamp &&
      item.status.conditions?.some(
        (condition) =>
          condition.type === 'Ready' && condition.status === 'True',
      ),
  )
  assert.equal(pods.length, 1, 'Expected one ready ' + name)
  return pods[0]
}
async function terminate(before, active) {
  const name = before.metadata.labels['app.kubernetes.io/name']
  const containerId =
    before.status.containerStatuses[0].containerID.split('://')[1]
  const started = Date.now()
  kubectl([
    'delete',
    '-n',
    namespace,
    'pod',
    before.metadata.name,
    '--wait=false',
  ])
  let status
  await until(
    name + ' graceful container exit',
    () => {
      status = JSON.parse(
        run('docker', [
          'exec',
          before.spec.nodeName,
          'crictl',
          'inspect',
          containerId,
        ]),
      ).status
      return status.state === 'CONTAINER_EXITED'
    },
    (before.spec.terminationGracePeriodSeconds + 5) * 1000,
    100,
  )
  const finishedAt = /^\d+$/u.test(String(status.finishedAt))
    ? Number(BigInt(status.finishedAt) / 1000000n)
    : Date.parse(status.finishedAt)
  const drainMs = finishedAt - started
  assert.equal(status.exitCode, 0, name + ' was killed or failed')
  assert.notEqual(status.reason, 'OOMKilled')
  assert(
    drainMs >= 0 && drainMs <= before.spec.terminationGracePeriodSeconds * 1000,
    name + ' exceeded grace budget',
  )
  const record = {
    name,
    active,
    signal: 'Kubernetes pod deletion / kubelet SIGTERM',
    graceSeconds: before.spec.terminationGracePeriodSeconds,
    drainMs,
    exitCode: status.exitCode,
    oomKilled: false,
    passed: true,
  }
  result.checks.push(record)
  return record
}
function nodeExec(name, source) {
  return exec(`deployment/${name}`, ['/usr/local/bin/node', '-e', source])
}
async function operator(name) {
  const [job] = documents(
    render([
      '--set',
      `operator=${name}`,
      '--set',
      'importDryRun=false',
      '--show-only',
      'templates/operators.yaml',
    ]),
  )
  apply(job, namespace)
  await until(
    name + ' operator',
    () => {
      const state = get('job', job.metadata.name).status
      assert(!state.failed, name + ' operator failed')
      return state.succeeded === 1
    },
    130000,
  )
  kubectl([
    'delete',
    '-n',
    namespace,
    'job',
    job.metadata.name,
    '--wait=true',
    '--timeout=30s',
  ])
}

try {
  run(process.execPath, ['scripts/s9-local.mjs', 'status'])
  apply(
    {
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: {
        name: namespace,
        labels: {
          'app.kubernetes.io/part-of': cluster,
          'pod-security.kubernetes.io/enforce': 'restricted',
          'pod-security.kubernetes.io/enforce-version': 'v1.34',
        },
      },
    },
    'default',
  )
  namespaceUid = get('namespace', namespace).metadata.uid
  apply(
    {
      apiVersion: 'admissionregistration.k8s.io/v1',
      kind: 'ValidatingAdmissionPolicyBinding',
      metadata: { name: namespace },
      spec: {
        policyName: 'loremaster-local-runtime',
        validationActions: ['Deny'],
        matchResources: {
          namespaceSelector: {
            matchLabels: { 'kubernetes.io/metadata.name': namespace },
          },
        },
      },
    },
    'default',
  )
  const secrets = generateSecrets()
  for (const [name, fields] of Object.entries(secretGroups))
    apply(
      {
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: { name: name + '-credentials' },
        data: Object.fromEntries(
          fields.map((field) => [
            field,
            Buffer.from(secrets[field]).toString('base64'),
          ]),
        ),
      },
      namespace,
    )
  const resources = documents(render(['--set', 'components.api.replicas=1']))
  // Reserve no extra fixed gateway IP: HTTP drain connects directly to the API pod.
  for (const resource of resources.filter(
    (item) =>
      item.kind !== 'Deployment' &&
      item.kind !== 'PodDisruptionBudget' &&
      item.metadata.name !== 'web',
  ))
    apply(resource, namespace)
  ready('postgres', 'statefulset')
  ready('redis', 'statefulset')
  await operator('migration')
  sql(roleSql(secrets))
  const day = new Date().toISOString().slice(0, 10)
  const tomorrow = new Date(Date.parse(day + 'T00:00:00Z') + 86400000)
    .toISOString()
    .slice(0, 10)
  const pack = {
    ...asterQuayContentPack,
    opensAt: day + 'T00:00:00.000Z',
    closesAt: tomorrow + 'T00:00:00.000Z',
    slotId: day,
  }
  apply(
    {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: 'import-content' },
      data: {
        'pack.json': Buffer.from(JSON.stringify(pack)).toString('base64'),
      },
    },
    namespace,
  )
  await operator('importer')
  kubectl(['delete', '-n', namespace, 'secret/import-content'])
  assert.equal(
    Number(
      sql(
        "SELECT count(*) FROM loremaster.case_revisions WHERE status='PUBLISHED';",
      ),
    ),
    1,
  )
  const warmJobId =
    'warm-v1-' +
    sql("SELECT id FROM loremaster.case_revisions WHERE status='PUBLISHED';")
  for (const name of ['worker', 'observer']) {
    apply(
      resources.find(
        (item) => item.kind === 'Deployment' && item.metadata.name === name,
      ),
      namespace,
    )
    ready(name)
  }
  lock = kubeChild([
    'exec',
    '-i',
    'postgres-0',
    '--',
    'psql',
    '-X',
    '-q',
    '-v',
    'ON_ERROR_STOP=1',
    '-U',
    'migration',
    '-d',
    'loremaster',
  ])
  lock.stdin.write(
    'BEGIN; LOCK TABLE loremaster.case_entities IN ACCESS EXCLUSIVE MODE;\n',
  )
  await until(
    'held entity-read barrier',
    () =>
      Number(
        sql(
          "SELECT count(*) FROM pg_locks l JOIN pg_class c ON c.oid=l.relation WHERE c.relname='case_entities' AND l.mode='AccessExclusiveLock' AND l.granted;",
        ),
      ) === 1,
    15000,
  )
  const worker = pod('worker')
  apply(
    resources.find(
      (item) => item.kind === 'Deployment' && item.metadata.name === 'api',
    ),
    namespace,
  )
  await until(
    'actual worker blocked on entity read',
    () =>
      Number(
        sql(
          "SELECT count(*) FROM pg_locks l JOIN pg_class c ON c.oid=l.relation JOIN pg_stat_activity a ON a.pid=l.pid WHERE c.relname='case_entities' AND l.mode='AccessShareLock' AND NOT l.granted AND a.usename='worker';",
        ),
      ) >= 1,
    45000,
    100,
  )
  const workerRecord = await terminate(
    worker,
    'published warm job blocked on PostgreSQL entity read',
  )
  workerRecord.blockedReadObserved = true
  await releaseLock()
  ready('worker')
  ready('api')
  const completed = () =>
    Number(
      nodeExec(
        'observer',
        'fetch(\'http://127.0.0.1:3002/metrics\').then(r=>r.text()).then(t=>{const m=t.match(/^loremaster_queue_completed\\{queue="loremaster-warm-v1",version="1"\\} (\\d+)$/m);if(!m)process.exit(1);process.stdout.write(m[1]);}).catch(()=>process.exit(1));',
      ),
    )
  workerRecord.replayMs = await until(
    'same warm job completed after replacement',
    () => completed() >= 1,
    45000,
  )
  workerRecord.completed = completed()
  assert.equal(workerRecord.completed, 1, 'Warm replay must complete once')
  const completedIds = JSON.parse(
    nodeExec(
      'observer',
      "const fs=require('node:fs'),{createRequire}=require('node:module'),app=createRequire('/app/dist/index.js'),cache=createRequire(app.resolve('@loremaster/cache')),{Redis}=cache('ioredis');(async()=>{const r=new Redis(fs.readFileSync(process.env.LOREMASTER_OBSERVER_REDIS_URL_FILE,'utf8'),{lazyConnect:true,enableOfflineQueue:false,connectTimeout:2000,maxRetriesPerRequest:0,retryStrategy:()=>null});r.on('error',()=>{});try{await r.connect();process.stdout.write(JSON.stringify(await r.zrange('loremaster:v1:queue:loremaster-warm-v1:completed',0,-1)));}finally{r.disconnect(false);}})().catch(()=>process.exit(1));",
    ),
  )
  assert.deepEqual(
    completedIds,
    [warmJobId],
    'Expected the original warm job identity after replay',
  )
  workerRecord.replayedJobId = warmJobId
  const api = pod('api')
  forward = kubeChild([
    'port-forward',
    'pod/' + api.metadata.name,
    '--address=127.0.0.1',
    '18081:3000',
  ])
  await until(
    'API port forward',
    () => {
      assert(
        !forward.failed && forward.exitCode === null,
        'Port forward failed',
      )
      return forward.output.includes('Forwarding from')
    },
    15000,
  )
  client = child(process.execPath, [
    '-e',
    pendingHttpClientScript('127.0.0.1', 18081),
  ])
  await until(
    'acknowledged incomplete HTTP body',
    () => {
      assert(
        !client.failed && !client.output.includes('ERROR'),
        'HTTP client failed',
      )
      return client.output.includes('OPEN')
    },
    10000,
    50,
  )
  const apiRecord = await terminate(
    api,
    'acknowledged HTTP request with incomplete JSON body',
  )
  await until(
    'pending HTTP connection closed',
    () => client.exitCode !== null,
    5000,
  )
  assert.equal(client.exitCode, 0)
  assert(client.output.includes('CLOSED'))
  apiRecord.requestAcknowledged = true
  apiRecord.connectionClosed = true
  ready('api')
  await terminate(pod('observer'), 'idle health/metrics service')
  ready('observer')
  const web = resources.find(
    (item) => item.kind === 'Deployment' && item.metadata.name === 'web',
  )
  // The isolated idle-gateway test must not claim the retained lab's fixed IP.
  delete web.spec.template.metadata.annotations
  apply(web, namespace)
  ready('web')
  await terminate(pod('web'), 'idle packaged gateway')
  ready('web')
  const effects = {}
  for (const table of [
    'attempts',
    'guesses',
    'command_receipts',
    'attempt_finalizations',
    'participation_days',
    'knowledge_contributions',
    'regional_knowledge',
    'leaderboard_entries',
  ]) {
    effects[table] = Number(sql(`SELECT count(*) FROM loremaster.${table};`))
    assert.equal(effects[table], 0, 'Warm job wrote gameplay effects: ' + table)
  }
  result.gameplayEffects = effects
  result.passed = true
} catch (error) {
  result.error = error instanceof Error ? error.message : String(error)
  process.exitCode = 1
} finally {
  for (const proc of [client, forward]) if (proc?.exitCode === null) proc.kill()
  try {
    await releaseLock()
  } catch (error) {
    result.lockReleaseError =
      error instanceof Error ? error.message : String(error)
    result.passed = false
    process.exitCode = 1
    if (lock?.exitCode === null) lock.kill()
  }
  try {
    if (namespaceUid) {
      assert.equal(
        get('namespace', namespace).metadata.uid,
        namespaceUid,
        'Test namespace identity changed',
      )
      kubectl([
        'delete',
        'validatingadmissionpolicybinding',
        namespace,
        '--ignore-not-found',
      ])
      kubectl(['delete', 'namespace', namespace, '--wait=false'])
      await until(
        'test namespace removed',
        () => {
          const names = JSON.parse(
            kubectl(['get', 'namespaces', '-o', 'json']),
          ).items
          return !names.some((item) => item.metadata.uid === namespaceUid)
        },
        90000,
        1500,
      )
      await until(
        'test PV storage reclaimed',
        () =>
          !JSON.parse(kubectl(['get', 'pv', '-o', 'json'])).items.some(
            (item) => item.spec.claimRef?.namespace === namespace,
          ),
        60000,
        1500,
      )
    }
    result.teardown = 'PASS'
  } catch (error) {
    result.teardown = error instanceof Error ? error.message : String(error)
    result.passed = false
    process.exitCode = 1
  }
  if (lock?.exitCode === null) lock.kill()
  save(resolve(state, 'drain.json'), result)
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
}
