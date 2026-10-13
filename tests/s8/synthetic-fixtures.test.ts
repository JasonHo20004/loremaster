import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

import { writeSyntheticFixture } from '../../scripts/s8-test-stack.mjs'

const posix = process.platform !== 'win32'

function withDirectory(run: (directory: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), 'loremaster-s8-fixture-'))
  try {
    run(directory)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

describe('S8 synthetic bind-mounted fixtures', () => {
  it('preserves fixture bytes and supports repeated host clock updates', () => {
    withDirectory((directory) => {
      const path = join(directory, 'clock')
      writeSyntheticFixture(path, '@2026-10-13 23:59:50\n')
      expect(readFileSync(path, 'utf8')).toBe('@2026-10-13 23:59:50\n')
      writeFileSync(path, '@2026-10-14 00:00:05\n')
      expect(readFileSync(path, 'utf8')).toBe('@2026-10-14 00:00:05\n')
      writeSyntheticFixture(path, 'Unicode: Việt Nam 🔎\n')
      expect(readFileSync(path, 'utf8')).toBe('Unicode: Việt Nam 🔎\n')
      writeSyntheticFixture(path, '')
      expect(readFileSync(path, 'utf8')).toBe('')
    })
  })

  it.skipIf(!posix)(
    'repairs an existing 0600 fixture for container reads and host rewrites',
    () => {
      withDirectory((directory) => {
        const path = join(directory, 'pack.json')
        writeFileSync(path, 'old fixture')
        chmodSync(path, 0o600)
        writeSyntheticFixture(path, '{"slot":"new"}')
        expect(readFileSync(path, 'utf8')).toBe('{"slot":"new"}')
        expect(statSync(path).mode & 0o777).toBe(0o644)
        writeFileSync(path, '{"slot":"rewritten"}')
        expect(readFileSync(path, 'utf8')).toBe('{"slot":"rewritten"}')
        expect(statSync(path).mode & 0o777).toBe(0o644)
      })
    },
  )

  it.skipIf(!posix)(
    'makes new fixtures readable despite a restrictive host umask',
    () => {
      withDirectory((directory) => {
        const path = join(directory, 'clock')
        const module = pathToFileURL(
          join(process.cwd(), 'scripts/s8-test-stack.mjs'),
        ).href
        const result = spawnSync(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            `
        import { writeSyntheticFixture } from ${JSON.stringify(module)};
        process.umask(0o077);
        writeSyntheticFixture(process.argv[1], 'synthetic clock');
      `,
            path,
          ],
          { encoding: 'utf8' },
        )
        expect(result.error).toBeUndefined()
        expect(result.status, result.stderr).toBe(0)
        expect(readFileSync(path, 'utf8')).toBe('synthetic clock')
        expect(statSync(path).mode & 0o777).toBe(0o644)
      })
    },
  )

  it('propagates filesystem failures', () => {
    withDirectory((directory) => {
      expect(() =>
        writeSyntheticFixture(join(directory, 'missing', 'clock'), 'clock'),
      ).toThrow()
      expect(() => writeSyntheticFixture(directory, 'clock')).toThrow()
    })
  })
})
