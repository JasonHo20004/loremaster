import { describe, expect, it } from 'vitest'

import { evaluateVulnerabilities } from '../../scripts/s8-scan-image.mjs'

const finding = {
  PkgName: 'libexample',
  Severity: 'HIGH',
  VulnerabilityID: 'CVE-2026-1234',
}
const report = { Results: [{ Target: 'example', Vulnerabilities: [finding] }] }

describe('S8 vulnerability admission', () => {
  it('denies unapproved HIGH and CRITICAL findings', () => {
    expect(evaluateVulnerabilities(report, [], new Date('2026-10-02'))).toEqual(
      {
        findings: 1,
        violations: ['CVE-2026-1234 in libexample'],
      },
    )
  })

  it('requires a separate reviewer, control, and expiry within 30 days', () => {
    const exception = {
      package: 'libexample',
      cve: 'CVE-2026-1234',
      owner: 'release-owner',
      reviewer: 'security-reviewer',
      compensatingControl: 'Feature is unreachable',
      approvedOn: '2026-10-01',
      expiresOn: '2026-10-20',
    }
    expect(
      evaluateVulnerabilities(report, [exception], new Date('2026-10-02')),
    ).toEqual({ findings: 1, violations: [] })
    expect(
      evaluateVulnerabilities(
        report,
        [{ ...exception, reviewer: 'release-owner' }],
        new Date('2026-10-02'),
      ).violations,
    ).toHaveLength(1)
    expect(
      evaluateVulnerabilities(
        report,
        [{ ...exception, expiresOn: '2026-11-15' }],
        new Date('2026-10-02'),
      ).violations,
    ).toHaveLength(1)
    expect(
      evaluateVulnerabilities(report, [exception], new Date('2026-10-20'))
        .violations,
    ).toHaveLength(1)
  })

  it('does not admit an exception before its approval date', () => {
    const exception = {
      package: 'libexample',
      cve: 'CVE-2026-1234',
      owner: 'release-owner',
      reviewer: 'security-reviewer',
      compensatingControl: 'Feature is unreachable',
      approvedOn: '2026-10-25',
      expiresOn: '2026-11-01',
    }
    expect(
      evaluateVulnerabilities(report, [exception], new Date('2026-10-21'))
        .violations,
    ).toHaveLength(1)
    expect(
      evaluateVulnerabilities(report, [exception], new Date('2026-10-25'))
        .violations,
    ).toEqual([])
  })

  it.each([
    ['2026-02-29', '2026-03-10'],
    ['2026-02-28', '2026-02-30'],
    ['2026-2-28', '2026-03-10'],
    ['2026-02-28', '2026-3-10'],
  ])('rejects invalid calendar dates %s to %s', (approvedOn, expiresOn) => {
    expect(
      evaluateVulnerabilities(
        report,
        [
          {
            package: 'libexample',
            cve: 'CVE-2026-1234',
            owner: 'release-owner',
            reviewer: 'security-reviewer',
            compensatingControl: 'Feature is unreachable',
            approvedOn,
            expiresOn,
          },
        ],
        new Date('2026-03-01'),
      ).violations,
    ).toHaveLength(1)
  })
})
