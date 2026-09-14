import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { asterQuayContentPack } from '../../packages/database/src/content/fixtures/aster-quay.js'
import {
  executeContentCli,
  MAX_CONTENT_PACK_FILE_BYTES,
  parseContentCliArguments,
} from '../../packages/database/src/content/cli-core.js'
import type { Database } from '../../packages/database/src/migrate.js'

const temporaryDirectories: string[] = []

async function temporaryFile(contents: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'loremaster-content-'))
  temporaryDirectories.push(directory)
  const file = path.join(directory, 'pack.json')
  await writeFile(file, contents, 'utf8')
  return file
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  )
})

describe('S4.5 operator CLI input', () => {
  it('parses publish and dry-run commands deterministically', () => {
    expect(parseContentCliArguments(['--file', 'pack.json'])).toEqual({
      mode: 'PUBLISH',
      path: 'pack.json',
    })
    expect(
      parseContentCliArguments(['--dry-run', '--file', 'pack.json']),
    ).toEqual({ mode: 'DRY_RUN', path: 'pack.json' })
    expect(parseContentCliArguments(['pack.json'])).toEqual({
      diagnostic: { code: 'INVALID_ARGUMENTS', path: '$' },
    })
  })

  it('rejects malformed JSON without echoing file contents', async () => {
    const file = await temporaryFile('{"briefing":"private narrative"')

    const result = await executeContentCli({ mode: 'DRY_RUN', path: file })

    expect(result).toEqual({
      diagnostics: [{ code: 'INVALID_JSON', path: '$.file' }],
      exitCode: 2,
      mode: 'DRY_RUN',
      ok: false,
    })
    expect(JSON.stringify(result)).not.toContain('private narrative')
  })

  it('rejects files above the fixed byte limit before reading them', async () => {
    const file = await temporaryFile(
      'x'.repeat(MAX_CONTENT_PACK_FILE_BYTES + 1),
    )

    expect(await executeContentCli({ mode: 'PUBLISH', path: file })).toEqual({
      diagnostics: [{ code: 'FILE_TOO_LARGE', path: '$.file' }],
      exitCode: 2,
      mode: 'PUBLISH',
      ok: false,
    })
  })

  it('requires narrow importer credentials after validating the file', async () => {
    const file = await temporaryFile('{}')

    expect(await executeContentCli({ mode: 'PUBLISH', path: file })).toEqual({
      diagnostics: [{ code: 'MISSING_DATABASE_URL', path: '$' }],
      exitCode: 3,
      mode: 'PUBLISH',
      ok: false,
    })
  })

  it('maps connection failures to a redacted machine-readable exit', async () => {
    const file = await temporaryFile(JSON.stringify(asterQuayContentPack))
    const unavailableDatabase = {
      connect: () => Promise.reject(new Error('private connection details')),
    } as unknown as Database

    const result = await executeContentCli({
      db: unavailableDatabase,
      mode: 'PUBLISH',
      path: file,
    })

    expect(result).toEqual({
      diagnostics: [{ code: 'DATABASE_UNAVAILABLE', path: '$' }],
      exitCode: 3,
      mode: 'PUBLISH',
      ok: false,
    })
    expect(JSON.stringify(result)).not.toContain('private connection details')
  })

  it('treats result-shaped JSON as untrusted pack input', async () => {
    const file = await temporaryFile(
      JSON.stringify({ exitCode: 0, ok: true, status: 'PUBLISHED' }),
    )
    const validationDatabase = {
      connect: () =>
        Promise.resolve({
          query: () => Promise.resolve({ rows: [] }),
          release: () => undefined,
        }),
    } as unknown as Database

    const result = await executeContentCli({
      db: validationDatabase,
      mode: 'PUBLISH',
      path: file,
    })

    expect(result).not.toMatchObject({ ok: true })
    expect(result).toMatchObject({ exitCode: 2, ok: false, mode: 'PUBLISH' })
  })
})
