import type { PoolClient } from 'pg'

import type { Database } from '../migrate.js'

export async function transaction<T>(
  db: Database,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    await client.query('SET LOCAL ROLE loremaster_runtime')
    await client.query("SET LOCAL lock_timeout = '1s'")
    await client.query("SET LOCAL statement_timeout = '3s'")
    const result = await work(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

export async function lockGuest(
  client: PoolClient,
  guestId: string,
): Promise<boolean> {
  const result = await client.query(
    'SELECT 1 FROM loremaster.guests WHERE id = $1 FOR UPDATE',
    [guestId],
  )
  return result.rowCount === 1
}

export async function sessionIsLive(
  client: PoolClient,
  guestId: string,
  sessionId: string,
): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM loremaster.guest_sessions
     WHERE id = $1 AND guest_id = $2 AND expires_at > clock_timestamp()
    `,
    [sessionId, guestId],
  )
  return result.rowCount === 1
}

export async function databaseNow(client: PoolClient): Promise<Date> {
  const result = await client.query<{ now: Date }>(
    'SELECT clock_timestamp() AS now',
  )
  return result.rows[0]!.now
}
