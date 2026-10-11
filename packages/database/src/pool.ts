import pg from 'pg'

const { Pool } = pg

export type Database = pg.Pool

export function database(
  connectionString: string,
  options: { connectionTimeoutMs?: number } = {},
): Database {
  const pool = new Pool({
    connectionString,
    max: 10,
    ...(options.connectionTimeoutMs === undefined
      ? {}
      : { connectionTimeoutMillis: options.connectionTimeoutMs }),
  })
  let lastFailure = 0
  pool.on('error', () => {
    const now = Date.now()
    if (now - lastFailure >= 60000) {
      lastFailure = now
      process.stderr.write('Loremaster database: unavailable\n')
    }
  })
  return pool
}

export async function closeDatabase(db: Database): Promise<void> {
  await db.end()
}
