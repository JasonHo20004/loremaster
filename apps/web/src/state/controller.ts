import type { GameplayCommandRequest } from '@loremaster/contracts'

import type { ApiClient, ApiClientResponse } from '../api/client.js'
import { ApiClientError } from '../api/errors.js'
import { createIdempotencyKey, type RandomUuid } from '../api/idempotency.js'
import {
  createCommandPendingOperation,
  createStartPendingOperation,
  pendingAttemptId,
  PendingOperationStorageError,
  summarizePendingOperation,
  type PendingOperation,
  type PendingOperationStore,
  type PendingOperationSummary,
} from '../api/pending-operation.js'
import { retryDirective } from '../api/retry.js'
import { SessionBootstrap } from '../session/bootstrap.js'
import { LatestRead } from './latest-read.js'

export type CaseProjection = ApiClientResponse<'getCurrentCase'>['data']
export type AttemptProjection = ApiClientResponse<'getOwnedAttempt'>['data']

export type ControllerStatus =
  'IDLE' | 'HYDRATING' | 'READ_ERROR' | 'READY' | 'SESSION_LOST'
export type MutationStatus = 'IDLE' | 'IN_FLIGHT' | 'STALE' | 'UNCERTAIN'

export interface GameControllerState {
  readonly currentCase?: CaseProjection
  readonly displayedAttempt?: AttemptProjection
  readonly error?: ApiClientError | PendingOperationStorageError
  readonly mutationStatus: MutationStatus
  readonly pendingOperation?: PendingOperationSummary
  readonly sessionExpiresAt?: string
  readonly status: ControllerStatus
}

export interface ReconciliationResult {
  readonly status: 'NO_PENDING' | 'RESOLVED' | 'UNRESOLVED'
}

export class PendingOperationExistsError extends Error {
  constructor() {
    super('Resolve the pending operation before starting another action.')
    this.name = 'PendingOperationExistsError'
  }
}

export class InvalidControllerActionError extends Error {
  constructor() {
    super('The action is not available in the current state.')
    this.name = 'InvalidControllerActionError'
  }
}

interface TimerScheduler {
  clearTimeout(handle: number): void
  setTimeout(callback: () => void, milliseconds: number): number
}

interface FocusTarget {
  addEventListener(type: 'focus', listener: () => void): void
  removeEventListener(type: 'focus', listener: () => void): void
}

interface VisibilityTarget {
  readonly visibilityState: string
  addEventListener(type: 'visibilitychange', listener: () => void): void
  removeEventListener(type: 'visibilitychange', listener: () => void): void
}

export interface GameControllerOptions {
  readonly client: ApiClient
  readonly now?: () => number
  readonly pendingStore: PendingOperationStore
  readonly randomUuid?: RandomUuid
  readonly timers?: TimerScheduler
}

type Listener = (state: GameControllerState) => void

const MAXIMUM_TIMER_DELAY = 2_147_483_647

function browserTimers(): TimerScheduler {
  return {
    setTimeout: (callback, milliseconds) =>
      globalThis.setTimeout(callback, milliseconds),
    clearTimeout: (handle) => globalThis.clearTimeout(handle),
  }
}

function isAuthenticationLoss(error: unknown): error is ApiClientError {
  return (
    error instanceof ApiClientError &&
    error.kind === 'API_ERROR' &&
    error.apiCode === 'AUTHENTICATION_REQUIRED'
  )
}

function isCancellation(error: unknown): boolean {
  return error instanceof ApiClientError && error.kind === 'CANCELLED'
}

function closesAt(projection: CaseProjection): string | undefined {
  return projection.view === 'NO_CASE' ? undefined : projection.closesAt
}

function commandOutcomeIsProven(
  pending: Extract<PendingOperation, { readonly kind: 'GAMEPLAY_COMMAND' }>,
  attempt: AttemptProjection,
): boolean {
  if (attempt.version <= pending.body.expectedVersion) return false
  const command = pending.body.command
  if (command.kind === 'GIVE_UP') return attempt.state === 'GIVEN_UP'
  if (command.kind !== 'GUESS' || attempt.state === 'ACTIVE') return false
  if (attempt.state === 'SOLVED') {
    return attempt.answer.entityId === command.entityId
  }
  if (attempt.state !== 'EXHAUSTED') return false
  return attempt.guessHistory.at(-1)?.entityId === command.entityId
}

export class GameController {
  readonly #client: ApiClient
  readonly #currentRead: LatestRead<ApiClientResponse<'getCurrentCase'>>
  readonly #listeners = new Set<Listener>()
  readonly #now: () => number
  readonly #ownedReads = new Map<
    string,
    LatestRead<ApiClientResponse<'getOwnedAttempt'>>
  >()
  readonly #pendingStore: PendingOperationStore
  readonly #randomUuid: RandomUuid | undefined
  readonly #session: SessionBootstrap
  readonly #timers: TimerScheduler
  #focusTarget?: FocusTarget
  #hydrateGeneration = 0
  #mutationInFlight = false
  #recoveryInProgress = false
  #rolloverClosesAt?: string
  #rolloverTimer?: number
  #sessionAbort?: AbortController
  #sessionReady = false
  #state: GameControllerState = {
    status: 'IDLE',
    mutationStatus: 'IDLE',
  }
  #visibilityTarget?: VisibilityTarget

  readonly #onFocus = (): void => {
    void this.refreshCurrentCase(true)
  }

  readonly #onVisibilityChange = (): void => {
    if (this.#visibilityTarget?.visibilityState === 'visible') {
      void this.refreshCurrentCase(true)
    }
  }

  constructor(options: GameControllerOptions) {
    this.#client = options.client
    this.#pendingStore = options.pendingStore
    this.#randomUuid = options.randomUuid
    this.#now = options.now ?? Date.now
    this.#timers = options.timers ?? browserTimers()
    this.#session = new SessionBootstrap(this.#client)
    this.#currentRead = new LatestRead((signal) =>
      this.#client.requestReadWithRetry('getCurrentCase', { signal }),
    )
  }

  get state(): GameControllerState {
    return this.#state
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener)
    listener(this.#state)
    return () => this.#listeners.delete(listener)
  }

  attachLifecycle(
    focusTarget: FocusTarget,
    visibilityTarget: VisibilityTarget,
  ): () => void {
    this.detachLifecycle()
    this.#focusTarget = focusTarget
    this.#visibilityTarget = visibilityTarget
    focusTarget.addEventListener('focus', this.#onFocus)
    visibilityTarget.addEventListener(
      'visibilitychange',
      this.#onVisibilityChange,
    )
    return () => this.detachLifecycle()
  }

  detachLifecycle(): void {
    this.#focusTarget?.removeEventListener('focus', this.#onFocus)
    this.#visibilityTarget?.removeEventListener(
      'visibilitychange',
      this.#onVisibilityChange,
    )
    this.#focusTarget = undefined
    this.#visibilityTarget = undefined
  }

  dispose(): void {
    this.detachLifecycle()
    this.#sessionAbort?.abort()
    this.#sessionAbort = undefined
    this.#sessionReady = false
    this.#cancelReads()
    this.#clearRolloverTimer()
    this.#listeners.clear()
  }

  async initialize(createNewSession = false): Promise<void> {
    const generation = ++this.#hydrateGeneration
    this.#sessionAbort?.abort()
    const sessionAbort = new AbortController()
    this.#sessionAbort = sessionAbort
    this.#sessionReady = false
    this.#cancelReads()
    this.#clearRolloverTimer()
    this.#setState({
      ...(createNewSession
        ? { currentCase: undefined, displayedAttempt: undefined }
        : {}),
      status: 'HYDRATING',
      mutationStatus: 'IDLE',
      error: undefined,
    })

    try {
      if (createNewSession) this.#pendingStore.clear()
      const pendingBeforeSession = createNewSession
        ? null
        : this.#pendingStore.load()
      const result = createNewSession
        ? await this.#session.createNewSession(sessionAbort.signal)
        : pendingBeforeSession === null
          ? await this.#session.initialize(sessionAbort.signal)
          : {
              created: false,
              session: await this.#client.requestReadWithRetry('getSession', {
                signal: sessionAbort.signal,
              }),
            }
      if (generation !== this.#hydrateGeneration) return
      this.#sessionReady = true
      const pending = this.#pendingStore.load()
      this.#setState({
        sessionExpiresAt: result.session.data.expiresAt,
        pendingOperation:
          pending === null ? undefined : summarizePendingOperation(pending),
        mutationStatus: pending === null ? 'IDLE' : 'UNCERTAIN',
      })
      await this.refreshCurrentCase(true)
    } catch (error) {
      if (generation !== this.#hydrateGeneration || isCancellation(error))
        return
      this.#handleReadFailure(error)
    } finally {
      if (this.#sessionAbort === sessionAbort) this.#sessionAbort = undefined
    }
  }

  async refreshCurrentCase(replace = false): Promise<void> {
    if (!this.#sessionReady || this.#state.status === 'SESSION_LOST') return
    try {
      const result = await this.#currentRead.run(replace)
      if (!result.accepted) return
      const projection = result.value.data
      this.#setState({
        currentCase: projection,
        status: 'READY',
        error: undefined,
      })
      this.#scheduleRollover(projection)
      if (projection.view === 'ATTEMPT') {
        await this.#refreshOwnedAttempt(projection.attemptId, true)
      } else if (projection.view === 'NO_CASE') {
        this.#cancelOwnedReads()
      }
    } catch (error) {
      if (isCancellation(error)) return
      this.#handleReadFailure(error)
    }
  }

  async startAttempt(): Promise<void> {
    const current = this.#state.currentCase
    if (current?.view !== 'NOT_STARTED') {
      throw new InvalidControllerActionError()
    }
    const operation = createStartPendingOperation({
      idempotencyKey: createIdempotencyKey(this.#randomUuid),
      createdAt: this.#now(),
      targetSlotId: current.slotId,
      targetClosesAt: current.closesAt,
    })
    await this.#runNewMutation(operation)
  }

  async submitCommand(body: GameplayCommandRequest): Promise<void> {
    const attempt = this.#state.displayedAttempt
    if (attempt === undefined || attempt.state !== 'ACTIVE') {
      throw new InvalidControllerActionError()
    }
    if (body.expectedVersion !== attempt.version) {
      throw new InvalidControllerActionError()
    }
    const operation = createCommandPendingOperation({
      attemptId: attempt.attemptId,
      body,
      idempotencyKey: createIdempotencyKey(this.#randomUuid),
      createdAt: this.#now(),
    })
    await this.#runNewMutation(operation)
  }

  async replayPendingOperation(): Promise<void> {
    if (this.#mutationInFlight || this.#recoveryInProgress) {
      throw new PendingOperationExistsError()
    }
    this.#recoveryInProgress = true
    try {
      let pending = this.#pendingStore.load()
      if (pending === null) throw new InvalidControllerActionError()
      if (pending.kind === 'START_ATTEMPT') {
        const reconciliation = await this.#reconcilePending(pending)
        if (reconciliation.status === 'RESOLVED') return
        pending = this.#pendingStore.load()
        const current = this.#state.currentCase
        if (
          pending?.kind !== 'START_ATTEMPT' ||
          current?.view !== 'NOT_STARTED' ||
          current.slotId !== pending.targetSlotId ||
          current.closesAt !== pending.targetClosesAt ||
          this.#state.status !== 'READY'
        ) {
          throw new InvalidControllerActionError()
        }
      }
      await this.#executeMutation(pending)
    } finally {
      this.#recoveryInProgress = false
    }
  }

  async reconcilePendingOperation(): Promise<ReconciliationResult> {
    if (this.#mutationInFlight || this.#recoveryInProgress) {
      throw new PendingOperationExistsError()
    }
    this.#recoveryInProgress = true
    try {
      const pending = this.#pendingStore.load()
      if (pending === null) return { status: 'NO_PENDING' }
      return await this.#reconcilePending(pending)
    } finally {
      this.#recoveryInProgress = false
    }
  }

  async #reconcilePending(
    pending: PendingOperation,
  ): Promise<ReconciliationResult> {
    if (pending.kind === 'START_ATTEMPT') {
      await this.refreshCurrentCase(true)
      if (this.#state.status === 'SESSION_LOST') return { status: 'UNRESOLVED' }
      const current = this.#state.currentCase
      const sameRevision =
        current?.view === 'ATTEMPT' &&
        current.closesAt === pending.targetClosesAt
      const targetPassed =
        current?.view === 'NO_CASE' ||
        (current?.view === 'NOT_STARTED' &&
          current.slotId !== pending.targetSlotId) ||
        (current?.view === 'ATTEMPT' &&
          current.closesAt !== pending.targetClosesAt)
      if (sameRevision || targetPassed) {
        this.#clearPending('IDLE')
        return { status: 'RESOLVED' }
      }
      this.#setState({ mutationStatus: 'UNCERTAIN' })
      return { status: 'UNRESOLVED' }
    }

    const attemptId = pendingAttemptId(pending)
    const attempt = await this.#refreshOwnedAttempt(attemptId, true)
    if (this.#state.status === 'SESSION_LOST') {
      return { status: 'UNRESOLVED' }
    }
    if (attempt !== undefined && commandOutcomeIsProven(pending, attempt)) {
      this.#clearPending('IDLE')
      return { status: 'RESOLVED' }
    }
    this.#setState({ mutationStatus: 'UNCERTAIN' })
    return { status: 'UNRESOLVED' }
  }

  async #runNewMutation(operation: PendingOperation): Promise<void> {
    if (
      this.#mutationInFlight ||
      this.#recoveryInProgress ||
      this.#pendingStore.load() !== null
    ) {
      throw new PendingOperationExistsError()
    }
    this.#pendingStore.save(operation)
    this.#setState({
      pendingOperation: summarizePendingOperation(operation),
      mutationStatus: 'IN_FLIGHT',
      error: undefined,
    })
    await this.#executeMutation(operation)
  }

  async #executeMutation(operation: PendingOperation): Promise<void> {
    if (this.#mutationInFlight) throw new PendingOperationExistsError()
    this.#mutationInFlight = true
    this.#setState({
      pendingOperation: summarizePendingOperation(operation),
      mutationStatus: 'IN_FLIGHT',
      error: undefined,
    })
    try {
      const attempt =
        operation.kind === 'START_ATTEMPT'
          ? (
              await this.#client.request('startCurrentAttempt', {
                body: operation.body,
                idempotencyKey: operation.idempotencyKey,
              })
            ).data.attempt
          : (
              await this.#client.request('runGameplayCommand', {
                path: { attemptId: pendingAttemptId(operation) },
                body: operation.body,
                idempotencyKey: operation.idempotencyKey,
              })
            ).data.attempt
      this.#pendingStore.clear()
      if (operation.kind === 'START_ATTEMPT') {
        this.#setState({ currentCase: attempt })
      }
      this.#applyAttempt(attempt)
      this.#setState({
        pendingOperation: undefined,
        mutationStatus: 'IDLE',
        status: 'READY',
      })
    } catch (error) {
      await this.#handleMutationFailure(operation, error)
      throw error
    } finally {
      this.#mutationInFlight = false
    }
  }

  async #handleMutationFailure(
    operation: PendingOperation,
    error: unknown,
  ): Promise<void> {
    if (isAuthenticationLoss(error)) {
      this.#handleSessionLoss(error)
      return
    }
    if (!(error instanceof ApiClientError)) {
      this.#setState({ mutationStatus: 'UNCERTAIN' })
      return
    }

    const operationId =
      operation.kind === 'START_ATTEMPT'
        ? 'startCurrentAttempt'
        : 'runGameplayCommand'
    const directive = retryDirective(operationId, error)
    if (directive.kind === 'REPLAY_EXACT_MUTATION') {
      this.#setState({
        mutationStatus: 'UNCERTAIN',
        error,
        pendingOperation: summarizePendingOperation(operation),
      })
      return
    }

    this.#pendingStore.clear()
    this.#setState({ pendingOperation: undefined, error })
    if (
      operation.kind === 'GAMEPLAY_COMMAND' &&
      error.apiCode === 'STALE_VERSION'
    ) {
      await this.#refreshOwnedAttempt(pendingAttemptId(operation), true)
      if (this.#state.status === 'SESSION_LOST') return
      this.#setState({ mutationStatus: 'STALE' })
      return
    }
    this.#setState({ mutationStatus: 'IDLE' })
    if (error.apiCode === 'NO_CURRENT_CASE') {
      await this.refreshCurrentCase(true)
    } else if (
      operation.kind === 'GAMEPLAY_COMMAND' &&
      (error.apiCode === 'TERMINAL_ATTEMPT' ||
        error.apiCode === 'EVIDENCE_LIMIT')
    ) {
      await this.#refreshOwnedAttempt(pendingAttemptId(operation), true)
    }
  }

  async #refreshOwnedAttempt(
    attemptId: string,
    replace: boolean,
  ): Promise<AttemptProjection | undefined> {
    let query = this.#ownedReads.get(attemptId)
    if (query === undefined) {
      query = new LatestRead((signal) =>
        this.#client.requestReadWithRetry('getOwnedAttempt', {
          path: { attemptId },
          signal,
        }),
      )
      this.#ownedReads.set(attemptId, query)
    }
    try {
      const result = await query.run(replace)
      if (!result.accepted) return undefined
      this.#applyAttempt(result.value.data)
      return result.value.data
    } catch (error) {
      if (isCancellation(error)) return undefined
      this.#handleReadFailure(error)
      return undefined
    }
  }

  #applyAttempt(attempt: AttemptProjection): void {
    const current = this.#state.currentCase
    this.#setState({
      displayedAttempt: attempt,
      ...(current?.view === 'ATTEMPT' && current.attemptId === attempt.attemptId
        ? { currentCase: attempt }
        : {}),
    })
    if (attempt.state !== 'ACTIVE') this.#cancelOwnedReads(attempt.attemptId)
  }

  #handleReadFailure(error: unknown): void {
    if (isAuthenticationLoss(error)) {
      this.#handleSessionLoss(error)
      return
    }
    const safeError =
      error instanceof ApiClientError ||
      error instanceof PendingOperationStorageError
        ? error
        : new ApiClientError('NETWORK_ERROR')
    this.#setState({ status: 'READ_ERROR', error: safeError })
  }

  #handleSessionLoss(error: ApiClientError): void {
    this.#hydrateGeneration += 1
    this.#sessionAbort?.abort()
    this.#sessionAbort = undefined
    this.#sessionReady = false
    this.#cancelReads()
    this.#clearRolloverTimer()
    try {
      this.#pendingStore.clear()
    } catch {
      // The session is already unusable; state still fails closed.
    }
    this.#setState({
      status: 'SESSION_LOST',
      mutationStatus: 'IDLE',
      pendingOperation: undefined,
      error,
      sessionExpiresAt: undefined,
    })
  }

  #clearPending(mutationStatus: MutationStatus): void {
    this.#pendingStore.clear()
    this.#setState({ pendingOperation: undefined, mutationStatus })
  }

  #setState(patch: Partial<GameControllerState>): void {
    this.#state = { ...this.#state, ...patch }
    for (const listener of this.#listeners) listener(this.#state)
  }

  #scheduleRollover(projection: CaseProjection): void {
    this.#clearRolloverTimer()
    const close = closesAt(projection)
    if (close === undefined || close === this.#rolloverClosesAt) return
    const closeTime = Date.parse(close)
    if (!Number.isFinite(closeTime)) return
    const delay = Math.max(
      0,
      Math.min(closeTime - this.#now(), MAXIMUM_TIMER_DELAY),
    )
    this.#rolloverTimer = this.#timers.setTimeout(() => {
      this.#rolloverTimer = undefined
      this.#rolloverClosesAt = close
      void this.refreshCurrentCase(true)
    }, delay)
  }

  #clearRolloverTimer(): void {
    if (this.#rolloverTimer !== undefined) {
      this.#timers.clearTimeout(this.#rolloverTimer)
      this.#rolloverTimer = undefined
    }
  }

  #cancelOwnedReads(exceptAttemptId?: string): void {
    for (const [attemptId, query] of this.#ownedReads) {
      if (attemptId === exceptAttemptId) continue
      query.cancel()
      this.#ownedReads.delete(attemptId)
    }
  }

  #cancelReads(): void {
    this.#currentRead.cancel()
    this.#cancelOwnedReads()
  }
}
