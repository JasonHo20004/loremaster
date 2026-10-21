import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  assertFreshSecretVolume,
  validateContentFile,
} from '../../scripts/s8-compose-inputs.mjs'

describe('S8 operator input safety', () => {
  it('does not replace credentials when a retained database exists', () => {
    expect(() =>
      assertFreshSecretVolume(
        'loremaster-s8',
        () => 'other_postgres_data\nloremaster-s8_postgres_data\n',
      ),
    ).toThrow('restore the original secrets')
  })

  it('fails closed if Docker cannot prove the database volume is absent', () => {
    expect(() =>
      assertFreshSecretVolume('loremaster-s8', () => {
        throw Error('Docker daemon unavailable')
      }),
    ).toThrow('Docker daemon unavailable')
  })

  it('allows new credentials only after a successful absence check', () => {
    expect(() =>
      assertFreshSecretVolume(
        'loremaster-s8',
        () => 'other_postgres_data\nloremaster-s8_postgres_data-backup\n',
      ),
    ).not.toThrow()
  })

  it('rejects oversized, empty, directory and relative inputs before Compose runs', () => {
    const temporary = mkdtempSync(join(tmpdir(), 'loremaster-s8-inputs-'))
    try {
      const pack = join(temporary, 'pack.json')
      writeFileSync(pack, Buffer.alloc(262145))
      expect(() => validateContentFile(pack)).toThrow('1 to 262144 bytes')
      writeFileSync(pack, '')
      expect(() => validateContentFile(pack)).toThrow('1 to 262144 bytes')
      expect(() => validateContentFile(temporary)).toThrow('regular file')
      expect(() => validateContentFile('pack.json')).toThrow('absolute path')
      writeFileSync(pack, Buffer.alloc(262144, 0x20))
      expect(() => validateContentFile(pack)).not.toThrow()
    } finally {
      rmSync(temporary, { recursive: true, force: true })
    }
  })
})
