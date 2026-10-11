import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import process from 'node:process'
import { evaluateVulnerabilities } from './s8-scan-image.mjs'

const scanner =
  'aquasec/trivy:0.74.0@sha256:62b1e65e8869bc4b4c6aa4fa2b21595256c7c2f6018a9d9ad61caf87187c1969'
const selected = process.argv.slice(2)
const images = selected.length
  ? selected
  : ['api', 'worker', 'observer', 'migration', 'importer', 'web']
if (
  images.some(
    (x) =>
      !['api', 'worker', 'observer', 'migration', 'importer', 'web'].includes(
        x,
      ),
  )
)
  throw Error('Unknown image')
const temporary = mkdtempSync(join(tmpdir(), 'loremaster-s8-scan-'))
const cache = 'loremaster-s8-scanner-' + randomUUID()
const evidence = join('.cache', 's8-evidence')
const pinnedNodeVersion = JSON.parse(readFileSync('package.json', 'utf8'))
  .engines.node
mkdirSync(evidence, { recursive: true })
const docker = (args, options = {}) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    timeout: 600000,
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  })
docker(['volume', 'create', cache])
try {
  let first = true
  const results = []
  for (const name of images) {
    const image = 'loremaster/' + name + ':s8'
    const inspection = JSON.parse(docker(['image', 'inspect', image]))[0]
    const runtimeVersion =
      name === 'web'
        ? null
        : docker([
            'run',
            '--rm',
            '--read-only',
            '--network=none',
            '--entrypoint',
            '/usr/local/bin/node',
            image,
            '--version',
          ]).trim()
    if (runtimeVersion !== null) {
      assert.equal(runtimeVersion, `v${pinnedNodeVersion}`)
    }
    const archive = join(temporary, name + '.tar')
    docker(['image', 'save', '--output', archive, inspection.Id])
    const base = [
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
      'type=bind,src=' + temporary + ',dst=/input,readonly',
      '--mount',
      'type=volume,src=' + cache + ',dst=/root/.cache/trivy',
      scanner,
      'image',
      '--input',
      '/input/' + name + '.tar',
      '--no-progress',
      '--skip-version-check',
    ]
    const raw = docker([
      ...base,
      ...(first ? [] : ['--skip-db-update']),
      '--scanners',
      'vuln,license',
      '--license-full',
      '--list-all-pkgs',
      '--format',
      'json',
    ])
    first = false
    const report = JSON.parse(raw)
    assert.equal(
      report.Metadata?.OS?.Family,
      'alpine',
      'OS packages must remain identifiable',
    )
    assert(
      report.Results.some(
        (x) => x.Class === 'os-pkgs' && x.Packages?.length > 0,
      ),
      'Missing library inventory',
    )
    const policy = evaluateVulnerabilities(
      report,
      JSON.parse(readFileSync('ops/s8/vulnerability-exceptions.json', 'utf8')),
    )
    writeFileSync(join(evidence, name + '-scan.json'), raw)
    const sbom = docker([
      ...base,
      '--skip-db-update',
      '--format',
      'cyclonedx',
      '--scanners',
      'vuln,license',
    ])
    writeFileSync(join(evidence, name + '-sbom.cdx.json'), sbom)
    const container = 'loremaster-s8-inventory-' + randomUUID()
    docker(['create', '--name', container, inspection.Id])
    try {
      const fsArchive = join(temporary, name + '-filesystem.tar')
      docker(['export', '--output', fsArchive, container])
      const inventory = execFileSync('tar', ['-tf', fsArchive], {
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
      })
        .split(/\r?\n/u)
        .filter(Boolean)
        .filter(
          (file) =>
            file !== '.dockerenv' &&
            !/^(?:dev|proc|sys)\//u.test(file) &&
            ![
              'dev/',
              'proc/',
              'sys/',
              'etc/hostname',
              'etc/hosts',
              'etc/mtab',
              'etc/resolv.conf',
            ].includes(file),
        )
      writeFileSync(
        join(evidence, name + '-files.txt'),
        inventory.join('\n') + '\n',
      )
      for (const file of inventory) {
        assert(
          !/(^|\/)(?:\.git|\.env(?:\.[^/]*)?|fixtures|tests?|__tests__|typescript|vitest|eslint|\.cache|\.pnpm-store)(\/|$)|\.(?:ts|tsx|cpp|cc|c|h|gyp|gypi|sh)$/u.test(
            file,
          ),
          'Forbidden runtime file: ' + file,
        )
        assert(
          !/^(?:bin|sbin)\/[^/]+|^usr\/(?:bin|sbin)\/(?!nginx$)[^/]+|^usr\/local\/bin\/(?!node$)[^/]+/u.test(
            file,
          ),
          'Unexpected runtime tool: ' + file,
        )
        if (['api', 'worker', 'observer'].includes(name))
          assert(
            !/(?:\/migrate\.js|\/(?:operator|migration|importer)\.mjs|\/content\/(?:cli|import)\.js|\.sql)$/u.test(
              file,
            ),
            'Operator file in service image',
          )
        if (name === 'web')
          assert(
            /^(?:srv\/web\/|etc\/|lib\/|usr\/lib\/|usr\/sbin\/nginx$|tmp\/$|(?:srv|srv\/web|usr|usr\/lib|usr\/sbin)\/$)/u.test(
              file,
            ),
            'Unexpected public image file: ' + file,
          )
      }
      if (name === 'web') {
        docker(['cp', container + ':/srv/web', join(temporary, 'web')])
        execFileSync(
          process.execPath,
          ['scripts/web-disclosure.mjs', join(temporary, 'web')],
          { stdio: 'inherit' },
        )
      }
    } finally {
      docker(['rm', container])
    }
    results.push({
      image,
      id: inspection.Id,
      runtimeVersion,
      findings: policy.findings,
      violations: policy.violations,
      scannedAt: new Date().toISOString(),
    })
    process.stdout.write(
      name +
        ': ' +
        policy.findings +
        ' HIGH/CRITICAL, ' +
        policy.violations.length +
        ' unapproved\n',
    )
  }
  writeFileSync(
    join(evidence, 'summary.json'),
    JSON.stringify(results, null, 2) + '\n',
  )
  assert(
    results.every((x) => x.violations.length === 0),
    'Unapproved vulnerability findings; see .cache/s8-evidence',
  )
} finally {
  docker(['volume', 'rm', cache])
  rmSync(temporary, { recursive: true, force: true })
}
