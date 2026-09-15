export type CancellationReason = 'CLIENT_DISCONNECT' | 'DEADLINE'

export interface DeadlineContext {
  readonly deadlineAt: number
  readonly signal: AbortSignal
  now(): number
}

export type DatabaseTimeoutPhase =
  'CLIENT_DISCONNECT' | 'DEADLINE' | 'LOCK' | 'POOL' | 'STATEMENT'

export class DatabaseTimeoutError extends Error {
  readonly code = 'DATABASE_TIMEOUT'
  readonly phase: DatabaseTimeoutPhase

  constructor(phase: DatabaseTimeoutPhase, options?: ErrorOptions) {
    super('Database operation timed out', options)
    this.name = 'DatabaseTimeoutError'
    this.phase = phase
  }
}

export class DatabaseRollbackError extends Error {
  readonly code = 'DATABASE_ROLLBACK_FAILED'

  constructor(options?: ErrorOptions) {
    super('Database transaction rollback failed', options)
    this.name = 'DatabaseRollbackError'
  }
}

export function cancellationReason(signal: AbortSignal): CancellationReason {
  return signal.reason === 'CLIENT_DISCONNECT'
    ? 'CLIENT_DISCONNECT'
    : 'DEADLINE'
}

export function remainingMilliseconds(deadline: DeadlineContext): number {
  return Math.max(0, Math.ceil(deadline.deadlineAt - deadline.now()))
}

export function throwIfCancelled(deadline: DeadlineContext): void {
  if (deadline.signal.aborted || remainingMilliseconds(deadline) === 0) {
    throw new DatabaseTimeoutError(cancellationReason(deadline.signal))
  }
}

export function isDatabaseTimeoutError(
  error: unknown,
): error is DatabaseTimeoutError {
  return (
    error instanceof DatabaseTimeoutError ||
    (typeof error === 'object' &&
      error !== null &&
      (error as { readonly code?: unknown }).code === 'DATABASE_TIMEOUT')
  )
}
