import { readFile, readdir } from 'node:fs/promises'
import { extname, join, relative, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const repositoryRoot = resolve(import.meta.dirname, '..', '..')

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name)
      return entry.isDirectory()
        ? sourceFiles(path)
        : extname(entry.name) === '.ts'
          ? [path]
          : []
    }),
  )
  return files.flat()
}

describe('S5.7 static disclosure boundary', () => {
  it('keeps content importer, fixtures, and URL fetching out of the API', async () => {
    const root = resolve(repositoryRoot, 'apps', 'api', 'src')
    for (const file of await sourceFiles(root)) {
      const source = await readFile(file, 'utf8')
      expect(source, relative(repositoryRoot, file)).not.toMatch(
        /@loremaster\/database\/content|\/content\/fixtures|\bfetch\s*\(|\bhttps?\.get\s*\(/u,
      )
    }
  })

  it('does not expose the server-only content boundary through public package exports', async () => {
    for (const packageName of ['contracts', 'domain', 'observability']) {
      const source = await readFile(
        resolve(repositoryRoot, 'packages', packageName, 'src', 'index.ts'),
        'utf8',
      )
      expect(source).not.toMatch(/database|content\/fixtures|content\/cli/u)
    }
  })
})
