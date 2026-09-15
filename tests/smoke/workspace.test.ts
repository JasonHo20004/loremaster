import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url))

const expectedWorkspaces = [
  'apps/api',
  'apps/queue-observer',
  'apps/web',
  'apps/worker',
  'packages/config',
  'packages/contracts',
  'packages/database',
  'packages/domain',
  'packages/observability',
  'packages/queue',
]

describe('workspace scaffold', () => {
  it.each(expectedWorkspaces)(
    '%s has the deterministic package surface',
    async (workspace) => {
      const packageJsonPath = resolve(repositoryRoot, workspace, 'package.json')
      const packageJson = JSON.parse(
        await readFile(packageJsonPath, 'utf8'),
      ) as {
        scripts?: Record<string, string>
      }

      expect(packageJson.scripts).toMatchObject({
        build: 'tsc -p tsconfig.json',
        clean: 'node ../../scripts/clean.mjs',
        typecheck: 'tsc -p tsconfig.json --noEmit',
      })
    },
  )

  it('builds database dependency declarations before a clean typecheck', async () => {
    const packageJson = JSON.parse(
      await readFile(
        resolve(repositoryRoot, 'packages/database/package.json'),
        'utf8',
      ),
    ) as { scripts?: Record<string, string> }

    expect(packageJson.scripts?.pretypecheck).toBe(
      'corepack pnpm --filter @loremaster/domain build',
    )
  })

  it('quotes database exclusions and exposes both PostgreSQL gates', async () => {
    const packageJson = JSON.parse(
      await readFile(resolve(repositoryRoot, 'package.json'), 'utf8'),
    ) as { scripts?: Record<string, string> }

    expect(packageJson.scripts?.test).toBe(
      'vitest run --exclude "tests/database/**" --exclude "tests/api/**/*.database.test.ts"',
    )
    expect(packageJson.scripts?.['test:database']).toBe(
      'node scripts/database-test.mjs',
    )
    expect(packageJson.scripts?.['test:api:database']).toBe(
      'node scripts/database-test.mjs api',
    )
  })
})
