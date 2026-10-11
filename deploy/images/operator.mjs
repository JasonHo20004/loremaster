import process from 'node:process'
import { URL } from 'node:url'
import { Buffer } from 'node:buffer'
import { TextDecoder } from 'node:util'
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from 'node:fs'
import { resolveFileSecrets } from './secret-file.js'
import { database, closeDatabase } from './dist/pool.js'

const kind = process.env.LOREMASTER_OPERATOR
const field =
  kind === 'migration'
    ? 'LOREMASTER_MIGRATION_DATABASE_URL'
    : 'LOREMASTER_IMPORT_DATABASE_URL'
const mode = process.argv.slice(2)
async function run() {
  if (
    !['migration', 'importer'].includes(kind) ||
    mode.some((x) => x !== '--dry-run') ||
    mode.length > 1 ||
    (kind === 'migration' && mode.length)
  )
    throw Error('configuration')
  if (process.env[field] !== undefined || !process.env[field + '_FILE'])
    throw Error('configuration')
  const secret = resolveFileSecrets(process.env, [field])[field]
  const url = new URL(secret)
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !url.username ||
    !url.password ||
    url.pathname.length < 2
  )
    throw Error('configuration')
  let pack
  if (kind === 'importer') {
    const path = '/run/content/pack.json'
    for (const part of ['/run', '/run/content', path])
      if (lstatSync(part).isSymbolicLink()) throw Error('mount')
    const before = lstatSync(path)
    if (!before.isFile()) throw Error('mount')
    const fd = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    )
    try {
      const stat = fstatSync(fd)
      if (
        !stat.isFile() ||
        stat.ino !== before.ino ||
        stat.dev !== before.dev ||
        ![0, process.getuid()].includes(stat.uid) ||
        ![0o400, 0o440, 0o444].includes(stat.mode & 0o777) ||
        stat.size < 1 ||
        stat.size > 262144
      )
        throw Error('mount')
      const bytes = Buffer.alloc(262145)
      let count = 0,
        n = 0
      do {
        n = readSync(fd, bytes, count, bytes.length - count, null)
        count += n
      } while (n > 0 && count < bytes.length)
      if (
        count !== stat.size ||
        count > 262144 ||
        bytes.subarray(0, count).includes(0)
      )
        throw Error('mount')
      pack = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(
          bytes.subarray(0, count),
        ),
      )
    } finally {
      closeSync(fd)
    }
  }
  const db = database(secret, { connectionTimeoutMs: 3000 })
  try {
    if (kind === 'migration') {
      const { migrateToLatest } = await import('./dist/migrate.js')
      const applied = await migrateToLatest(db)
      process.stdout.write(
        JSON.stringify({
          ok: true,
          status: applied.length ? 'APPLIED' : 'NO_OP',
          count: applied.length,
        }) + '\n',
      )
    } else {
      const { dryRunContentPack, importContentPack } =
        await import('./dist/content/import.js')
      const result = mode.length
        ? await dryRunContentPack(db, pack)
        : await importContentPack(db, pack, 'PUBLISH')
      process.stdout.write(
        JSON.stringify({
          ok: result.ok,
          status: result.ok
            ? mode.length
              ? 'VALID'
              : 'PUBLISHED'
            : 'REJECTED',
          codes: result.ok ? [] : result.diagnostics.map((x) => x.code),
        }) + '\n',
      )
      if (!result.ok)
        process.exitCode = result.diagnostics.some(
          (x) => x.code === 'DATABASE_UNAVAILABLE',
        )
          ? 3
          : 2
    }
  } finally {
    await closeDatabase(db)
  }
}
run().catch(() => {
  process.stderr.write('Loremaster operator failed\n')
  process.exitCode = 3
})
