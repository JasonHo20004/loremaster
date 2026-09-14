import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const SERVER_CONTENT_IMPORT =
  /@loremaster\/database(?:\/content)?|packages\/database|packages\\database/u
const PRIVATE_CONTENT_MARKERS = [
  'aster quay',
  'the missing ninth bell',
] as const

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(
    entries
      .filter((entry) => !['dist', 'node_modules'].includes(entry.name))
      .map((entry) => {
        const entryPath = path.join(directory, entry.name)
        return entry.isDirectory() ? sourceFiles(entryPath) : [entryPath]
      }),
  )
  return nested.flat().filter((file) => /\.(?:json|ts|tsx)$/u.test(file))
}

describe('S4.4 server-only content boundary', () => {
  it.each(['apps/web', 'packages/contracts', 'packages/domain'])(
    'keeps private content and database imports out of %s',
    async (directory) => {
      const files = await sourceFiles(path.resolve(directory))
      const source = (
        await Promise.all(files.map((file) => readFile(file, 'utf8')))
      ).join('\n')

      expect(source).not.toMatch(SERVER_CONTENT_IMPORT)
      for (const marker of PRIVATE_CONTENT_MARKERS) {
        expect(source.toLowerCase()).not.toContain(marker)
      }
    },
  )

  it('uses an explicit public-web build allowlist that excludes docs and server content', async () => {
    const allowlist = (
      await readFile(
        path.resolve('ops/build-contexts/web-public.allowlist'),
        'utf8',
      )
    )
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'))

    expect(allowlist).toContain('apps/web')
    expect(allowlist).toContain('packages/contracts')
    expect(allowlist).not.toContain('.')
    expect(allowlist.every((entry) => !entry.startsWith('docs'))).toBe(true)
    expect(
      allowlist.every((entry) => !entry.startsWith('packages/database')),
    ).toBe(true)
  })

  it('defines the fixture as server source without reading historical narrative', async () => {
    const fixtureSource = await readFile(
      path.resolve('packages/database/src/content/fixtures/aster-quay.ts'),
      'utf8',
    )

    expect(fixtureSource).not.toContain('DailyRuneterraCase_Description')
    expect(fixtureSource).not.toMatch(/readFile|docs[\\/]content-policy/u)
  })
})
