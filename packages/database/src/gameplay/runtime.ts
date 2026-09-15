import { once } from 'node:events'

import type { PoolClient } from 'pg'

import {
  cancellationReason,
  DatabaseRollbackError,
  DatabaseTimeoutError,
  remainingMilliseconds,
  throwIfCancelled,
  type DeadlineContext,
} from '../deadline.js'
import type { Database } from '../migrate.js'

interface PostgreSqlError {
  readonly code?: unknown
}

const MAXIMUM_LOCK_TIMEOUT_MS = 1_000
const MAXIMUM_STATEMENT_TIMEOUT_MS = 3_000

export interface TransactionOptions {
  readonly deadline?: DeadlineContext
  readonly lockTimeoutMs?: number
  readonly readOnly?: boolean
  readonly statementTimeoutMs?: number
}

function timeoutError(error: unknown, deadline?: DeadlineContext): unknown {
  if (error instanceof DatabaseTimeoutError) return error
  if (deadline?.signal.aborted === true) {
    return new DatabaseTimeoutError(cancellationReason(deadline.signal), {
      cause: error,
    })
  }
  const code =
    typeof error === 'object' && error !== null
      ? (error as PostgreSqlError).code
      : undefined
  if (code === '55P03')
    return new DatabaseTimeoutError('LOCK', { cause: error })
  if (code === '57014') {
    return new DatabaseTimeoutError('STATEMENT', { cause: error })
  }
  return error
}

function boundedTimeout(value: number | undefined, maximum: number): number {
  const timeout = value ?? maximum
  if (!Number.isSafeInteger(timeout) || timeout < 1) {
    throw new RangeError('Database timeout must be a positive safe integer')
  }
  return Math.min(timeout, maximum)
}

async function acquireClient(
  db: Database,
  deadline?: DeadlineContext,
): Promise<PoolClient> {
  if (deadline === undefined) return db.connect()
  throwIfCancelled(deadline)

  const acquisition = db.connect()
  const remaining = remainingMilliseconds(deadline)
  let timedOut = false
  let timer: NodeJS.Timeout | undefined
  let abort: (() => void) | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    const rejectTimeout = () => {
      timedOut = true
      reject(
        new DatabaseTimeoutError(
          deadline.signal.aborted
            ? cancellationReason(deadline.signal)
            : 'POOL',
        ),
      )
    }
    abort = rejectTimeout
    deadline.signal.addEventListener('abort', rejectTimeout, { once: true })
    timer = setTimeout(rejectTimeout, remaining)
    timer.unref()
  })

  acquisition.then(
    (client) => {
      if (timedOut) client.release()
    },
    () => undefined,
  )

  try {
    return await Promise.race([acquisition, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (abort !== undefined) deadline.signal.removeEventListener('abort', abort)
  }
}

async function waitForClientEnd(client: PoolClient): Promise<void> {
  if ((client as PoolClient & { readonly _ended?: boolean })._ended === true)
    return
  await once(client, 'end').then(() => undefined)
}

async function runWork<T>(
  work: Promise<T>,
  deadline?: DeadlineContext,
): Promise<T> {
  if (deadline === undefined) return work
  let rejectCancellation: (() => void) | undefined
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = () =>
      reject(new DatabaseTimeoutError(cancellationReason(deadline.signal)))
    if (deadline.signal.aborted) rejectCancellation()
    else
      deadline.signal.addEventListener('abort', rejectCancellation, {
        once: true,
      })
  })
  try {
    return await Promise.race([work, cancellation])
  } finally {
    if (rejectCancellation !== undefined) {
      deadline.signal.removeEventListener('abort', rejectCancellation)
    }
  }
}

export async function transaction<T>(
  db: Database,
  work: (client: PoolClient) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  const client = await acquireClient(db, options.deadline)
  let released = false
  let transactionStarted = false
  let cancelling = false
  let cancellationComplete: Promise<void> | undefined

  const cancel = () => {
    if (released || cancelling) return
    cancelling = true
    cancellationComplete = waitForClientEnd(client)
    client.release(new Error('cancelled'))
    released = true
  }
  options.deadline?.signal.addEventListener('abort', cancel, { once: true })

  try {
    if (options.deadline !== undefined) throwIfCancelled(options.deadline)
    await client.query(options.readOnly === true ? 'BEGIN READ ONLY' : 'BEGIN')
    transactionStarted = true
    await client.query('SET LOCAL ROLE loremaster_runtime')

    const lockTimeoutMs = boundedTimeout(
      options.lockTimeoutMs,
      MAXIMUM_LOCK_TIMEOUT_MS,
    )
    const configuredStatementTimeoutMs = boundedTimeout(
      options.statementTimeoutMs,
      MAXIMUM_STATEMENT_TIMEOUT_MS,
    )
    const statementTimeoutMs =
      options.deadline === undefined
        ? configuredStatementTimeoutMs
        : Math.max(
            1,
            Math.min(
              configuredStatementTimeoutMs,
              remainingMilliseconds(options.deadline),
            ),
          )
    await client.query("SELECT set_config('lock_timeout', $1, true)", [
      `${lockTimeoutMs}ms`,
    ])
    await client.query("SELECT set_config('statement_timeout', $1, true)", [
      `${statementTimeoutMs}ms`,
    ])

    const result = await runWork(work(client), options.deadline)

    if (options.deadline !== undefined) throwIfCancelled(options.deadline)
    options.deadline?.signal.removeEventListener('abort', cancel)
    await client.query('COMMIT')
    transactionStarted = false
    return result
  } catch (caught) {
    const error = timeoutError(caught, options.deadline)
    if (cancellationComplete !== undefined) {
      await cancellationComplete
      throw error
    }
    if (transactionStarted) {
      try {
        await client.query('ROLLBACK')
        transactionStarted = false
      } catch (rollbackError) {
        if (!released) {
          cancellationComplete = waitForClientEnd(client)
          client.release(rollbackError as Error)
          released = true
          await cancellationComplete
        }
        if (error instanceof DatabaseTimeoutError) throw error
        throw new DatabaseRollbackError({ cause: error })
      }
    }
    throw error
  } finally {
    options.deadline?.signal.removeEventListener('abort', cancel)
    if (!released) client.release()
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
