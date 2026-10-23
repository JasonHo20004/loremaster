import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import {
  assertRuntimePolicy,
  chart,
  documents,
  render,
  root,
  run,
  save,
  state,
  tool,
} from './s9-common.mjs'

const temporary = mkdtempSync(join(tmpdir(), 'loremaster-s9-policy-'))
try {
  const values = join(temporary, 'images.json')
  save(values, {
    images: Object.fromEntries(
      ['api', 'worker', 'observer', 'web', 'migration', 'importer'].map(
        (name) => [
          name,
          `localhost:5001/loremaster/${name}@sha256:${'a'.repeat(64)}`,
        ],
      ),
    ),
  })
  run(tool('helm'), ['lint', chart, '-f', values, '--strict'])
  const resources = documents(render([], values))
  assertRuntimePolicy(resources)
  const api = resources.find(
    (resource) =>
      resource.kind === 'Deployment' && resource.metadata.name === 'api',
  )
  const web = resources.find(
    (resource) =>
      resource.kind === 'Deployment' && resource.metadata.name === 'web',
  )
  const trust = api.spec.template.spec.containers[0].env.find(
    (field) => field.name === 'LOREMASTER_API_TRUSTED_PROXIES',
  ).value
  if (
    trust !==
    `${JSON.parse(web.spec.template.metadata.annotations['cni.projectcalico.org/ipAddrs'])[0]}/32`
  )
    throw Error('Gateway/trusted proxy mismatch')
  for (const name of ['migration', 'importer']) {
    const jobs = documents(
      render(
        [
          '--set',
          `operator=${name}`,
          '--show-only',
          'templates/operators.yaml',
        ],
        values,
      ),
    )
    if (
      jobs.length !== 1 ||
      jobs[0].kind !== 'Job' ||
      jobs[0].spec.backoffLimit !== 0 ||
      jobs[0].spec.activeDeadlineSeconds !== 120
    )
      throw Error('Unbounded operator')
  }
  for (const source of [
    'platform/local/kind.yaml',
    'platform/local/namespace.yaml',
    'platform/local/runtime.yaml',
    'platform/argocd/project.yaml',
    'platform/argocd/application.yaml',
  ])
    documents(readFileSync(resolve(root, source), 'utf8'))
  save(resolve(state, 'static-policy.json'), {
    passed: true,
    evidenceType: 'synthetic image values; no running cluster',
    checkedAt: new Date().toISOString(),
    resourceCount: resources.length,
  })
  process.stdout.write(
    `S9 Helm/static policy: PASS (${resources.length} resources; synthetic image digests)\n`,
  )
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
