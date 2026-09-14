import { readFile, stat } from 'node:fs/promises'

import type { Database } from '../migrate.js'
import {
  dryRunContentPack,
  importContentPack,
  type ContentImportDiagnostic,
} from './import.js'

export const MAX_CONTENT_PACK_FILE_BYTES = 256 * 1_024

export const CONTENT_CLI_DIAGNOSTIC_CODES = [
  'FILE_READ_FAILED',
  'FILE_TOO_LARGE',
  'INVALID_ARGUMENTS',
  'INVALID_JSON',
  'MISSING_DATABASE_URL',
] as const

export type ContentCliDiagnosticCode =
  (typeof CONTENT_CLI_DIAGNOSTIC_CODES)[number]

export interface ContentCliDiagnostic {
  readonly code: ContentCliDiagnosticCode
  readonly path: string
}

export interface ContentCliOptions {
  readonly db?: Database
  readonly mode: 'DRY_RUN' | 'PUBLISH'
  readonly path: string
}

export type ContentCliResult =
  | {
      readonly exitCode: 0
      readonly mode: 'DRY_RUN' | 'PUBLISH'
      readonly ok: true
      readonly revisionId?: string
      readonly status: 'PUBLISHED' | 'VALID'
    }
  | {
      readonly diagnostics: readonly (
        ContentCliDiagnostic | ContentImportDiagnostic
      )[]
      readonly exitCode: 2 | 3
      readonly mode: 'DRY_RUN' | 'PUBLISH'
      readonly ok: false
    }

function cliFailure(
  mode: ContentCliOptions['mode'],
  code: ContentCliDiagnosticCode,
  exitCode: 2 | 3,
  path = '$',
): ContentCliResult {
  return { diagnostics: [{ code, path }], exitCode, mode, ok: false }
}

export function parseContentCliArguments(
  arguments_: readonly string[],
):
  | { readonly mode: 'DRY_RUN' | 'PUBLISH'; readonly path: string }
  | { readonly diagnostic: ContentCliDiagnostic } {
  let mode: 'DRY_RUN' | 'PUBLISH' = 'PUBLISH'
  let path: string | undefined
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]
    if (argument === '--dry-run') {
      mode = 'DRY_RUN'
    } else if (argument === '--file' && index + 1 < arguments_.length) {
      path = arguments_[index + 1]
      index += 1
    } else {
      return { diagnostic: { code: 'INVALID_ARGUMENTS', path: '$' } }
    }
  }
  if (path === undefined || path.length === 0) {
    return { diagnostic: { code: 'INVALID_ARGUMENTS', path: '$' } }
  }
  return { mode, path }
}

async function readBoundedJson(
  options: ContentCliOptions,
): Promise<
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly result: ContentCliResult }
> {
  try {
    const metadata = await stat(options.path)
    if (!metadata.isFile()) {
      return {
        ok: false,
        result: cliFailure(options.mode, 'FILE_READ_FAILED', 2, '$.file'),
      }
    }
    if (metadata.size > MAX_CONTENT_PACK_FILE_BYTES) {
      return {
        ok: false,
        result: cliFailure(options.mode, 'FILE_TOO_LARGE', 2, '$.file'),
      }
    }
    const contents = await readFile(options.path, 'utf8')
    if (Buffer.byteLength(contents, 'utf8') > MAX_CONTENT_PACK_FILE_BYTES) {
      return {
        ok: false,
        result: cliFailure(options.mode, 'FILE_TOO_LARGE', 2, '$.file'),
      }
    }
    try {
      return { ok: true, value: JSON.parse(contents) as unknown }
    } catch {
      return {
        ok: false,
        result: cliFailure(options.mode, 'INVALID_JSON', 2, '$.file'),
      }
    }
  } catch {
    return {
      ok: false,
      result: cliFailure(options.mode, 'FILE_READ_FAILED', 2, '$.file'),
    }
  }
}

export async function executeContentCli(
  options: ContentCliOptions,
): Promise<ContentCliResult> {
  const file = await readBoundedJson(options)
  if (!file.ok) return file.result
  if (options.db === undefined) {
    return cliFailure(options.mode, 'MISSING_DATABASE_URL', 3)
  }

  const result =
    options.mode === 'DRY_RUN'
      ? await dryRunContentPack(options.db, file.value)
      : await importContentPack(options.db, file.value, 'PUBLISH')
  if (!result.ok) {
    const connectionFailure = result.diagnostics.some(
      ({ code }) => code === 'DATABASE_UNAVAILABLE',
    )
    return {
      diagnostics: result.diagnostics,
      exitCode: connectionFailure ? 3 : 2,
      mode: options.mode,
      ok: false,
    }
  }
  if (options.mode === 'DRY_RUN') {
    return { exitCode: 0, mode: options.mode, ok: true, status: 'VALID' }
  }
  if (!('revisionId' in result)) {
    return {
      diagnostics: [{ code: 'IMPORT_CONSTRAINT_VIOLATION', path: '$' }],
      exitCode: 3,
      mode: options.mode,
      ok: false,
    }
  }
  return {
    exitCode: 0,
    mode: options.mode,
    ok: true,
    revisionId: result.revisionId,
    status: 'PUBLISHED',
  }
}
