import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function secretFiles(values: Readonly<Record<string, string>>) {
  const directory = mkdtempSync(join(tmpdir(), 'loremaster-s8-secrets-'))
  const environment: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(values)) {
    const path = join(directory, key)
    writeFileSync(path, value, { mode: 0o400 })
    chmodSync(path, 0o400)
    environment[key] = undefined
    environment[`${key}_FILE`] = path
  }
  return {
    environment,
    directory,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  }
}
