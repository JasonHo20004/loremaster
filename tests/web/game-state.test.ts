import type { GameplayCommandRequest } from '../../packages/contracts/src/index.js'
import { describe, expect, it, vi } from 'vitest'

import { ApiClient } from '../../apps/web/src/api/client.js'
import {
  createCommandPendingOperation,
  createStartPendingOperation,
  PENDING_OPERATION_STORAGE_KEY,
  PendingOperationStore,
  type PendingStorage,
} from '../../apps/web/src/api/pending-operation.js'
import {
  GameController,
  PendingOperationExistsError,
  type AttemptProjection,
  type CaseProjection,
} from '../../apps/web/src/state/controller.js'
import { LatestRead } from '../../apps/web/src/state/latest-read.js'

const API_BASE_URL = new URL('http://localhost:5173/api/v1')
const BROWSER_ORIGIN = 'http://localhost:5173'
const CSRF_TOKEN = 'A'.repeat(43)
const REQUEST_ID = '00000000-0000-4000-8000-000000000099'
const ATTEMPT_ID = '00000000-0000-4000-8000-000000000001'
const FIRST_KEY = '10000000-0000-4000-8000-000000000001'
const SECOND_KEY = '20000000-0000-4000-8000-000000000002'
const SESSION_RESPONSE = {
  data: { expiresAt: '2030-01-02T00:00:00.000Z' },
} as const

class MemoryStorage implements PendingStorage {
  readonly values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

class WriteFailingStorage extends MemoryStorage {
  override setItem(): void {
    throw new DOMException('quota exceeded', 'QuotaExceededError')
  }
}

interface FetchStep {
  readonly assert?: (url: URL, init: RequestInit) => void
  readonly error?: Error
  readonly response?: Response
}

function scriptedFetch(steps: FetchStep[]): typeof fetch {
  return vi.fn<typeof fetch>(async (input, init) => {
    const step = steps.shift()
    if (step === undefined)
      throw new Error(`Unexpected request: ${String(input)}`)
    step.assert?.(new URL(String(input)), init ?? {})
    if (step.error !== undefined) throw step.error
    if (step.response === undefined)
      throw new Error('Missing scripted response')
    return step.response
  })
}

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status })
}

function apiError(code: string, status: number): Response {
  return jsonResponse({ error: { code, requestId: REQUEST_ID } }, status)
}

function sessionStep(): FetchStep {
  return {
    assert: (url, init) => {
      expect(url.pathname).toBe('/api/v1/session')
      expect(init.method).toBe('GET')
    },
    response: jsonResponse(SESSION_RESPONSE),
  }
}

const SUGGESTIONS = [
  {
    entityId: 'harbor-master',
    canonicalName: 'Harbor Master',
    publicRole: 'Keeper of tides',
    aliases: ['Master'],
  },
  {
    entityId: 'night-clerk',
    canonicalName: 'Night Clerk',
    publicRole: 'Keeper of ledgers',
    aliases: ['Clerk'],
  },
] as const

function activeAttempt(
  version = 1,
  evidenceLevel: 0 | 1 | 2 | 3 | 4 = 0,
  closesAt = '2030-01-01T00:00:00.000Z',
): AttemptProjection {
  const evidence = [
    { level: 1 as const, text: 'First public clue' },
    { level: 2 as const, text: 'Second public clue' },
    { level: 3 as const, text: 'Third public clue' },
    { level: 4 as const, text: 'Fourth public clue' },
  ].slice(0, evidenceLevel)
  return {
    view: 'ATTEMPT',
    attemptId: ATTEMPT_ID,
    state: 'ACTIVE',
    version,
    startedAt: '2029-12-31T00:00:00.000Z',
    closesAt,
    evidenceLevel,
    wrongGuessesAtLevel: 0,
    totalWrongGuesses: 0,
    briefing: 'A public briefing.',
    suggestions: SUGGESTIONS,
    guessHistory: [],
    evidence,
  } as AttemptProjection
}

function solvedAttempt(version = 2): AttemptProjection {
  return {
    ...activeAttempt(version),
    state: 'SOLVED',
    answer: SUGGESTIONS[0],
    evidence: [1, 2, 3, 4].map((level) => ({
      level,
      text: `Public clue ${level}`,
      explanation: `Public explanation ${level}`,
      sourceReferences: [`Reference ${level}`],
    })),
  } as AttemptProjection
}

function currentCaseStep(projection: CaseProjection): FetchStep {
  return {
    assert: (url, init) => {
      expect(url.pathname).toBe('/api/v1/cases/current')
      expect(init.method).toBe('GET')
    },
    response: jsonResponse({ data: projection }),
  }
}

function ownedAttemptStep(projection: AttemptProjection): FetchStep {
  return {
    assert: (url, init) => {
      expect(url.pathname).toBe(`/api/v1/attempts/${ATTEMPT_ID}`)
      expect(init.method).toBe('GET')
    },
    response: jsonResponse({ data: projection }),
  }
}

function commandSuccessStep(
  projection: AttemptProjection,
  expectedKey: string,
  expectedBody: GameplayCommandRequest,
): FetchStep {
  return {
    assert: (url, init) => {
      expect(url.pathname).toBe(`/api/v1/attempts/${ATTEMPT_ID}/commands`)
      const headers = new Headers(init.headers)
      expect(headers.get('Idempotency-Key')).toBe(expectedKey)
      expect(JSON.parse(String(init.body))).toEqual(expectedBody)
    },
    response: jsonResponse({
      data: {
        outcomeCode: 'REVEALED',
        replayed: false,
        attempt: projection,
      },
    }),
  }
}

function createController(input: {
  readonly fetchImplementation: typeof fetch
  readonly randomKeys?: readonly string[]
  readonly storage?: MemoryStorage
  readonly timers?: {
    clearTimeout(handle: number): void
    setTimeout(callback: () => void, milliseconds: number): number
  }
}): { readonly controller: GameController; readonly storage: MemoryStorage } {
  const storage = input.storage ?? new MemoryStorage()
  const keys = [...(input.randomKeys ?? [FIRST_KEY])]
  const client = new ApiClient({
    apiBaseUrl: API_BASE_URL,
    browserOrigin: BROWSER_ORIGIN,
    cookieSource: () => `loremaster_local_csrf=${CSRF_TOKEN}`,
    fetchImplementation: input.fetchImplementation,
    sleep: async () => undefined,
  })
  return {
    storage,
    controller: new GameController({
      client,
      pendingStore: new PendingOperationStore(storage),
      randomUuid: () => keys.shift() ?? SECOND_KEY,
      now: () => Date.parse('2029-12-31T12:00:00.000Z'),
      timers: input.timers,
    }),
  }
}

describe('latest read coordination', () => {
  it('deduplicates equal reads and accepts only the newest replacement', async () => {
    const resolvers: Array<(value: number) => void> = []
    const read = new LatestRead<number>(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve)
        }),
    )

    const first = read.run()
    expect(read.run()).toBe(first)
    const replacement = read.run(true)
    resolvers[1]?.(2)
    await expect(replacement).resolves.toEqual({ accepted: true, value: 2 })
    resolvers[0]?.(1)
    await expect(first).resolves.toEqual({ accepted: false, value: 1 })
  })
})

describe('pending operation storage', () => {
  it('persists one bounded command intent without cookies or response content', () => {
    const storage = new MemoryStorage()
    const store = new PendingOperationStore(storage)
    const body: GameplayCommandRequest = {
      expectedVersion: 1,
      command: { kind: 'REVEAL' },
    }
    store.save(
      createCommandPendingOperation({
        attemptId: ATTEMPT_ID,
        body,
        idempotencyKey: FIRST_KEY,
        createdAt: 100,
      }),
    )

    expect(store.load()).toMatchObject({
      kind: 'GAMEPLAY_COMMAND',
      body,
      idempotencyKey: FIRST_KEY,
      createdAt: 100,
    })
    const serialized = storage.values.get(PENDING_OPERATION_STORAGE_KEY) ?? ''
    expect(serialized.length).toBeLessThanOrEqual(2_048)
    expect(serialized).not.toContain(CSRF_TOKEN)
    expect(serialized).not.toContain('briefing')
    expect(serialized).not.toContain('response')
  })

  it('clears malformed or oversized client-owned records', () => {
    const storage = new MemoryStorage()
    const store = new PendingOperationStore(storage)
    storage.setItem(PENDING_OPERATION_STORAGE_KEY, '{"unexpected":true}')
    expect(store.load()).toBeNull()
    expect(storage.getItem(PENDING_OPERATION_STORAGE_KEY)).toBeNull()

    storage.setItem(PENDING_OPERATION_STORAGE_KEY, 'x'.repeat(2_049))
    expect(store.load()).toBeNull()
    expect(storage.getItem(PENDING_OPERATION_STORAGE_KEY)).toBeNull()
  })
})

describe('game controller hydration and recovery', () => {
  it('hydrates session and current case without implicitly starting an attempt', async () => {
    const fetchImplementation = scriptedFetch([
      sessionStep(),
      currentCaseStep({
        view: 'NOT_STARTED',
        slotId: '2029-12-31',
        opensAt: '2029-12-31T00:00:00.000Z',
        closesAt: '2030-01-01T00:00:00.000Z',
      }),
    ])
    const { controller } = createController({ fetchImplementation })

    await controller.initialize()

    expect(controller.state).toMatchObject({
      status: 'READY',
      mutationStatus: 'IDLE',
      currentCase: { view: 'NOT_STARTED', slotId: '2029-12-31' },
    })
    expect(fetchImplementation).toHaveBeenCalledTimes(2)
  })

  it('never sends a mutation when its recovery record cannot be persisted', async () => {
    const fetchImplementation = scriptedFetch([
      sessionStep(),
      currentCaseStep({
        view: 'NOT_STARTED',
        slotId: '2029-12-31',
        opensAt: '2029-12-31T00:00:00.000Z',
        closesAt: '2030-01-01T00:00:00.000Z',
      }),
    ])
    const { controller } = createController({
      fetchImplementation,
      storage: new WriteFailingStorage(),
    })
    await controller.initialize()

    await expect(controller.startAttempt()).rejects.toMatchObject({
      name: 'PendingOperationStorageError',
    })
    expect(fetchImplementation).toHaveBeenCalledTimes(2)
  })

  it('reconstructs an active attempt from the API and pending intent on reload', async () => {
    const storage = new MemoryStorage()
    new PendingOperationStore(storage).save(
      createCommandPendingOperation({
        attemptId: ATTEMPT_ID,
        body: { expectedVersion: 1, command: { kind: 'REVEAL' } },
        idempotencyKey: FIRST_KEY,
        createdAt: 100,
      }),
    )
    const projection = activeAttempt()
    const fetchImplementation = scriptedFetch([
      sessionStep(),
      currentCaseStep(projection),
      ownedAttemptStep(projection),
    ])
    const { controller } = createController({ fetchImplementation, storage })

    await controller.initialize()

    expect(controller.state.displayedAttempt).toEqual(projection)
    expect(controller.state.pendingOperation).toEqual({
      kind: 'GAMEPLAY_COMMAND',
      createdAt: 100,
    })
    expect(controller.state.mutationStatus).toBe('UNCERTAIN')
  })

  it('does not replace an expired session automatically when an intent is pending', async () => {
    const storage = new MemoryStorage()
    new PendingOperationStore(storage).save(
      createCommandPendingOperation({
        attemptId: ATTEMPT_ID,
        body: { expectedVersion: 1, command: { kind: 'REVEAL' } },
        idempotencyKey: FIRST_KEY,
        createdAt: 100,
      }),
    )
    const fetchImplementation = scriptedFetch([
      {
        assert: (_url, init) => expect(init.method).toBe('GET'),
        response: apiError('AUTHENTICATION_REQUIRED', 401),
      },
    ])
    const { controller } = createController({ fetchImplementation, storage })

    await controller.initialize()

    expect(controller.state.status).toBe('SESSION_LOST')
    expect(storage.getItem(PENDING_OPERATION_STORAGE_KEY)).toBeNull()
    expect(fetchImplementation).toHaveBeenCalledTimes(1)
  })

  it('clears an old intent before an explicit replacement session', async () => {
    const storage = new MemoryStorage()
    new PendingOperationStore(storage).save(
      createStartPendingOperation({
        idempotencyKey: FIRST_KEY,
        createdAt: 100,
        targetSlotId: '2029-12-31',
        targetClosesAt: '2030-01-01T00:00:00.000Z',
      }),
    )
    const fetchImplementation = scriptedFetch([
      {
        assert: (_url, init) => {
          expect(init.method).toBe('POST')
          expect(init.body).toBe('{}')
        },
        response: jsonResponse(SESSION_RESPONSE, 201),
      },
      currentCaseStep({ view: 'NO_CASE' }),
    ])
    const { controller } = createController({ fetchImplementation, storage })

    await controller.initialize(true)

    expect(controller.state.status).toBe('READY')
    expect(controller.state.pendingOperation).toBeUndefined()
    expect(storage.getItem(PENDING_OPERATION_STORAGE_KEY)).toBeNull()
  })

  it('retains the exact key and body after timeout and on replay', async () => {
    const initial = activeAttempt()
    const revealed = activeAttempt(2, 1)
    const body: GameplayCommandRequest = {
      expectedVersion: 1,
      command: { kind: 'REVEAL' },
    }
    const fetchImplementation = scriptedFetch([
      sessionStep(),
      currentCaseStep(initial),
      ownedAttemptStep(initial),
      {
        assert: (_url, init) => {
          expect(new Headers(init.headers).get('Idempotency-Key')).toBe(
            FIRST_KEY,
          )
          expect(JSON.parse(String(init.body))).toEqual(body)
        },
        error: new Error('response lost'),
      },
      commandSuccessStep(revealed, FIRST_KEY, body),
    ])
    const { controller, storage } = createController({ fetchImplementation })
    await controller.initialize()

    await expect(controller.submitCommand(body)).rejects.toMatchObject({
      kind: 'NETWORK_ERROR',
    })
    expect(controller.state.mutationStatus).toBe('UNCERTAIN')
    expect(storage.getItem(PENDING_OPERATION_STORAGE_KEY)).toContain(FIRST_KEY)

    await controller.replayPendingOperation()
    expect(controller.state).toMatchObject({
      mutationStatus: 'IDLE',
      pendingOperation: undefined,
      displayedAttempt: { version: 2, evidenceLevel: 1 },
    })
    expect(storage.getItem(PENDING_OPERATION_STORAGE_KEY)).toBeNull()
  })

  it('blocks a second mutation while one unresolved intention is pending', async () => {
    const initial = activeAttempt()
    const fetchImplementation = scriptedFetch([
      sessionStep(),
      currentCaseStep(initial),
      ownedAttemptStep(initial),
      { error: new Error('uncertain') },
    ])
    const { controller } = createController({ fetchImplementation })
    await controller.initialize()
    const body: GameplayCommandRequest = {
      expectedVersion: 1,
      command: { kind: 'REVEAL' },
    }
    await controller.submitCommand(body).catch(() => undefined)

    await expect(controller.submitCommand(body)).rejects.toBeInstanceOf(
      PendingOperationExistsError,
    )
  })

  it('refreshes stale state, clears the rejected intent, and requires a new key', async () => {
    const first = activeAttempt()
    const refreshed = activeAttempt(2, 1)
    const accepted = activeAttempt(3, 2)
    const firstBody: GameplayCommandRequest = {
      expectedVersion: 1,
      command: { kind: 'REVEAL' },
    }
    const secondBody: GameplayCommandRequest = {
      expectedVersion: 2,
      command: { kind: 'REVEAL' },
    }
    const fetchImplementation = scriptedFetch([
      sessionStep(),
      currentCaseStep(first),
      ownedAttemptStep(first),
      {
        assert: (_url, init) =>
          expect(new Headers(init.headers).get('Idempotency-Key')).toBe(
            FIRST_KEY,
          ),
        response: apiError('STALE_VERSION', 409),
      },
      ownedAttemptStep(refreshed),
      commandSuccessStep(accepted, SECOND_KEY, secondBody),
    ])
    const { controller, storage } = createController({
      fetchImplementation,
      randomKeys: [FIRST_KEY, SECOND_KEY],
    })
    await controller.initialize()

    await expect(controller.submitCommand(firstBody)).rejects.toMatchObject({
      apiCode: 'STALE_VERSION',
    })
    expect(controller.state).toMatchObject({
      mutationStatus: 'STALE',
      displayedAttempt: { version: 2 },
    })
    expect(storage.getItem(PENDING_OPERATION_STORAGE_KEY)).toBeNull()

    await controller.submitCommand(secondBody)
    expect(controller.state.displayedAttempt?.version).toBe(3)
  })

  it('reconciles a terminal version advance without replaying the command', async () => {
    const storage = new MemoryStorage()
    new PendingOperationStore(storage).save(
      createCommandPendingOperation({
        attemptId: ATTEMPT_ID,
        body: {
          expectedVersion: 1,
          command: { kind: 'GUESS', entityId: 'harbor-master' },
        },
        idempotencyKey: FIRST_KEY,
        createdAt: 100,
      }),
    )
    const terminal = solvedAttempt(2)
    const fetchImplementation = scriptedFetch([ownedAttemptStep(terminal)])
    const { controller } = createController({ fetchImplementation, storage })

    await expect(controller.reconcilePendingOperation()).resolves.toEqual({
      status: 'RESOLVED',
    })
    expect(controller.state.displayedAttempt).toEqual(terminal)
    expect(storage.getItem(PENDING_OPERATION_STORAGE_KEY)).toBeNull()
    expect(fetchImplementation).toHaveBeenCalledTimes(1)
  })

  it('keeps a command pending when a non-terminal version advance does not prove its outcome', async () => {
    const storage = new MemoryStorage()
    new PendingOperationStore(storage).save(
      createCommandPendingOperation({
        attemptId: ATTEMPT_ID,
        body: { expectedVersion: 1, command: { kind: 'REVEAL' } },
        idempotencyKey: FIRST_KEY,
        createdAt: 100,
      }),
    )
    const fetchImplementation = scriptedFetch([
      ownedAttemptStep(activeAttempt(2, 1)),
    ])
    const { controller } = createController({ fetchImplementation, storage })

    await expect(controller.reconcilePendingOperation()).resolves.toEqual({
      status: 'UNRESOLVED',
    })
    expect(storage.getItem(PENDING_OPERATION_STORAGE_KEY)).toContain(FIRST_KEY)
    expect(controller.state.mutationStatus).toBe('UNCERTAIN')
  })

  it('clears only client-owned pending state when the session expires', async () => {
    const initial = activeAttempt()
    const fetchImplementation = scriptedFetch([
      sessionStep(),
      currentCaseStep(initial),
      ownedAttemptStep(initial),
      { response: apiError('AUTHENTICATION_REQUIRED', 401) },
    ])
    const { controller, storage } = createController({ fetchImplementation })
    await controller.initialize()

    await controller
      .submitCommand({ expectedVersion: 1, command: { kind: 'REVEAL' } })
      .catch(() => undefined)

    expect(controller.state).toMatchObject({
      status: 'SESSION_LOST',
      mutationStatus: 'IDLE',
      pendingOperation: undefined,
      displayedAttempt: { attemptId: ATTEMPT_ID },
    })
    expect(storage.getItem(PENDING_OPERATION_STORAGE_KEY)).toBeNull()
  })
})

describe('refresh and UTC rollover', () => {
  it('refreshes on focus and visible-state recovery', async () => {
    const initial: CaseProjection = { view: 'NO_CASE' }
    const next: CaseProjection = {
      view: 'NOT_STARTED',
      slotId: '2030-01-01',
      opensAt: '2030-01-01T00:00:00.000Z',
      closesAt: '2030-01-02T00:00:00.000Z',
    }
    const fetchImplementation = scriptedFetch([
      sessionStep(),
      currentCaseStep(initial),
      currentCaseStep(next),
      currentCaseStep(next),
    ])
    const { controller } = createController({ fetchImplementation })
    await controller.initialize()

    const focus = new EventTarget()
    const visibility = new EventTarget() as EventTarget & {
      visibilityState: string
    }
    visibility.visibilityState = 'visible'
    controller.attachLifecycle(focus, visibility)
    focus.dispatchEvent(new Event('focus'))
    await vi.waitFor(() => expect(controller.state.currentCase).toEqual(next))
    visibility.dispatchEvent(new Event('visibilitychange'))
    await vi.waitFor(() => expect(fetchImplementation).toHaveBeenCalledTimes(4))
  })

  it('moves Current Case to the next slot while preserving the old attempt', async () => {
    const callbacks = new Map<number, () => void>()
    let nextHandle = 1
    const timers = {
      setTimeout: vi.fn((callback: () => void) => {
        const handle = nextHandle++
        callbacks.set(handle, callback)
        return handle
      }),
      clearTimeout: vi.fn((handle: number) => callbacks.delete(handle)),
    }
    const oldAttempt = activeAttempt()
    const newSlot: CaseProjection = {
      view: 'NOT_STARTED',
      slotId: '2030-01-01',
      opensAt: '2030-01-01T00:00:00.000Z',
      closesAt: '2030-01-02T00:00:00.000Z',
    }
    const fetchImplementation = scriptedFetch([
      sessionStep(),
      currentCaseStep(oldAttempt),
      ownedAttemptStep(oldAttempt),
      currentCaseStep(newSlot),
    ])
    const { controller } = createController({ fetchImplementation, timers })
    await controller.initialize()
    expect(timers.setTimeout).toHaveBeenCalledWith(
      expect.any(Function),
      43_200_000,
    )

    callbacks.get(1)?.()
    await vi.waitFor(() =>
      expect(controller.state.currentCase).toEqual(newSlot),
    )

    expect(controller.state.displayedAttempt).toEqual(oldAttempt)
    expect(timers.setTimeout).toHaveBeenLastCalledWith(
      expect.any(Function),
      129_600_000,
    )
  })

  it('does not replay an unresolved start after its target slot has changed', async () => {
    const storage = new MemoryStorage()
    new PendingOperationStore(storage).save(
      createStartPendingOperation({
        idempotencyKey: FIRST_KEY,
        createdAt: 100,
        targetSlotId: '2029-12-31',
        targetClosesAt: '2030-01-01T00:00:00.000Z',
      }),
    )
    const newSlot: CaseProjection = {
      view: 'NOT_STARTED',
      slotId: '2030-01-01',
      opensAt: '2030-01-01T00:00:00.000Z',
      closesAt: '2030-01-02T00:00:00.000Z',
    }
    const fetchImplementation = scriptedFetch([
      sessionStep(),
      currentCaseStep(newSlot),
      currentCaseStep(newSlot),
    ])
    const { controller } = createController({ fetchImplementation, storage })

    await controller.initialize()
    await expect(controller.replayPendingOperation()).resolves.toBeUndefined()
    expect(storage.getItem(PENDING_OPERATION_STORAGE_KEY)).toBeNull()
    expect(fetchImplementation).toHaveBeenCalledTimes(3)
  })

  it('replays a start with the same key only while its target slot is current', async () => {
    const storage = new MemoryStorage()
    new PendingOperationStore(storage).save(
      createStartPendingOperation({
        idempotencyKey: FIRST_KEY,
        createdAt: 100,
        targetSlotId: '2029-12-31',
        targetClosesAt: '2030-01-01T00:00:00.000Z',
      }),
    )
    const notStarted: CaseProjection = {
      view: 'NOT_STARTED',
      slotId: '2029-12-31',
      opensAt: '2029-12-31T00:00:00.000Z',
      closesAt: '2030-01-01T00:00:00.000Z',
    }
    const started = activeAttempt()
    const fetchImplementation = scriptedFetch([
      sessionStep(),
      currentCaseStep(notStarted),
      currentCaseStep(notStarted),
      {
        assert: (_url, init) => {
          expect(init.method).toBe('POST')
          expect(new Headers(init.headers).get('Idempotency-Key')).toBe(
            FIRST_KEY,
          )
          expect(init.body).toBe('{}')
        },
        response: jsonResponse({
          data: {
            outcomeCode: 'STARTED',
            replayed: true,
            attempt: started,
          },
        }),
      },
    ])
    const { controller } = createController({ fetchImplementation, storage })

    await controller.initialize()
    await controller.replayPendingOperation()

    expect(controller.state.currentCase).toEqual(started)
    expect(controller.state.displayedAttempt).toEqual(started)
    expect(storage.getItem(PENDING_OPERATION_STORAGE_KEY)).toBeNull()
  })
})
