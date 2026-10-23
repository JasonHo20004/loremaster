import { resolve } from 'node:path'
import process from 'node:process'
import {
  json,
  kubectl,
  root,
  run,
  save,
  state,
  versions,
} from './s9-common.mjs'

const runtime = json(resolve(state, 'runtime.json'))
const drain = json(resolve(state, 'drain.json'))
const promotion = json(resolve(state, 'promotion.json'))
const revision = run('git', ['rev-parse', 'HEAD'])
const source = json(resolve(state, 'gitops-source.json'))
const app = JSON.parse(
  kubectl([
    'get',
    '-n',
    'argocd',
    'application/loremaster-local',
    '-o',
    'json',
  ]),
)
const nodes = JSON.parse(kubectl(['get', 'nodes', '-o', 'json'])).items
const scans = json(resolve(root, '.cache/s8-evidence/summary.json'))
if (
  !runtime.passed ||
  !drain.passed ||
  drain.teardown !== 'PASS' ||
  runtime.sourceRevision !== revision ||
  drain.sourceRevision !== revision ||
  promotion.images.some((image) => image.revision !== revision) ||
  !runtime.checks.some(
    (check) =>
      check.name === 'effective Redis PID ceiling' &&
      check.passed &&
      check.kernelPidsMax === 64,
  ) ||
  !promotion.passed ||
  app.status?.sync?.status !== 'Synced' ||
  app.status?.health?.status !== 'Healthy' ||
  app.status.sync.revision !== source.desiredRevision ||
  nodes.length !== 4 ||
  !nodes.every((node) =>
    node.status.conditions.some(
      (condition) => condition.type === 'Ready' && condition.status === 'True',
    ),
  )
)
  throw Error('Current local runtime is not accepted')
// Explicit whitelist: never copy kubeconfig, secret JSON, content, or the Git repository.
const evidence = {
  schemaVersion: 2,
  recordedAt: new Date().toISOString(),
  scope:
    'S9 local Kubernetes/GitOps with kernel PID limits and active-work termination; node-loss backup and cloud are outside scope',
  sourceRevision: revision,
  execution:
    process.env.GITHUB_ACTIONS === 'true'
      ? {
          provider: 'GitHub Actions',
          runUrl: `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`,
          runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
          checkoutRevision: process.env.GITHUB_SHA,
        }
      : { provider: 'local' },
  worktreeHasChanges: run('git', ['status', '--porcelain']).length > 0,
  versions,
  nodes: nodes.map((node) => ({
    name: node.metadata.name,
    version: node.status.nodeInfo.kubeletVersion,
    ready: true,
  })),
  desiredRevision: source.desiredRevision,
  argo: {
    sync: app.status.sync.status,
    health: app.status.health.status,
    repoURL: app.spec.source.repoURL,
  },
  images: promotion.images,
  scans: scans.map((scan) => ({
    image: scan.image,
    id: scan.id,
    configSha256: scan.configSha256,
    sbomSha256: scan.sbomSha256,
    highCritical: scan.findings,
    unapproved: scan.violations.length,
    secrets: scan.secretFindings,
    scannedAt: scan.scannedAt,
  })),
  staticPolicy: json(resolve(state, 'static-policy.json')),
  runtime,
  drain,
  teardown: {
    executed: false,
    reason:
      'The final local lab is retained for use; a prior disposable lab teardown is recorded separately when available',
  },
}
const teardown = resolve(state, 'teardown.json')
try {
  evidence.previousDisposableTeardown = json(teardown)
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}
save(resolve(state, 'acceptance-evidence.json'), evidence)
if (process.argv[2] === '--write-durable') {
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
  save(resolve(root, `docs/architecture/s9-evidence-${date}.json`), evidence)
}
process.stdout.write('S9 non-secret evidence: PASS\n')
