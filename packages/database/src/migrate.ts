import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import pg from 'pg'

const { Pool } = pg

export type Database = pg.Pool

export function database(connectionString: string): Database {
  return new Pool({ connectionString, max: 10 })
}

export async function closeDatabase(db: Database): Promise<void> {
  await db.end()
}

export async function migrateToLatest(
  db: Database,
  migrationsDirectory = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    'migrations',
  ),
): Promise<readonly string[]> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS public.loremaster_schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
    )
  `)

  const entries = (await readdir(migrationsDirectory))
    .filter((name) => /^\d+_.+\.up\.sql$/.test(name))
    .sort()
  const applied: string[] = []

  for (const name of entries) {
    const existing = await db.query<{ exists: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM public.loremaster_schema_migrations WHERE name = $1) AS exists',
      [name],
    )
    if (existing.rows[0]?.exists === true) continue

    const sql = await readFile(join(migrationsDirectory, name), 'utf8')
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      await client.query(sql)
      await client.query(
        'INSERT INTO public.loremaster_schema_migrations (name) VALUES ($1)',
        [name],
      )
      await client.query('COMMIT')
      applied.push(name)
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  return applied
}
