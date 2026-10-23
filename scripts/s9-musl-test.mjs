import assert from 'node:assert/strict'
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { assertRuntimePackages, scanner } from './s8-scan-image.mjs'
import { documents, json, root, run, save, state } from './s9-common.mjs'

const cve = 'CVE-2026-107891'
const contracts = json(resolve(root, 'deploy/images/contracts.json'))
const result = {
  passed: false,
  sourceRevision: run('git', ['rev-parse', 'HEAD']),
  checkedAt: new Date().toISOString(),
  cve,
  images: [],
}
mkdirSync(state, { recursive: true })
const temporary = mkdtempSync(resolve(state, 'musl-scan-'))
// The capability-free scanner has a different UID on Linux runners. These
// archives contain only public images; make just this owned input traversable.
chmodSync(temporary, 0o755)
const cache = 'loremaster-musl-' + randomUUID()
let cacheCreated = false
const docker = (args) =>
  run('docker', args, { timeout: 600000, maxBuffer: 64 * 1024 * 1024 })
function verify(report, name, expected, image) {
  const packages = assertRuntimePackages(report, { musl: expected })
  assert(
    !report.Results.some((target) =>
      (target.Vulnerabilities ?? []).some(
        (finding) => finding.VulnerabilityID === cve,
      ),
    ),
    `${cve} remains in ${name}`,
  )
  result.images.push({ name, image, musl: packages.musl, advisoryAbsent: true })
}
try {
  const summary = json(resolve(root, '.cache/s8-evidence/summary.json'))
  assert.equal(summary.length, 6)
  for (const name of [
    'api',
    'worker',
    'observer',
    'migration',
    'importer',
    'web',
  ]) {
    const admitted = summary.find(
      (item) => item.image === `loremaster/${name}:s8`,
    )
    assert(
      admitted &&
        admitted.runtimePackages?.musl === contracts.runtimePackages.musl,
    )
    verify(
      json(resolve(root, `.cache/s8-evidence/${name}-scan.json`)),
      name,
      contracts.runtimePackages.musl,
      admitted.id,
    )
  }
  const [values] = documents(
    readFileSync(resolve(root, 'deploy/helm/loremaster/values.yaml'), 'utf8'),
  )
  const [compose] = documents(
    readFileSync(resolve(root, 'deploy/compose/compose.yaml'), 'utf8'),
  )
  docker(['volume', 'create', cache])
  cacheCreated = true
  let first = true
  for (const [name, contract] of Object.entries(contracts.dataServices)) {
    assert.equal(values[name + 'Image'], contract.image)
    assert.equal(compose.services[name].image, contract.image)
    docker(['pull', contract.image])
    const archive = resolve(temporary, name + '.tar')
    docker(['image', 'save', '-o', archive, contract.image])
    chmodSync(archive, 0o644)
    const raw = docker([
      'run',
      '--rm',
      '--read-only',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges:true',
      '--memory=2g',
      '--pids-limit=128',
      '--tmpfs',
      '/tmp:rw,noexec,nosuid,size=1g',
      '--mount',
      `type=bind,src=${temporary},dst=/input,readonly`,
      '--mount',
      `type=volume,src=${cache},dst=/root/.cache/trivy`,
      scanner,
      'image',
      '--input',
      `/input/${name}.tar`,
      '--no-progress',
      '--skip-version-check',
      ...(first ? [] : ['--skip-db-update']),
      '--scanners',
      'vuln',
      '--list-all-pkgs',
      '--format',
      'json',
    ])
    first = false
    writeFileSync(
      resolve(root, `.cache/s8-evidence/${name}-musl-scan.json`),
      raw,
    )
    verify(JSON.parse(raw), name, contract.musl, contract.image)
  }
  assert.equal(result.images.length, 8)
  result.passed = true
} finally {
  try {
    if (cacheCreated) docker(['volume', 'rm', cache])
  } finally {
    assert.equal(
      dirname(temporary),
      state,
      'Temporary scan path escaped S9 state',
    )
    rmSync(temporary, { recursive: true, force: true })
    save(resolve(state, 'musl.json'), result)
  }
}
process.stdout.write('S9 musl remediation: PASS (8 images; advisory absent)\n')
