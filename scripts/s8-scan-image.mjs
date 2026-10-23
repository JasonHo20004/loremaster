import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath, URL } from 'node:url'

export const scanner =
  'aquasec/trivy:0.74.0@sha256:62b1e65e8869bc4b4c6aa4fa2b21595256c7c2f6018a9d9ad61caf87187c1969'
const exceptionFile = fileURLToPath(
  new URL('../ops/s8/vulnerability-exceptions.json', import.meta.url),
)

function calendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value))
    return Number.NaN
  const timestamp = Date.parse(`${value}T00:00:00Z`)
  return Number.isFinite(timestamp) &&
    new Date(timestamp).toISOString().slice(0, 10) === value
    ? timestamp
    : Number.NaN
}

export function evaluateVulnerabilities(
  report,
  exceptions,
  today = new Date(),
) {
  if (!Array.isArray(report?.Results) || !Array.isArray(exceptions)) {
    throw new Error('Invalid S8 vulnerability report or exception ledger')
  }
  const findings = report.Results.flatMap(
    (result) => result.Vulnerabilities ?? [],
  ).filter((finding) => !['LOW', 'MEDIUM'].includes(finding.Severity))
  const violations = []
  for (const finding of findings) {
    const exception = exceptions.find(
      (entry) =>
        entry.package === finding.PkgName &&
        entry.cve === finding.VulnerabilityID,
    )
    if (exception === undefined) {
      violations.push(`${finding.VulnerabilityID} in ${finding.PkgName}`)
      continue
    }
    const approved = calendarDate(exception.approvedOn)
    const expires = calendarDate(exception.expiresOn)
    if (
      !exception.owner ||
      !exception.reviewer ||
      exception.owner === exception.reviewer ||
      !exception.compensatingControl ||
      !Number.isFinite(approved) ||
      !Number.isFinite(expires) ||
      !Number.isFinite(today.getTime()) ||
      today.getTime() < approved ||
      expires <= approved ||
      expires - approved > 30 * 86_400_000 ||
      today.getTime() >= expires
    ) {
      violations.push(
        `Invalid or expired exception for ${finding.VulnerabilityID} in ${finding.PkgName}`,
      )
    }
  }
  return { findings: findings.length, violations }
}

export function assertRuntimePackages(report, expected) {
  const packages = report.Results.filter(
    (result) => result.Class === 'os-pkgs',
  ).flatMap((result) => result.Packages ?? [])
  const versions = {}
  for (const [name, version] of Object.entries(expected)) {
    const found = packages.filter((pkg) => pkg.Name === name)
    if (found.length !== 1 || found[0].Version !== version)
      throw Error(`Runtime package mismatch: ${name} must be ${version}`)
    versions[name] = version
  }
  return versions
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const image = process.argv[2]
  if (!image || !/@sha256:[a-f0-9]{64}$/u.test(image)) {
    throw new Error(
      'Usage: node scripts/s8-scan-image.mjs <digest-pinned-image>',
    )
  }
  const raw = execFileSync(
    'docker',
    [
      'run',
      '--rm',
      scanner,
      'image',
      '--scanners',
      'vuln',
      '--severity',
      'HIGH,CRITICAL,UNKNOWN',
      '--exit-code',
      '0',
      '--no-progress',
      '--format',
      'json',
      image,
    ],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  )
  const result = evaluateVulnerabilities(
    JSON.parse(raw),
    JSON.parse(readFileSync(exceptionFile, 'utf8')),
  )
  process.stdout.write(
    `S8 scan: ${result.findings} HIGH/CRITICAL/UNKNOWN findings, ${result.violations.length} unapproved\n`,
  )
  if (result.violations.length > 0) {
    process.stderr.write(`${result.violations.join('\n')}\n`)
    process.exitCode = 1
  }
}
