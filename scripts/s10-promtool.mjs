// Checks and unit-tests the S10 PrometheusRule with the pinned promtool.
// Requires Docker; a missing daemon fails the gate instead of skipping it.
import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { documents, root, run, save } from './s9-common.mjs'
import { monitoringVersions } from './s10-monitoring.mjs'

const reference = 'quay.io/prometheus/prometheus:v3.15.0-distroless'
const digest = monitoringVersions().images[reference]
if (!digest) throw Error('Prometheus image is not pinned in versions.json')

const monitoring = resolve(root, 'platform/monitoring')
const temporary = mkdtempSync(join(tmpdir(), 'loremaster-s10-rules-'))
try {
  const [rule] = documents(
    readFileSync(resolve(monitoring, 'rules.yaml'), 'utf8'),
  )
  if (rule?.kind !== 'PrometheusRule')
    throw Error('Expected one PrometheusRule')
  save(join(temporary, 'rules.json'), { groups: rule.spec.groups })
  copyFileSync(
    resolve(monitoring, 'rules.test.yaml'),
    join(temporary, 'rules.test.yaml'),
  )
  // mkdtemp creates the directory 0700; promtool runs as nobody in the
  // container, so the read-only mount must be world-readable on Linux.
  chmodSync(temporary, 0o755)
  for (const file of ['rules.json', 'rules.test.yaml'])
    chmodSync(join(temporary, file), 0o644)
  const promtool = (args) =>
    run(
      'docker',
      [
        'run',
        '--rm',
        '--network=none',
        '--read-only',
        '--tmpfs',
        '/tmp:size=64m',
        '-v',
        `${temporary}:/rules:ro`,
        '-w',
        '/rules',
        '--entrypoint',
        'promtool',
        `${reference}@${digest}`,
        ...args,
      ],
      { timeout: 180000 },
    )
  process.stdout.write(promtool(['check', 'rules', 'rules.json']) + '\n')
  process.stdout.write(promtool(['test', 'rules', 'rules.test.yaml']) + '\n')
  process.stdout.write('S10 rules: PASS\n')
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
