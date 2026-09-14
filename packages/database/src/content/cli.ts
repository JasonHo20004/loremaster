import process from 'node:process'
import { pathToFileURL } from 'node:url'

import { closeDatabase, database } from '../migrate.js'
import { executeContentCli, parseContentCliArguments } from './cli-core.js'

export async function runContentCli(
  arguments_ = process.argv.slice(2),
): Promise<number> {
  const parsed = parseContentCliArguments(arguments_)
  if ('diagnostic' in parsed) {
    process.stdout.write(
      `${JSON.stringify({ diagnostics: [parsed.diagnostic], exitCode: 2, ok: false })}\n`,
    )
    return 2
  }
  const connectionString = process.env.LOREMASTER_IMPORT_DATABASE_URL
  if (connectionString === undefined) {
    const result = await executeContentCli({ ...parsed })
    process.stdout.write(`${JSON.stringify(result)}\n`)
    return result.exitCode
  }

  const db = database(connectionString)
  try {
    const result = await executeContentCli({
      ...parsed,
      db,
    })
    process.stdout.write(`${JSON.stringify(result)}\n`)
    return result.exitCode
  } finally {
    await closeDatabase(db).catch(() => undefined)
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await runContentCli()
}
