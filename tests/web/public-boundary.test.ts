import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const WEB_ROOT = path.resolve('apps/web')
const FORBIDDEN_IMPORTS =
  /(?:from\s+|import\s*\()['"](?:@loremaster\/(?!contracts(?:['"/]))|.*(?:apps[\\/](?:api|worker|queue-observer)|packages[\\/](?:config|database|domain|observability|queue)))/u
const PRIVATE_CONTENT = [
  'aster quay',
  'the missing ninth bell',
  'dailyruneterracase_description',
] as const

async function publicSourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(
    entries
      .filter(
        (entry) =>
          !['dist', 'node_modules', 'test-results'].includes(entry.name),
      )
      .map((entry) => {
        const entryPath = path.join(directory, entry.name)
        return entry.isDirectory() ? publicSourceFiles(entryPath) : [entryPath]
      }),
  )
  return nested
    .flat()
    .filter((file) => /\.(?:css|html|json|ts|tsx)$/u.test(file))
}

describe('S6 public browser boundary', () => {
  it('declares no server workspace dependencies', async () => {
    const manifest = JSON.parse(
      await readFile(path.join(WEB_ROOT, 'package.json'), 'utf8'),
    ) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    const workspacePackages = [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
    ].filter((dependency) => dependency.startsWith('@loremaster/'))

    expect(
      workspacePackages.every(
        (dependency) => dependency === '@loremaster/contracts',
      ),
    ).toBe(true)
  })

  it('keeps server modules and private content out of web source', async () => {
    const files = await publicSourceFiles(WEB_ROOT)
    const source = (
      await Promise.all(files.map((file) => readFile(file, 'utf8')))
    ).join('\n')

    expect(source).not.toMatch(FORBIDDEN_IMPORTS)
    for (const marker of PRIVATE_CONTENT) {
      expect(source.toLowerCase()).not.toContain(marker)
    }
  })

  it('exposes only the named public API base variable', async () => {
    const files = await publicSourceFiles(WEB_ROOT)
    const source = (
      await Promise.all(files.map((file) => readFile(file, 'utf8')))
    ).join('\n')
    const publicVariables = [...source.matchAll(/VITE_[A-Z0-9_]+/gu)].map(
      ([variable]) => variable,
    )

    expect([...new Set(publicVariables)]).toEqual(['VITE_API_BASE_URL'])
  })
})
