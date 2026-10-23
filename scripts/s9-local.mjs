import { createHash } from 'node:crypto'
import { Buffer } from 'node:buffer'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { buildContext } from './s8-context.mjs'
import { validateContentFile } from './s8-compose-inputs.mjs'
import {
  apply,
  assertAdmission,
  assertRuntimePolicy,
  chart,
  cluster,
  configureCalico,
  documents,
  imageValues,
  json,
  kubeconfig,
  kubectl,
  render,
  registryManifest,
  root,
  run,
  save,
  state,
  tool,
  versions,
} from './s9-common.mjs'
import { generateSecrets, roleSql, secretGroups } from './s9-secrets.mjs'
import { download, installTools } from './s9-tools.mjs'
import { runtimeConfig, runtimeSpec } from './s9-runtime-config.mjs'

const marker = resolve(state, 'cluster.json')
const registry = cluster + '-registry'
const gitServer = cluster + '-git'
const label = 'org.loremaster.s9.owner'
const secretPath = resolve(state, 'secrets.json')
const command = process.argv[2]
const sourceFile = (path) => readFileSync(resolve(root, path), 'utf8')
const docker = (args, options) => run('docker', args, options)
function requireOwner() {
  if (!existsSync(marker) || json(marker).name !== cluster)
    throw Error('No S9-owned cluster; run cluster first')
  const container = JSON.parse(
    docker(['inspect', cluster + '-control-plane']),
  )[0]
  if (
    container.Config.Labels['io.x-k8s.kind.cluster'] !== cluster ||
    container.Id !== json(marker).controlPlaneId
  )
    throw Error('Cluster identity changed; refusing operation')
}
function requireNamespace() {
  requireOwner()
  const namespace = JSON.parse(
    kubectl(['get', 'namespace', 'loremaster', '-o', 'json']),
  )
  if (namespace.metadata.labels['app.kubernetes.io/part-of'] !== cluster)
    throw Error('Namespace ownership mismatch')
}
function ownedContainer(name) {
  const names = docker(['ps', '-a', '--format', '{{.Names}}']).split(/\r?\n/u)
  if (!names.includes(name)) return false
  const found = JSON.parse(docker(['inspect', name]))[0]
  if (found.Config.Labels[label] !== cluster)
    throw Error('Unowned container name collision: ' + name)
  return found
}
function startRegistry() {
  if (!ownedContainer(registry)) {
    docker([
      'run',
      '-d',
      '--name',
      registry,
      '--label',
      `${label}=${cluster}`,
      '--restart=unless-stopped',
      '-p',
      '127.0.0.1:5001:5000',
      versions.registryImage,
    ])
  } else docker(['start', registry])
}
function contextDigest(name) {
  const profile = name === 'web' ? 'web-public' : name
  const directory = mkdtempSync(resolve(tmpdir(), 'loremaster-s9-context-'))
  try {
    const manifest = buildContext(profile, resolve(directory, 'context'))
    return createHash('sha256').update(JSON.stringify(manifest)).digest('hex')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}
function preflight() {
  if (process.version !== 'v' + sourceFile('.node-version').trim())
    throw Error('Use the pinned Node version from .node-version')
  if (!run(tool('kind'), ['version']).includes('v' + versions.kind))
    throw Error('kind version mismatch; run tools')
  if (
    !run(tool('helm'), ['version', '--short']).startsWith(
      'v' + versions.helm + '+',
    )
  )
    throw Error('Helm version mismatch; run tools')
  const client = JSON.parse(
    run('kubectl', ['version', '--client', '-o', 'json']),
  ).clientVersion
  if (
    client.major !== '1' ||
    !['33', '34', '35'].includes(client.minor.replace(/\D/gu, ''))
  )
    throw Error('kubectl must be within one minor of Kubernetes 1.34')
  const info = JSON.parse(
    docker(['info', '--format', '{{json .}}'], { timeout: 15000 }),
  )
  if (info.OSType !== 'linux' || info.NCPU < 4 || info.MemTotal < 8 * 1024 ** 3)
    throw Error(
      'Linux Docker requires at least 4 CPU / 8 GiB RAM for four nodes and controllers',
    )
  save(resolve(state, 'preflight.json'), {
    passed: true,
    checkedAt: new Date().toISOString(),
    node: process.version,
    kind: versions.kind,
    helm: versions.helm,
    docker: info.ServerVersion,
    cpus: info.NCPU,
    memoryBytes: info.MemTotal,
  })
}
async function createCluster() {
  preflight()
  const clusters = run(tool('kind'), ['get', 'clusters']).split(/\r?\n/u)
  if (clusters.includes(cluster)) requireOwner()
  else {
    startRegistry()
    run(
      tool('kind'),
      [
        'create',
        'cluster',
        '--name',
        cluster,
        '--image',
        versions.nodeImage,
        '--config',
        resolve(root, 'platform/local/kind.yaml'),
        '--kubeconfig',
        kubeconfig,
        '--wait',
        '0s',
      ],
      { timeout: 300000 },
    )
    const controlPlane = JSON.parse(
      docker(['inspect', cluster + '-control-plane']),
    )[0]
    save(marker, {
      name: cluster,
      controlPlaneId: controlPlane.Id,
      createdAt: new Date().toISOString(),
    })
  }
  startRegistry()
  const registryInfo = ownedContainer(registry)
  if (!registryInfo.NetworkSettings.Networks.kind)
    docker(['network', 'connect', 'kind', registry])
  for (const node of run(tool('kind'), [
    'get',
    'nodes',
    '--name',
    cluster,
  ]).split(/\r?\n/u)) {
    const directory = '/etc/containerd/certs.d/localhost:5001'
    docker(['exec', node, 'mkdir', '-p', directory])
    docker(
      ['exec', '-i', node, 'cp', '/dev/stdin', directory + '/hosts.toml'],
      { input: `[host."http://${registry}:5000"]\n` },
    )
    const base = JSON.parse(
      docker(['exec', node, 'cat', '/etc/containerd/cri-base.json']),
    )
    let specChanged = false
    for (const [name, limit] of [
      ['loremaster', 128],
      ['loremaster-redis', 64],
    ]) {
      const path = `/etc/containerd/${name}-spec.json`
      const spec = JSON.stringify(runtimeSpec(base, limit))
      const existing = docker([
        'exec',
        node,
        'sh',
        '-c',
        `cat ${path} 2>/dev/null || true`,
      ])
      if (existing !== spec) {
        docker(['exec', '-i', node, 'cp', '/dev/stdin', path], { input: spec })
        specChanged = true
      }
    }
    const config = docker(['exec', node, 'cat', '/etc/containerd/config.toml'])
    const configuredRuntime = runtimeConfig(config)
    if (configuredRuntime !== config || specChanged) {
      docker(
        ['exec', '-i', node, 'cp', '/dev/stdin', '/etc/containerd/config.toml'],
        { input: configuredRuntime },
      )
      docker(['exec', node, 'systemctl', 'restart', 'containerd'])
    }
  }
  const calico = (
    await download(
      versions.calico.url,
      versions.calico.sha256,
      resolve(state, 'calico.yaml'),
    )
  ).toString('utf8')
  kubectl(['apply', '--server-side', '-f', '-'], {
    input: JSON.stringify(configureCalico(calico)),
  })
  kubectl(
    ['wait', 'nodes', '--all', '--for=condition=Ready', '--timeout=240s'],
    { timeout: 250000 },
  )
  // Apply the PID ceiling to every kubelet, including joined workers.
  for (const node of run(tool('kind'), [
    'get',
    'nodes',
    '--name',
    cluster,
  ]).split(/\r?\n/u)) {
    docker([
      'exec',
      node,
      'sh',
      '-c',
      "sed -i 's/^podPidsLimit:.*/podPidsLimit: 128/' /var/lib/kubelet/config.yaml; grep -q '^podPidsLimit:' /var/lib/kubelet/config.yaml || printf '\npodPidsLimit: 128\n' >> /var/lib/kubelet/config.yaml; systemctl restart kubelet",
    ])
  }
  kubectl(
    ['wait', 'nodes', '--all', '--for=condition=Ready', '--timeout=120s'],
    { timeout: 130000 },
  )
  apply(sourceFile('platform/local/namespace.yaml'))
  kubectl(['apply', '-f', resolve(root, 'platform/local/runtime.yaml')])
  // Argo controllers are platform-owned and installed from hash-verified bytes.
  apply(
    {
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: {
        name: 'argocd',
        labels: { 'app.kubernetes.io/part-of': cluster },
      },
    },
    'default',
  )
  const argo = await download(
    versions.argocd.url,
    versions.argocd.sha256,
    resolve(state, 'argocd.yaml'),
  )
  kubectl(['apply', '-n', 'argocd', '--server-side', '-f', '-'], {
    input: argo.toString('utf8'),
  })
  kubectl(
    [
      'rollout',
      'status',
      '-n',
      'argocd',
      'deployment/argocd-repo-server',
      '--timeout=240s',
    ],
    { timeout: 250000 },
  )
  kubectl(
    [
      'rollout',
      'status',
      '-n',
      'argocd',
      'statefulset/argocd-application-controller',
      '--timeout=180s',
    ],
    { timeout: 190000 },
  )
  const nodes = JSON.parse(kubectl(['get', 'nodes', '-o', 'json'])).items
  save(resolve(state, 'platform.json'), {
    passed:
      nodes.length === 4 &&
      nodes.every((node) =>
        node.status.conditions.some(
          (condition) =>
            condition.type === 'Ready' && condition.status === 'True',
        ),
      ),
    checkedAt: new Date().toISOString(),
    versions,
    nodes: nodes.map((node) => ({
      name: node.metadata.name,
      uid: node.metadata.uid,
      version: node.status.nodeInfo.kubeletVersion,
    })),
  })
}
async function promote() {
  requireNamespace()
  const builds = json(resolve(root, '.cache/s8-build-results.json'))
  const scans = json(resolve(root, '.cache/s8-evidence/summary.json'))
  const revision = run('git', ['rev-parse', 'HEAD'])
  const inspected = Object.fromEntries(
    ['api', 'worker', 'observer', 'web', 'migration', 'importer'].map(
      (name) => [
        name,
        JSON.parse(docker(['image', 'inspect', `loremaster/${name}:s8`]))[0],
      ],
    ),
  )
  assertAdmission(
    builds,
    scans,
    (name) => inspected[name],
    revision,
    contextDigest,
  )
  const images = {}
  const evidence = []
  for (const name of Object.keys(inspected)) {
    const image = inspected[name]
    const tag = `localhost:5001/loremaster/${name}:candidate`
    docker(['tag', image.Id, tag])
    docker(['push', tag], { timeout: 180000 })
    const digests = JSON.parse(docker(['image', 'inspect', tag]))[0].RepoDigests
    const digest = digests.find((value) =>
      value.startsWith(`localhost:5001/loremaster/${name}@sha256:`),
    )
    if (!digest) throw Error('Registry digest missing: ' + name)
    // Pull back by digest and independently bind registry config bytes to the scanner's saved config hash.
    docker(['pull', digest], { timeout: 120000 })
    if (JSON.parse(docker(['image', 'inspect', digest]))[0].Id !== image.Id)
      throw Error('Registry image differs from scanned config')
    const readManifest = async (digest) => {
      const response = await globalThis.fetch(
        `http://127.0.0.1:5001/v2/loremaster/${name}/manifests/${digest}`,
        {
          headers: {
            Accept:
              'application/vnd.oci.image.manifest.v1+json, application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.v2+json',
          },
          signal: globalThis.AbortSignal.timeout(15000),
        },
      )
      if (!response.ok) throw Error('Registry manifest unavailable')
      return registryManifest(Buffer.from(await response.arrayBuffer()), digest)
    }
    let manifest = await readManifest(digest.split('@')[1])
    if (manifest.manifests) {
      const candidates = manifest.manifests.filter(
        (item) =>
          item.platform?.os === 'linux' &&
          item.platform?.architecture === 'amd64',
      )
      if (candidates.length !== 1)
        throw Error('Expected one Linux/amd64 manifest')
      manifest = await readManifest(candidates[0].digest)
    }
    const scan = scans.find((scan) => scan.image === `loremaster/${name}:s8`)
    if (manifest.config?.digest !== `sha256:${scan.configSha256}`)
      throw Error('Registry config differs from scanned config hash')
    images[name] = digest
    evidence.push({
      name,
      imageId: image.Id,
      manifest: digest,
      configSha256: scan.configSha256,
      revision,
      contextSha256: image.Config.Labels['org.loremaster.context.sha256'],
    })
  }
  save(imageValues, { images })
  assertRuntimePolicy(documents(render()))
  save(resolve(state, 'promotion.json'), {
    passed: true,
    promotedAt: new Date().toISOString(),
    images: evidence,
  })
}
function prepareSecrets() {
  const remote = JSON.parse(
    kubectl(['get', 'secrets', '-n', 'loremaster', '-o', 'json']),
  ).items
  const claims = JSON.parse(
    kubectl(['get', 'pvc', '-n', 'loremaster', '-o', 'json']),
  ).items
  if (!existsSync(secretPath)) {
    if (
      claims.length ||
      remote.some((secret) =>
        Object.keys(secretGroups).some(
          (name) => secret.metadata.name === name + '-credentials',
        ),
      )
    )
      throw Error(
        'Retained data or credentials exist: restore original .cache/s9/secrets.json; credentials must not be regenerated',
      )
    save(secretPath, generateSecrets())
  }
  const secrets = json(secretPath)
  for (const [group, names] of Object.entries(secretGroups)) {
    const data = Object.fromEntries(
      names.map((name) => {
        if (typeof secrets[name] !== 'string' || !secrets[name].length)
          throw Error('Missing secret: ' + name)
        return [name, Buffer.from(secrets[name]).toString('base64')]
      }),
    )
    const prior = remote.find(
      (secret) => secret.metadata.name === group + '-credentials',
    )
    if (
      prior &&
      JSON.stringify(Object.entries(prior.data).sort()) !==
        JSON.stringify(Object.entries(data).sort())
    )
      throw Error(
        'Credential mismatch: restore original secrets; rotation requires an explicit operation',
      )
    apply({
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name: group + '-credentials',
        labels: { 'app.kubernetes.io/part-of': cluster },
      },
      type: 'Opaque',
      data,
    })
  }
  return secrets
}
function operator(name, publish = false) {
  const job = documents(
    render([
      '--set',
      `operator=${name}`,
      '--set',
      `importDryRun=${!publish}`,
      '--show-only',
      'templates/operators.yaml',
    ]),
  )[0]
  job.metadata.name = `${name}-${Date.now()}`
  apply(job)
  kubectl(
    [
      'wait',
      '-n',
      'loremaster',
      `job/${job.metadata.name}`,
      '--for=condition=complete',
      '--timeout=130s',
    ],
    { timeout: 140000 },
  )
  const pods = JSON.parse(
    kubectl([
      'get',
      'pods',
      '-n',
      'loremaster',
      '-l',
      `job-name=${job.metadata.name}`,
      '-o',
      'json',
    ]),
  ).items
  if (
    pods.length !== 1 ||
    pods[0].status.containerStatuses?.[0]?.state?.terminated?.exitCode !== 0
  )
    throw Error('Operator did not exit zero')
  kubectl([
    'delete',
    '-n',
    'loremaster',
    'job',
    job.metadata.name,
    '--wait=true',
    '--timeout=30s',
  ])
}
function bootstrap() {
  requireNamespace()
  const secrets = prepareSecrets()
  const rendered = documents(render())
  assertRuntimePolicy(rendered)
  // Only the first bootstrap applies app policies/data imperatively. Argo owns subsequent changes.
  const app = JSON.parse(
    kubectl(['get', 'applications', '-n', 'argocd', '-o', 'json']),
  ).items.find((item) => item.metadata.name === 'loremaster-local')
  if (app)
    throw Error(
      'GitOps already owns the runtime; use migration explicitly, then sync',
    )
  for (const resource of rendered.filter(
    (resource) =>
      ['StatefulSet', 'NetworkPolicy'].includes(resource.kind) ||
      (resource.kind === 'Service' &&
        ['postgres', 'redis'].includes(resource.metadata.name)),
  ))
    apply(resource)
  for (const name of ['postgres', 'redis'])
    kubectl(
      [
        'rollout',
        'status',
        '-n',
        'loremaster',
        `statefulset/${name}`,
        '--timeout=150s',
      ],
      { timeout: 160000 },
    )
  operator('migration')
  kubectl(
    [
      'exec',
      '-i',
      '-n',
      'loremaster',
      'postgres-0',
      '--',
      'psql',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'migration',
      '-d',
      'loremaster',
    ],
    { input: roleSql(secrets), sensitive: true },
  )
  save(resolve(state, 'bootstrap.json'), {
    passed: true,
    bootstrappedAt: new Date().toISOString(),
    clusterId: json(marker).controlPlaneId,
  })
}
function copyChart(source, destination) {
  mkdirSync(destination, { recursive: true })
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw Error('Symlink in GitOps source')
    const from = resolve(source, entry.name),
      to = resolve(destination, entry.name)
    if (entry.isDirectory()) copyChart(from, to)
    else if (entry.isFile()) cpSync(from, to)
  }
}
async function sync() {
  requireNamespace()
  if (
    !existsSync(resolve(state, 'bootstrap.json')) ||
    json(resolve(state, 'bootstrap.json')).clusterId !==
      json(marker).controlPlaneId
  )
    throw Error('Run bootstrap first')
  assertRuntimePolicy(documents(render()))
  const directory = resolve(state, 'git')
  const worktree = resolve(directory, 'worktree')
  const bare = resolve(directory, 'repository.git')
  mkdirSync(worktree, { recursive: true })
  const git = (args) => run('git', ['-C', worktree, ...args])
  if (!existsSync(resolve(worktree, '.git')))
    git(['init', '--initial-branch=main'])
  // Only chart and admitted image values enter this separate local repository.
  git(['rm', '-r', '--ignore-unmatch', 'deploy'])
  copyChart(chart, resolve(worktree, 'deploy/helm/loremaster'))
  mkdirSync(resolve(worktree, 'deploy/environments/local'), { recursive: true })
  cpSync(
    imageValues,
    resolve(worktree, 'deploy/environments/local/images.yaml'),
  )
  git(['add', 'deploy'])
  git([
    '-c',
    'user.name=Loremaster Local',
    '-c',
    'user.email=local@loremaster.invalid',
    'commit',
    '--allow-empty',
    '-m',
    `S9 local snapshot from ${run('git', ['rev-parse', 'HEAD'])}`,
  ])
  if (!existsSync(bare))
    run('git', ['init', '--bare', '--initial-branch=main', bare])
  git(['push', bare, 'main'])
  run('git', ['--git-dir', bare, 'update-server-info'])
  const existingServer = ownedContainer(gitServer)
  if (existingServer && existingServer.Config.Image !== versions.gitImage)
    docker(['rm', '-f', '-v', gitServer])
  if (!ownedContainer(gitServer))
    docker([
      'run',
      '-d',
      '--name',
      gitServer,
      '--label',
      `${label}=${cluster}`,
      '--network',
      'kind',
      '--read-only',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges:true',
      '--memory=64m',
      '--cpus=0.25',
      '--pids-limit=32',
      '--tmpfs',
      '/tmp:rw,noexec,nosuid,size=16m',
      '--mount',
      `type=bind,src=${directory},dst=/srv/git,readonly`,
      '--entrypoint',
      '/usr/bin/git',
      versions.gitImage,
      '-c',
      'safe.directory=/srv/git/repository.git',
      'daemon',
      '--reuseaddr',
      '--base-path=/srv/git',
      '--export-all',
      '--listen=0.0.0.0',
      '--port=9418',
      '--strict-paths',
      '/srv/git/repository.git',
    ])
  else docker(['start', gitServer])
  docker(['exec', gitServer, '/usr/bin/git', '--version'])
  const address =
    ownedContainer(gitServer).NetworkSettings.Networks.kind.IPAddress
  if (!address) throw Error('Local Git server has no kind network address')
  apply(
    {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: 'git-source' },
      spec: { ports: [{ name: 'git', port: 9418 }] },
    },
    'argocd',
  )
  apply(
    {
      apiVersion: 'discovery.k8s.io/v1',
      kind: 'EndpointSlice',
      metadata: {
        name: 'git-source',
        labels: { 'kubernetes.io/service-name': 'git-source' },
      },
      addressType: 'IPv4',
      ports: [{ name: 'git', protocol: 'TCP', port: 9418 }],
      endpoints: [{ addresses: [address], conditions: { ready: true } }],
    },
    'argocd',
  )
  // Wait for kube-proxy's EndpointSlice update before Argo caches its first list-refs result.
  const deadline = Date.now() + 30000
  let sourceReady = false,
    sourceError
  while (Date.now() < deadline) {
    try {
      kubectl([
        'exec',
        '-n',
        'argocd',
        'deployment/argocd-repo-server',
        '-c',
        'argocd-repo-server',
        '--',
        'git',
        'ls-remote',
        'git://git-source.argocd.svc.cluster.local:9418/repository.git',
      ])
      sourceReady = true
      break
    } catch (error) {
      sourceError = error
      await delay(500)
    }
  }
  if (!sourceReady)
    throw sourceError ?? Error('Git source did not become reachable')
  apply(sourceFile('platform/argocd/project.yaml'), 'argocd')
  apply(sourceFile('platform/argocd/application.yaml'), 'argocd')
  kubectl([
    'annotate',
    '-n',
    'argocd',
    'application/loremaster-local',
    'argocd.argoproj.io/refresh=hard',
    '--overwrite',
  ])
  save(resolve(state, 'gitops-source.json'), {
    sourceRevision: run('git', ['rev-parse', 'HEAD']),
    desiredRevision: git(['rev-parse', 'HEAD']),
    images: json(imageValues).images,
  })
}
function destroy() {
  if (process.argv[3] !== '--delete-data')
    throw Error(
      'destroy requires --delete-data; kind node volumes contain PostgreSQL/Redis data',
    )
  requireOwner()
  for (const name of [registry, gitServer]) ownedContainer(name)
  run(
    tool('kind'),
    ['delete', 'cluster', '--name', cluster, '--kubeconfig', kubeconfig],
    { timeout: 180000 },
  )
  for (const name of [registry, gitServer])
    if (ownedContainer(name)) docker(['rm', '-f', '-v', name])
  if (run(tool('kind'), ['get', 'clusters']).split(/\r?\n/u).includes(cluster))
    throw Error('Cluster still exists after teardown')
  if (
    docker([
      'ps',
      '-a',
      '--filter',
      `label=${label}=${cluster}`,
      '--format',
      '{{.ID}}',
    ])
  )
    throw Error('Owned containers remain after teardown')
  save(resolve(state, 'teardown.json'), {
    passed: true,
    checkedAt: new Date().toISOString(),
  })
}
try {
  mkdirSync(state, { recursive: true })
  switch (command) {
    case 'tools':
      await installTools()
      break
    case 'preflight':
      preflight()
      break
    case 'cluster':
      await createCluster()
      break
    case 'promote':
      await promote()
      break
    case 'render':
      assertRuntimePolicy(documents(render()))
      writeFileSync(resolve(state, 'rendered.yaml'), render())
      break
    case 'bootstrap':
      bootstrap()
      break
    case 'migration':
      requireNamespace()
      operator('migration')
      break
    case 'sync':
      await sync()
      break
    case 'import': {
      requireNamespace()
      if (
        process.argv.slice(3).some((argument) => argument !== '--publish') ||
        process.argv.length > 4
      )
        throw Error('Usage: import [--publish]')
      const path = process.env.LOREMASTER_S9_CONTENT_FILE
      validateContentFile(path ?? '')
      if (lstatSync(path).isSymbolicLink())
        throw Error('Content symlink rejected')
      apply({
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: { name: 'import-content' },
        data: { 'pack.json': readFileSync(path).toString('base64') },
      })
      try {
        operator('importer', process.argv[3] === '--publish')
      } finally {
        kubectl([
          'delete',
          'secret/import-content',
          '-n',
          'loremaster',
          '--ignore-not-found',
        ])
      }
      break
    }
    case 'status':
      requireNamespace()
      process.stdout.write(
        kubectl(['get', 'pods,services,pvc', '-n', 'loremaster']) +
          '\n' +
          kubectl(['get', 'application', '-n', 'argocd', 'loremaster-local']) +
          '\n',
      )
      break
    case 'forward':
      requireNamespace()
      kubectl(
        [
          'port-forward',
          '-n',
          'loremaster',
          'service/web',
          '--address=127.0.0.1',
          '8080:8080',
        ],
        { stdio: 'inherit', timeout: undefined },
      )
      break
    case 'destroy':
      destroy()
      break
    default:
      throw Error(
        'Usage: node scripts/s9-local.mjs <tools|preflight|cluster|promote|render|bootstrap|migration|import [--publish]|sync|status|forward|destroy --delete-data>',
      )
  }
  process.stdout.write(`S9 ${command}: PASS\n`)
  const priorFailure = resolve(state, 'last-failure.json')
  if (existsSync(priorFailure) && json(priorFailure).command === command)
    rmSync(priorFailure)
} catch (error) {
  save(resolve(state, 'last-failure.json'), {
    command,
    passed: false,
    at: new Date().toISOString(),
  })
  process.stderr.write(
    (error instanceof Error ? error.message : String(error)) + '\n',
  )
  process.exitCode = 1
}
