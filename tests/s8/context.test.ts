import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  buildContext,
  profiles,
  readAllowlist,
} from '../../scripts/s8-context.mjs'

describe('S8 explicit build contexts', () => {
  it.each(profiles)(
    '%s contains only reviewed files with stable hashes',
    (profile) => {
      const parent = mkdtempSync(join(tmpdir(), 'loremaster-s8-context-'))
      try {
        const destination = join(parent, 'context')
        const manifest = buildContext(profile, destination)
        expect(manifest.files.map((file) => file.path)).toEqual(
          readAllowlist(profile),
        )
        for (const file of manifest.files) {
          expect(file.path).not.toMatch(
            /(?:^|\/)(?:tests?|fixtures|node_modules)(?:\/|$)|\.map$|\.test\./u,
          )
          const bytes = readFileSync(join(destination, ...file.path.split('/')))
          expect(bytes.byteLength).toBe(file.bytes)
          expect(createHash('sha256').update(bytes).digest('hex')).toBe(
            file.sha256,
          )
        }
        expect(
          JSON.parse(
            readFileSync(join(destination, 's8-context-manifest.json'), 'utf8'),
          ),
        ).toEqual(manifest)
      } finally {
        rmSync(parent, { recursive: true, force: true })
      }
    },
  )

  it('rejects unknown profiles and repository destinations', () => {
    expect(() => readAllowlist('everything')).toThrow(
      'Unknown S8 context profile',
    )
    expect(() => buildContext('api', process.cwd())).toThrow(
      'outside the repository',
    )
  })
})
