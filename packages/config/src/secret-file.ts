import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from 'node:fs'
import { dirname, isAbsolute, parse } from 'node:path'

type Environment = Readonly<Record<string, string | undefined>>

const MAXIMUM_SECRET_BYTES = 4096
const READ_ONLY_MODES = new Set([0o400, 0o440, 0o444])

export class SecretFileError extends Error {
  constructor(readonly field: string) {
    super(`Invalid secret file configuration: ${field}`)
    this.name = 'SecretFileError'
  }
}

function readSecret(path: string, field: string): string {
  if (
    path.length === 0 ||
    path.length > 4096 ||
    path.trim() !== path ||
    path.includes('\0') ||
    !isAbsolute(path)
  ) {
    throw new SecretFileError(field)
  }
  let descriptor: number | undefined
  try {
    let parent = dirname(path)
    while (parent !== parse(parent).root) {
      if (lstatSync(parent).isSymbolicLink()) throw new SecretFileError(field)
      parent = dirname(parent)
    }
    const before = lstatSync(path)
    if (!before.isFile() || before.isSymbolicLink()) {
      throw new SecretFileError(field)
    }
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const opened = fstatSync(descriptor)
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size === 0 ||
      opened.size > MAXIMUM_SECRET_BYTES
    ) {
      throw new SecretFileError(field)
    }
    if (process.platform !== 'win32') {
      const uid = process.getuid?.()
      if (
        !READ_ONLY_MODES.has(opened.mode & 0o777) ||
        (opened.uid !== 0 && opened.uid !== uid)
      ) {
        throw new SecretFileError(field)
      }
    }
    const bytes = readFileSync(descriptor)
    if (bytes.byteLength !== opened.size || bytes.includes(0)) {
      throw new SecretFileError(field)
    }
    const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (value.trim() !== value || value.length === 0) {
      throw new SecretFileError(field)
    }
    return value
  } catch {
    throw new SecretFileError(field)
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

export function resolveFileSecrets(
  environment: Environment,
  keys: readonly string[],
): Environment {
  const resolved = { ...environment }
  for (const key of keys) {
    const fileKey = `${key}_FILE`
    const path = environment[fileKey]
    if (path === undefined) continue
    if (environment[key] !== undefined) throw new SecretFileError(fileKey)
    resolved[key] = readSecret(path, fileKey)
    delete resolved[fileKey]
  }
  return resolved
}

export function requireFilesInProduction(
  original: Environment,
  mode: 'local' | 'production',
  keys: readonly string[],
): void {
  if (mode !== 'production') return
  for (const key of keys) {
    if (original[key] !== undefined) throw new SecretFileError(`${key}_FILE`)
  }
}
