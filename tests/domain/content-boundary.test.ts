import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = (await readdir(directory, { withFileTypes: true })).filter(
    (entry) => !['dist', 'node_modules'].includes(entry.name),
  )
  const nested = await Promise.all(
    entries.map((entry) => {
      const entryPath = path.join(directory, entry.name)
      return entry.isDirectory() ? sourceFiles(entryPath) : [entryPath]
    }),
  )
  return nested
    .flat()
    .filter((file) => file.endsWith('.ts') || file.endsWith('.json'))
}

describe('domain content boundary', () => {
  it('contains neither the approved narrative fixture nor database imports', async () => {
    const files = await sourceFiles(path.resolve('packages/domain'))
    const source = (
      await Promise.all(files.map((file) => readFile(file, 'utf8')))
    ).join('\n')

    expect(source.toLowerCase()).not.toContain('aster quay')
    expect(source.toLowerCase()).not.toContain('the missing ninth bell')
    expect(source).not.toContain('@loremaster/database')
    expect(source).not.toMatch(/from\s+['"][^'"]*database[^'"]*['"]/u)
  })
})
