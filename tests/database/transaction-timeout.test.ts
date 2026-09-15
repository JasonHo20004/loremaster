import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  DatabaseRollbackError,
  DatabaseTimeoutError,
  closeDatabase,
  database,
  transaction,
  type Database,
  type DeadlineContext,
} from '../../packages/database/dist/index.js'

const connectionString = process.env.LOREMASTER_TEST_DATABASE_URL
if (connectionString === undefined) {
  throw new Error(
    'LOREMASTER_TEST_DATABASE_URL is required; run this suite with `pnpm test:database`',
  )
}

let db: Database

beforeAll(() => {
  db = database(connectionString)
})

afterAll(async () => closeDatabase(db))

function deadline(milliseconds: number): DeadlineContext {
  const controller = new AbortController()
  return {
    deadlineAt: Date.now() + milliseconds,
    signal: controller.signal,
    now: () => Date.now(),
  }
}

describe('S5.3c cancellable database transactions', () => {
  it('installs the frozen local lock and statement timeout defaults', async () => {
    const settings = await transaction(db, async (client) => {
      const result = await client.query<{
        lock_timeout: string
        statement_timeout: string
      }>(
        `SELECT current_setting('lock_timeout') AS lock_timeout,
                current_setting('statement_timeout') AS statement_timeout`,
      )
      return result.rows[0]
    })

    expect(settings).toEqual({
      lock_timeout: '1s',
      statement_timeout: '3s',
    })
  })

  it('bounds exhausted pool acquisition and releases a later acquisition', async () => {
    const held = await Promise.all(
      Array.from({ length: 10 }, () => db.connect()),
    )
    try {
      await expect(
        transaction(db, async () => undefined, { deadline: deadline(40) }),
      ).rejects.toMatchObject({ code: 'DATABASE_TIMEOUT', phase: 'POOL' })
    } finally {
      for (const client of held) client.release()
    }
    await expect(db.query('SELECT 1')).resolves.toBeDefined()
  })

  it('classifies held locks and long statements and completes rollback', async () => {
    const guestId = randomUUID()
    await db.query(
      'INSERT INTO loremaster.guests (id, pseudonym) VALUES ($1, $2)',
      [guestId, `Guest-${guestId.slice(0, 8)}`],
    )
    const locker = await db.connect()
    try {
      await locker.query('BEGIN')
      await locker.query(
        'SELECT 1 FROM loremaster.guests WHERE id = $1 FOR UPDATE',
        [guestId],
      )
      await expect(
        transaction(
          db,
          async (client) =>
            client.query(
              'SELECT 1 FROM loremaster.guests WHERE id = $1 FOR UPDATE',
              [guestId],
            ),
          { deadline: deadline(1_000), lockTimeoutMs: 30 },
        ),
      ).rejects.toMatchObject({ code: 'DATABASE_TIMEOUT', phase: 'LOCK' })
      await expect(
        transaction(db, async (client) => client.query('SELECT pg_sleep(1)'), {
          deadline: deadline(1_000),
          statementTimeoutMs: 30,
        }),
      ).rejects.toMatchObject({
        code: 'DATABASE_TIMEOUT',
        phase: 'STATEMENT',
      })
    } finally {
      await locker.query('ROLLBACK')
      locker.release()
    }
  })

  it('destroys the transaction connection on client disconnect before returning', async () => {
    const controller = new AbortController()
    const context: DeadlineContext = {
      deadlineAt: Date.now() + 2_000,
      signal: controller.signal,
      now: () => Date.now(),
    }
    const operation = transaction(
      db,
      async (client) => client.query('SELECT pg_sleep(1)'),
      { deadline: context },
    )
    setTimeout(() => controller.abort('CLIENT_DISCONNECT'), 40).unref()

    await expect(operation).rejects.toMatchObject({
      code: 'DATABASE_TIMEOUT',
      phase: 'CLIENT_DISCONNECT',
    })
    await expect(db.query('SELECT 1')).resolves.toBeDefined()
  })

  it('creates no post-timeout mutation and permits recovery with the same key', async () => {
    const table = `timeout_recovery_${randomUUID().replaceAll('-', '')}`
    await db.query(`CREATE TABLE public.${table} (id text PRIMARY KEY)`)
    await db.query(
      `GRANT SELECT, INSERT ON public.${table} TO loremaster_runtime`,
    )
    const key = randomUUID()
    const controller = new AbortController()
    const context: DeadlineContext = {
      deadlineAt: Date.now() + 2_000,
      signal: controller.signal,
      now: () => Date.now(),
    }
    try {
      const first = transaction(
        db,
        async (client) => {
          await client.query('SELECT pg_sleep(1)')
          await client.query(`INSERT INTO public.${table} (id) VALUES ($1)`, [
            key,
          ])
        },
        { deadline: context },
      )
      setTimeout(() => controller.abort('DEADLINE'), 40).unref()
      await expect(first).rejects.toBeInstanceOf(DatabaseTimeoutError)
      expect(
        (
          await db.query(
            `SELECT count(*)::integer AS count FROM public.${table}`,
          )
        ).rows[0]?.count,
      ).toBe(0)

      await transaction(db, async (client) => {
        await client.query(`INSERT INTO public.${table} (id) VALUES ($1)`, [
          key,
        ])
      })
      expect(
        (
          await db.query(
            `SELECT count(*)::integer AS count FROM public.${table}`,
          )
        ).rows[0]?.count,
      ).toBe(1)
    } finally {
      await db.query(`DROP TABLE public.${table}`)
    }
  })

  it('destroys a client and returns a stable error after rollback failure', async () => {
    const client = new EventEmitter() as EventEmitter & {
      query(sql: string): Promise<object>
      release(error?: Error): void
    }
    client.query = async (sql) => {
      if (sql === 'ROLLBACK') throw new Error('rollback detail')
      return {}
    }
    client.release = () => queueMicrotask(() => client.emit('end'))
    const fakeDatabase = {
      connect: async () => client,
    } as unknown as Database

    await expect(
      transaction(fakeDatabase, async () => {
        throw new Error('work detail')
      }),
    ).rejects.toBeInstanceOf(DatabaseRollbackError)
  })
})
