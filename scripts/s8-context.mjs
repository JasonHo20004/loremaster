import { createHash } from 'node:crypto'
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import process from 'node:process'
import { fileURLToPath, URL } from 'node:url'

export const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
export const profiles = Object.freeze([
  'web-public',
  'api',
  'worker',
  'observer',
  'migration',
  'importer',
])
const sourceRoots = {
  'web-public': ['apps/web/src', 'packages/contracts/src'],
  api: [
    'apps/api/src',
    'packages/cache/src',
    'packages/config/src',
    'packages/contracts/src',
    'packages/database/src',
    'packages/domain/src',
    'packages/observability/src',
    'packages/queue/src',
  ],
  worker: [
    'apps/worker/src',
    'packages/cache/src',
    'packages/config/src',
    'packages/database/src',
    'packages/domain/src',
    'packages/observability/src',
    'packages/queue/src',
  ],
  observer: [
    'apps/queue-observer/src',
    'packages/cache/src',
    'packages/config/src',
    'packages/observability/src',
    'packages/queue/src',
  ],
  migration: ['packages/database/src', 'packages/domain/src'],
  importer: ['packages/database/src', 'packages/domain/src'],
}

const forbidden =
  /(^|\/)(?:\.git|\.env(?:\..*)?|node_modules|test-results|tests?|fixtures|coverage|\.pnpm-store)(\/|$)|(?:\.test|\.spec)\.[cm]?[jt]sx?$|\.map$/iu

export function readAllowlist(profile, root = repositoryRoot) {
  if (!profiles.includes(profile)) throw new Error('Unknown S8 context profile')
  const path = join(root, 'ops', 'build-contexts', `${profile}.allowlist`)
  const entries = readFileSync(path, 'utf8')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
  if (entries.length === 0 || new Set(entries).size !== entries.length) {
    throw new Error('Empty or duplicate S8 context entry')
  }
  for (const entry of entries) {
    if (
      entry.startsWith('/') ||
      entry.includes('\\') ||
      entry
        .split('/')
        .some(
          (segment) => segment === '' || segment === '.' || segment === '..',
        ) ||
      forbidden.test(entry)
    ) {
      throw new Error(`Unsafe S8 context entry: ${entry}`)
    }
    const source = join(root, ...entry.split('/'))
    let current = root
    for (const segment of entry.split('/')) {
      current = join(current, segment)
      if (lstatSync(current).isSymbolicLink()) {
        throw new Error(`Symlink in S8 context entry: ${entry}`)
      }
    }
    if (!lstatSync(source).isFile()) {
      throw new Error(`S8 context entry is not a file: ${entry}`)
    }
  }
  const admitted = new Set(entries)
  for (const sourceRoot of sourceRoots[profile]) {
    const visit = (directory) => {
      for (const item of readdirSync(join(root, ...directory.split('/')), {
        withFileTypes: true,
      })) {
        const path = `${directory}/${item.name}`
        if (item.isDirectory()) {
          if (item.name !== 'fixtures') visit(path)
        } else if (!forbidden.test(path) && !admitted.has(path)) {
          throw new Error(
            `S8 source is missing from ${profile} allowlist: ${path}`,
          )
        }
      }
    }
    visit(sourceRoot)
  }
  return entries.sort()
}

export function buildContext(profile, destination, root = repositoryRoot) {
  const entries = readAllowlist(profile, root)
  const output = resolve(destination)
  const sourceRoot = resolve(root)
  if (output === sourceRoot || output.startsWith(`${sourceRoot}${sep}`)) {
    throw new Error('S8 context destination must be outside the repository')
  }
  mkdirSync(output)
  const manifest = []
  for (const entry of entries) {
    const source = join(root, ...entry.split('/'))
    const target = join(output, ...entry.split('/'))
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(source, target)
    const bytes = readFileSync(target)
    manifest.push({
      path: entry,
      bytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })
  }
  writeFileSync(
    join(output, 's8-context-manifest.json'),
    `${JSON.stringify({ profile, files: manifest }, null, 2)}\n`,
  )
  return { profile, files: manifest }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [, , profile, destination] = process.argv
  if (!profile || !destination)
    throw new Error(
      'Usage: node scripts/s8-context.mjs <profile> <empty-destination>',
    )
  const result = buildContext(profile, destination)
  process.stdout.write(`${result.profile}: ${result.files.length} files\n`)
}
