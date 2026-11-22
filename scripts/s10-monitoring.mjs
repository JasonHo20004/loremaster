import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import {
  documents,
  json,
  kubeconfig,
  kubectl,
  root,
  run,
  save,
  tool,
} from './s9-common.mjs'
import { download } from './s9-tools.mjs'

export const namespace = 'monitoring'
export const monitoringRoot = resolve(root, 'platform/monitoring')
const state = resolve(root, '.cache/s10')
const adminSecretFile = resolve(state, 'grafana-admin.json')
const digestPattern = /@sha256:[0-9a-f]{64}$/u
const clusterScoped = new Set([
  'ClusterRole',
  'ClusterRoleBinding',
  'CustomResourceDefinition',
  'MutatingWebhookConfiguration',
  'Namespace',
  'ValidatingWebhookConfiguration',
])

export function monitoringVersions() {
  return json(resolve(monitoringRoot, 'versions.json'))
}

/**
 * Rewrites every pinned `repository:tag` to `repository:tag@sha256:...` and
 * rejects any image reference that remains without a digest.
 */
export function pinImages(rendered, images) {
  let pinned = rendered
  for (const [reference, digest] of Object.entries(images)) {
    if (!/^sha256:[0-9a-f]{64}$/u.test(digest))
      throw Error('Invalid monitoring image digest: ' + reference)
    const escaped = reference.replace(/[.*+?^${}()|[\]\\/]/gu, '\\$&')
    pinned = pinned.replace(
      new RegExp(`${escaped}(?![@\\w.-])`, 'gu'),
      `${reference}@${digest}`,
    )
  }
  const unpinned = imageReferences(pinned).filter(
    (reference) => !digestPattern.test(reference),
  )
  if (unpinned.length > 0)
    throw Error(
      'Unpinned monitoring images: ' + [...new Set(unpinned)].join(', '),
    )
  return pinned
}

export function imageReferences(rendered) {
  const references = []
  for (const match of rendered.matchAll(
    // Same-line whitespace only: CRD schemas contain bare `image:` keys.
    /(?:^[ \t]*-?[ \t]*image:[ \t]*|--prometheus-config-reloader=|--thanos-default-base-image=)["']?([^"'\s]+)/gmu,
  ))
    references.push(match[1])
  return references
}

export function dashboardConfigMaps() {
  const directory = resolve(monitoringRoot, 'dashboards')
  return readdirSync(directory)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => {
      const body = readFileSync(resolve(directory, file), 'utf8')
      JSON.parse(body)
      return {
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: {
          name: 'dashboard-' + basename(file, '.json'),
          namespace,
          labels: { grafana_dashboard: '1' },
        },
        data: { [file]: body },
      }
    })
}

/** Returns a verified chart archive; a cached copy is re-hashed on every use. */
async function chartArchive(chart) {
  const archive = resolve(state, `${chart.name}-${chart.version}.tgz`)
  const cached =
    existsSync(archive) &&
    createHash('sha256').update(readFileSync(archive)).digest('hex') ===
      chart.sha256
  if (!cached) await download(chart.url, chart.sha256, archive)
  return archive
}

async function renderStack() {
  const { charts, images } = monitoringVersions()
  const objects = []
  for (const chart of charts) {
    const rendered = run(tool('helm'), [
      'template',
      chart.release,
      await chartArchive(chart),
      '--namespace',
      namespace,
      '--include-crds',
      '-f',
      resolve(monitoringRoot, chart.values),
    ])
    objects.push(...documents(pinImages(rendered, images)))
  }
  return objects
}

/** Defaults namespaced objects to `monitoring`; the chart also targets kube-system. */
export function withNamespace(object) {
  if (clusterScoped.has(object.kind) || object.metadata.namespace) return object
  return { ...object, metadata: { ...object.metadata, namespace } }
}

function serverSideApply(objects) {
  kubectl(['apply', '--server-side', '--force-conflicts', '-f', '-'], {
    input: JSON.stringify({
      apiVersion: 'v1',
      kind: 'List',
      items: objects.map(withNamespace),
    }),
    timeout: 240000,
  })
}

function ensureAdminSecret() {
  if (!existsSync(adminSecretFile))
    save(adminSecretFile, {
      user: 'admin',
      password: randomBytes(24).toString('base64url'),
    })
  const { user, password } = json(adminSecretFile)
  kubectl(['apply', '-n', namespace, '-f', '-'], {
    input: JSON.stringify({
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: 'grafana-admin', namespace },
      type: 'Opaque',
      stringData: { 'admin-user': user, 'admin-password': password },
    }),
    sensitive: true,
  })
}

async function install() {
  if (!existsSync(kubeconfig))
    throw Error('Run `pnpm s9 cluster` before installing monitoring')
  const objects = await renderStack()
  const crds = objects.filter(
    (object) => object.kind === 'CustomResourceDefinition',
  )
  serverSideApply(crds)
  kubectl(
    [
      'wait',
      '--for=condition=Established',
      '--timeout=120s',
      ...crds.map((crd) => 'crd/' + crd.metadata.name),
    ],
    { timeout: 130000 },
  )
  // node-exporter needs host namespaces; the lab namespace is privileged.
  serverSideApply([
    {
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: {
        name: namespace,
        labels: {
          'pod-security.kubernetes.io/enforce': 'privileged',
          'app.kubernetes.io/part-of': 'loremaster-s10',
        },
      },
    },
  ])
  ensureAdminSecret()
  serverSideApply(
    objects.filter((object) => object.kind !== 'CustomResourceDefinition'),
  )
  serverSideApply([
    ...documents(readFileSync(resolve(monitoringRoot, 'scrape.yaml'), 'utf8')),
    ...documents(readFileSync(resolve(monitoringRoot, 'rules.yaml'), 'utf8')),
    ...dashboardConfigMaps(),
  ])
  for (const workload of [
    'deployment/monitoring-operator',
    'deployment/monitoring-grafana',
    'deployment/monitoring-kube-state-metrics',
    'statefulset/loki',
    'deployment/alloy',
  ])
    kubectl(
      ['rollout', 'status', '-n', namespace, workload, '--timeout=240s'],
      { timeout: 250000 },
    )
  kubectl(
    [
      'wait',
      '-n',
      namespace,
      '--for=condition=Available',
      '--timeout=240s',
      'prometheus/monitoring-prometheus',
    ],
    { timeout: 250000 },
  )
}

function forward() {
  const target = process.argv[3] ?? 'grafana'
  const targets = {
    grafana: ['service/monitoring-grafana', '3300:80'],
    prometheus: ['service/monitoring-prometheus', '9090:9090'],
    alertmanager: ['service/monitoring-alertmanager', '9093:9093'],
  }
  const selected = targets[target]
  if (!selected) throw Error('Usage: forward <grafana|prometheus|alertmanager>')
  kubectl(
    ['port-forward', '-n', namespace, ...selected, '--address=127.0.0.1'],
    { stdio: 'inherit', timeout: undefined },
  )
}

async function uninstall() {
  const objects = (await renderStack()).filter(
    (object) => object.kind !== 'CustomResourceDefinition',
  )
  kubectl(['delete', 'namespace', namespace, '--ignore-not-found', '--wait'], {
    timeout: 240000,
  })
  for (const object of objects.filter((item) => clusterScoped.has(item.kind)))
    kubectl([
      'delete',
      object.kind.toLowerCase(),
      object.metadata.name,
      '--ignore-not-found',
    ])
}

async function main(command) {
  switch (command) {
    case 'render':
      save(resolve(state, 'rendered.json'), await renderStack())
      break
    case 'install':
      await install()
      break
    case 'status':
      process.stdout.write(
        kubectl(['get', 'pods,prometheus,alertmanager', '-n', namespace]) +
          '\n',
      )
      break
    case 'forward':
      forward()
      break
    case 'uninstall':
      await uninstall()
      break
    default:
      throw Error(
        'Usage: node scripts/s10-monitoring.mjs <render|install|status|forward [grafana|prometheus|alertmanager]|uninstall>',
      )
  }
  process.stdout.write(`S10 ${command}: PASS\n`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    await main(process.argv[2])
  } catch (error) {
    process.stderr.write(
      (error instanceof Error ? error.message : String(error)) + '\n',
    )
    process.exitCode = 1
  }
}
