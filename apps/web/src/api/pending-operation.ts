import {
  attemptPathSchema,
  gameplayCommandRequestSchema,
  idempotencyKeySchema,
  sessionBootstrapRequestSchema,
  slotIdSchema,
  timestampSchema,
  type GameplayCommandRequest,
} from '@loremaster/contracts'

export const PENDING_OPERATION_STORAGE_KEY = 'loremaster.pending-operation.v1'

const MAXIMUM_PENDING_RECORD_CHARACTERS = 2_048
const START_PATH = '/api/v1/cases/current/attempt'
const COMMAND_PATH_PATTERN =
  /^\/api\/v1\/attempts\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/commands$/iu

export interface StartPendingOperation {
  readonly body: Readonly<Record<string, never>>
  readonly createdAt: number
  readonly idempotencyKey: string
  readonly kind: 'START_ATTEMPT'
  readonly path: typeof START_PATH
  readonly targetClosesAt: string
  readonly targetSlotId: string
  readonly version: 1
}

export interface CommandPendingOperation {
  readonly body: GameplayCommandRequest
  readonly createdAt: number
  readonly idempotencyKey: string
  readonly kind: 'GAMEPLAY_COMMAND'
  readonly path: string
  readonly version: 1
}

export type PendingOperation = CommandPendingOperation | StartPendingOperation

export interface PendingOperationSummary {
  readonly createdAt: number
  readonly kind: PendingOperation['kind']
}

export interface PendingStorage {
  getItem(key: string): string | null
  removeItem(key: string): void
  setItem(key: string, value: string): void
}

export class PendingOperationStorageError extends Error {
  constructor() {
    super('The pending operation could not be stored safely.')
    this.name = 'PendingOperationStorageError'
  }
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort()
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === [...expected].sort()[index])
  )
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseCommon(
  value: Readonly<Record<string, unknown>>,
): { readonly createdAt: number; readonly idempotencyKey: string } | null {
  const key = idempotencyKeySchema.safeParse(value.idempotencyKey)
  if (
    !key.success ||
    typeof value.createdAt !== 'number' ||
    !Number.isSafeInteger(value.createdAt) ||
    value.createdAt < 0
  ) {
    return null
  }
  return { createdAt: value.createdAt, idempotencyKey: key.data }
}

function parsePendingOperation(value: unknown): PendingOperation | null {
  if (!isRecord(value) || value.version !== 1) return null
  const common = parseCommon(value)
  if (common === null) return null

  if (value.kind === 'START_ATTEMPT') {
    if (
      !hasExactKeys(value, [
        'body',
        'createdAt',
        'idempotencyKey',
        'kind',
        'path',
        'targetClosesAt',
        'targetSlotId',
        'version',
      ]) ||
      value.path !== START_PATH
    ) {
      return null
    }
    const body = sessionBootstrapRequestSchema.safeParse(value.body)
    const slot = slotIdSchema.safeParse(value.targetSlotId)
    const closesAt = timestampSchema.safeParse(value.targetClosesAt)
    if (!body.success || !slot.success || !closesAt.success) return null
    return {
      ...common,
      version: 1,
      kind: 'START_ATTEMPT',
      path: START_PATH,
      body: body.data,
      targetSlotId: slot.data,
      targetClosesAt: closesAt.data,
    }
  }

  if (
    value.kind !== 'GAMEPLAY_COMMAND' ||
    !hasExactKeys(value, [
      'body',
      'createdAt',
      'idempotencyKey',
      'kind',
      'path',
      'version',
    ]) ||
    typeof value.path !== 'string'
  ) {
    return null
  }
  const match = COMMAND_PATH_PATTERN.exec(value.path)
  const path = attemptPathSchema.safeParse({ attemptId: match?.[1] })
  const body = gameplayCommandRequestSchema.safeParse(value.body)
  if (!path.success || !body.success) return null
  return {
    ...common,
    version: 1,
    kind: 'GAMEPLAY_COMMAND',
    path: `/api/v1/attempts/${path.data.attemptId}/commands`,
    body: body.data,
  }
}

export function pendingAttemptId(operation: CommandPendingOperation): string {
  const match = COMMAND_PATH_PATTERN.exec(operation.path)
  if (match?.[1] === undefined) throw new PendingOperationStorageError()
  return match[1]
}

export function summarizePendingOperation(
  operation: PendingOperation,
): PendingOperationSummary {
  return { kind: operation.kind, createdAt: operation.createdAt }
}

export function createStartPendingOperation(input: {
  readonly createdAt: number
  readonly idempotencyKey: string
  readonly targetClosesAt: string
  readonly targetSlotId: string
}): StartPendingOperation {
  const parsed = parsePendingOperation({
    version: 1,
    kind: 'START_ATTEMPT',
    path: START_PATH,
    body: {},
    ...input,
  })
  if (parsed?.kind !== 'START_ATTEMPT') {
    throw new PendingOperationStorageError()
  }
  return parsed
}

export function createCommandPendingOperation(input: {
  readonly attemptId: string
  readonly body: GameplayCommandRequest
  readonly createdAt: number
  readonly idempotencyKey: string
}): CommandPendingOperation {
  const parsed = parsePendingOperation({
    version: 1,
    kind: 'GAMEPLAY_COMMAND',
    path: `/api/v1/attempts/${input.attemptId}/commands`,
    body: input.body,
    createdAt: input.createdAt,
    idempotencyKey: input.idempotencyKey,
  })
  if (parsed?.kind !== 'GAMEPLAY_COMMAND') {
    throw new PendingOperationStorageError()
  }
  return parsed
}

export class PendingOperationStore {
  readonly #storage: PendingStorage

  constructor(storage: PendingStorage) {
    this.#storage = storage
  }

  clear(): void {
    try {
      this.#storage.removeItem(PENDING_OPERATION_STORAGE_KEY)
    } catch {
      throw new PendingOperationStorageError()
    }
  }

  load(): PendingOperation | null {
    let serialized: string | null
    try {
      serialized = this.#storage.getItem(PENDING_OPERATION_STORAGE_KEY)
    } catch {
      throw new PendingOperationStorageError()
    }
    if (serialized === null) return null
    if (serialized.length > MAXIMUM_PENDING_RECORD_CHARACTERS) {
      this.clear()
      return null
    }
    try {
      const parsed = parsePendingOperation(JSON.parse(serialized))
      if (parsed !== null) return parsed
    } catch {
      // Invalid client-owned state is removed without exposing its contents.
    }
    this.clear()
    return null
  }

  save(operation: PendingOperation): void {
    const parsed = parsePendingOperation(operation)
    if (parsed === null) throw new PendingOperationStorageError()
    const serialized = JSON.stringify(parsed)
    if (serialized.length > MAXIMUM_PENDING_RECORD_CHARACTERS) {
      throw new PendingOperationStorageError()
    }
    try {
      this.#storage.setItem(PENDING_OPERATION_STORAGE_KEY, serialized)
    } catch {
      throw new PendingOperationStorageError()
    }
  }
}

export function createBrowserPendingOperationStore(
  storage: PendingStorage = window.sessionStorage,
): PendingOperationStore {
  return new PendingOperationStore(storage)
}
