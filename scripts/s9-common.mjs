import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseAllDocuments } from 'yaml'

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const state = resolve(root, '.cache/s9')
export const cluster = 'loremaster-s9'
export const versions = JSON.parse(
  readFileSync(resolve(root, 'platform/local/versions.json'), 'utf8'),
)
export const chart = resolve(root, 'deploy/helm/loremaster')
export const imageValues = resolve(state, 'images.json')
export const kubeconfig = resolve(state, 'kubeconfig')

export function json(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}
export function save(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
}
export function run(command, args, options = {}) {
  const { sensitive = false, ...spawnOptions } = options
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
    ...spawnOptions,
  })
  if (result.error || result.status !== 0) {
    throw Error(
      `${command.split(/[\\/]/u).at(-1)} ${args[0]} failed${sensitive ? '' : ': ' + (result.error?.code ?? result.stderr?.trim().slice(-1800))}`,
    )
  }
  return result.stdout?.trim() ?? ''
}
export function tool(name) {
  const local = ['kind', 'kubectl'].includes(name)
    ? resolve(
        state,
        'tools',
        name + (process.platform === 'win32' ? '.exe' : ''),
      )
    : resolve(
        state,
        'tools/helm',
        process.platform === 'win32'
          ? 'windows-amd64/helm.exe'
          : 'linux-amd64/helm',
      )
  return existsSync(local) ? local : name
}
export function kubectl(args, options) {
  return run(
    tool('kubectl'),
    [
      '--kubeconfig',
      kubeconfig,
      '--context',
      `kind-${cluster}`,
      ['wait', 'rollout', 'port-forward'].includes(args[0])
        ? '--request-timeout=0'
        : '--request-timeout=15s',
      ...args,
    ],
    options,
  )
}
export function apply(documents, namespace = 'loremaster') {
  kubectl(['apply', '-n', namespace, '-f', '-'], {
    input:
      typeof documents === 'string' ? documents : JSON.stringify(documents),
    sensitive:
      typeof documents === 'string'
        ? /kind:\s*Secret\b/u.test(documents)
        : documents.kind === 'Secret' ||
          documents.items?.some((item) => item.kind === 'Secret'),
  })
}
export function render(extra = [], values = imageValues) {
  return run(tool('helm'), [
    'template',
    'loremaster',
    chart,
    '--namespace',
    'loremaster',
    '-f',
    values,
    ...extra,
  ])
}
export function documents(source) {
  return parseAllDocuments(source)
    .map((document) => {
      if (document.errors.length)
        throw Error('Invalid rendered YAML: ' + document.errors[0].message)
      return document.toJSON()
    })
    .filter(Boolean)
}

export function configureCalico(source) {
  const resources = documents(source)
  const daemon = resources.find(
    (resource) =>
      resource.kind === 'DaemonSet' && resource.metadata.name === 'calico-node',
  )
  if (!daemon) throw Error('Pinned Calico daemon missing')
  const pod = daemon.spec.template.spec
  const node = pod.containers.find(
    (container) => container.name === 'calico-node',
  )
  // kind's nested /sys is read-only and Docker Desktop may omit securityfs.
  // This local profile uses iptables, so the optional eBPF lockdown mount is unnecessary.
  pod.volumes = pod.volumes.filter(
    (volume) => volume.name !== 'sys-kernel-security',
  )
  node.volumeMounts = node.volumeMounts.filter(
    (volume) => volume.name !== 'sys-kernel-security',
  )
  node.env = node.env.filter(
    (field) =>
      !['CALICO_IPV4POOL_CIDR', 'FELIX_BPFENABLED'].includes(field.name),
  )
  node.env.push(
    { name: 'CALICO_IPV4POOL_CIDR', value: '10.244.0.0/16' },
    { name: 'FELIX_BPFENABLED', value: 'false' },
  )
  return { apiVersion: 'v1', kind: 'List', items: resources }
}

export function assertAdmission(builds, scans, inspect, revision, contexts) {
  const names = ['api', 'worker', 'observer', 'web', 'migration', 'importer']
  if (builds.length !== 6 || scans.length !== 6)
    throw Error('Six build and scan records required')
  for (const name of names) {
    const build = builds.find(
      (record) => record.image === `loremaster/${name}:s8`,
    )
    const scan = scans.find((record) => record.image === build?.image)
    const image = inspect(name)
    if (
      !build ||
      !scan ||
      build.revision !== revision ||
      scan.id !== build.id ||
      image.Id !== build.id ||
      image.Config.Labels['org.opencontainers.image.revision'] !== revision ||
      build.contextSha256 !== contexts(name) ||
      image.Config.Labels['org.loremaster.context.sha256'] !==
        build.contextSha256 ||
      !Array.isArray(scan.violations) ||
      scan.violations.length ||
      scan.secretFindings !== 0 ||
      !/^[a-f0-9]{64}$/u.test(scan.configSha256 ?? '') ||
      !Number.isFinite(Date.parse(scan.scannedAt)) ||
      Date.now() - Date.parse(scan.scannedAt) > 86400000 ||
      Date.parse(scan.scannedAt) > Date.now() + 60000
    )
      throw Error(`Image admission failed: ${name}`)
  }
}

export function registryManifest(bytes, digest) {
  if ('sha256:' + createHash('sha256').update(bytes).digest('hex') !== digest)
    throw Error('Registry manifest digest mismatch')
  return JSON.parse(bytes.toString('utf8'))
}

export function assertRuntimePolicy(resources) {
  const workloads = resources.filter((resource) =>
    ['Deployment', 'StatefulSet', 'Job'].includes(resource.kind),
  )
  if (workloads.length !== 6)
    throw Error('Expected four apps and two data services')
  for (const resource of workloads) {
    const pod = resource.spec.template.spec
    const uid = {
      api: 10002,
      worker: 10003,
      observer: 10004,
      web: 10001,
      postgres: 70,
      redis: 999,
    }[resource.metadata.name]
    if (
      uid === undefined ||
      pod.securityContext.runAsUser !== uid ||
      pod.runtimeClassName !==
        (resource.metadata.name === 'redis'
          ? 'loremaster-redis'
          : 'loremaster') ||
      pod.automountServiceAccountToken !== false ||
      !pod.securityContext.runAsNonRoot ||
      pod.securityContext.seccompProfile?.type !== 'RuntimeDefault'
    )
      throw Error('Unsafe pod: ' + resource.metadata.name)
    for (const container of pod.containers) {
      if (
        !/@sha256:[a-f0-9]{64}$/u.test(container.image) ||
        container.securityContext?.allowPrivilegeEscalation !== false ||
        container.securityContext?.readOnlyRootFilesystem !== true ||
        !container.securityContext?.capabilities?.drop?.includes('ALL') ||
        !container.resources?.limits?.memory ||
        !container.resources?.limits?.cpu
      )
        throw Error('Unsafe container: ' + resource.metadata.name)
      for (const mount of container.volumeMounts ?? [])
        if (
          mount.mountPath.startsWith('/run/secrets/') &&
          (!mount.subPath || !mount.readOnly)
        )
          throw Error('Secret files must use read-only subPath')
    }
    for (const volume of pod.volumes ?? [])
      if (volume.secret && volume.secret.defaultMode !== 292)
        throw Error('Secret mode must be decimal 292 (0444)')
  }
  if (
    resources.some(
      (resource) =>
        resource.kind === 'Secret' ||
        resource.kind === 'Job' ||
        (resource.kind === 'Service' &&
          resource.spec.type &&
          resource.spec.type !== 'ClusterIP'),
    )
  )
    throw Error('Unexpected secret, automatic operator, or public service')
  const deny = resources.find(
    (resource) =>
      resource.kind === 'NetworkPolicy' &&
      resource.metadata.name === 'default-deny',
  )
  if (
    !deny ||
    !['Ingress', 'Egress'].every((type) =>
      deny.spec.policyTypes.includes(type),
    ) ||
    deny.spec.ingress?.length ||
    deny.spec.egress?.length
  )
    throw Error('Default deny required')
}
