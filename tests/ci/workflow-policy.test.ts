import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const workflowPath = fileURLToPath(
  new URL('../../.github/workflows/ci.yml', import.meta.url),
)
const workflow = await readFile(workflowPath, 'utf8')

describe('untrusted CI policy', () => {
  it('uses the unprivileged pull request trigger', () => {
    expect(workflow).toMatch(/^ {2}pull_request:$/m)
    expect(workflow).not.toContain('pull_request_target')
  })

  it('grants only the read access required by the jobs', () => {
    expect(workflow).toMatch(
      /^permissions:\r?\n {2}contents: read\r?\n {2}pull-requests: read$/m,
    )
    expect(workflow).not.toMatch(/^\s+[\w-]+: write$/m)
    expect(workflow).not.toContain('id-token:')
    expect(workflow).not.toContain('secrets.')
  })

  it('pins every external action to an immutable commit', () => {
    const actionReferences = [...workflow.matchAll(/^\s+uses: (\S+)/gm)].map(
      ([, reference]) => reference,
    )

    expect(actionReferences.length).toBeGreaterThan(0)
    expect(actionReferences).toEqual(
      actionReferences.filter((reference) => /@[0-9a-f]{40}$/.test(reference)),
    )
  })

  it('runs the frozen install and complete verification surface', () => {
    expect(workflow).toContain('run: pnpm install --frozen-lockfile')
    expect(workflow).toContain('run: pnpm verify')
  })

  it('audits locked dependencies at moderate severity', () => {
    expect(workflow).toContain('run: pnpm audit --audit-level moderate')
  })
})
