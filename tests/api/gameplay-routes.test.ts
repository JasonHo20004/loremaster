import { describe, expect, it, vi } from 'vitest'

import type {
  GameplayRouteRepository,
  KernelHandlerContext,
} from '../../apps/api/src/index.js'
import {
  createGameplayHandlers,
  PublicHttpError,
} from '../../apps/api/src/index.js'

const identity = {
  expiresAt: new Date('2030-01-01T00:00:00.000Z'),
  guestId: '11111111-1111-4111-8111-111111111111',
  pseudonym: 'Guest-test',
  sessionId: '22222222-2222-4222-8222-222222222222',
}
const attemptId = '33333333-3333-4333-8333-333333333333'

function context(
  overrides: Partial<KernelHandlerContext> = {},
): KernelHandlerContext {
  const controller = new AbortController()
  return {
    body: {},
    clock: { now: () => 0 },
    deadline: { deadlineAt: 5_000, now: () => 0, signal: controller.signal },
    headers: {},
    identity,
    operationId: 'getCurrentCase',
    params: {},
    query: {},
    receivedAt: 0,
    repository: {},
    request: {} as KernelHandlerContext['request'],
    response: {} as KernelHandlerContext['response'],
    requestId: '44444444-4444-4444-8444-444444444444',
    ...overrides,
  }
}

function repository(
  overrides: Partial<GameplayRouteRepository> = {},
): GameplayRouteRepository {
  return {
    executeGameplayCommand: vi.fn(async () => ({
      ok: true,
      outcomeCode: 'REVEALED',
      replayed: false,
      projection: { view: 'ATTEMPT' } as never,
    })),
    readCurrentCase: vi.fn(async () => ({ view: 'NO_CASE' })),
    readOwnedAttempt: vi.fn(async () => ({ view: 'ATTEMPT' }) as never),
    startCurrentAttempt: vi.fn(async () => ({
      ok: true,
      outcomeCode: 'STARTED',
      replayed: false,
      projection: { view: 'ATTEMPT' } as never,
    })),
    ...overrides,
  }
}

async function rejectedCode(
  run: Promise<unknown>,
): Promise<string | undefined> {
  try {
    await run
    return undefined
  } catch (error) {
    expect(error).toBeInstanceOf(PublicHttpError)
    return (error as PublicHttpError).code
  }
}

describe('S5.4 gameplay route adapters', () => {
  it('passes only authenticated identity, validated path/body/header values, and deadline', async () => {
    const execute = vi.fn<GameplayRouteRepository['executeGameplayCommand']>(
      async () => ({
        ok: true,
        outcomeCode: 'WRONG',
        replayed: false,
        projection: { view: 'ATTEMPT' } as never,
      }),
    )
    const handlers = createGameplayHandlers(
      repository({ executeGameplayCommand: execute }),
    )
    const state = context({
      body: {
        expectedVersion: 7,
        command: { kind: 'GUESS', entityId: 'mira-vale' },
      },
      headers: { idempotencyKey: 'guess-7' },
      params: { attemptId },
      operationId: 'runGameplayCommand',
    })
    const response = await handlers.runGameplayCommand!(state)

    expect(execute).toHaveBeenCalledWith(
      {
        attemptId,
        guestId: identity.guestId,
        sessionId: identity.sessionId,
        idempotencyKey: 'guess-7',
        expectedVersion: 7,
        command: { kind: 'GUESS', entityId: 'mira-vale' },
      },
      state.deadline,
    )
    expect(response).toMatchObject({
      status: 200,
      body: { data: { outcomeCode: 'WRONG', replayed: false } },
    })
  })

  it('maps unknown and foreign attempt reads to the same response', async () => {
    const handlers = createGameplayHandlers(
      repository({ readOwnedAttempt: vi.fn(async () => undefined) }),
    )
    expect(
      await rejectedCode(
        Promise.resolve(
          handlers.getOwnedAttempt!(
            context({ params: { attemptId }, operationId: 'getOwnedAttempt' }),
          ),
        ),
      ),
    ).toBe('RESOURCE_NOT_FOUND')
  })

  it.each([
    ['NO_CASE', 'NO_CURRENT_CASE'],
    ['IDEMPOTENCY_CONFLICT', 'IDEMPOTENCY_CONFLICT'],
    ['SESSION_EXPIRED', 'AUTHENTICATION_REQUIRED'],
    ['INVALID_COMMAND', 'INVALID_REQUEST'],
  ] as const)('maps start rejection %s', async (repositoryCode, publicCode) => {
    const handlers = createGameplayHandlers(
      repository({
        startCurrentAttempt: vi.fn(async () => ({
          ok: false,
          code: repositoryCode,
        })),
      }),
    )
    expect(
      await rejectedCode(
        Promise.resolve(
          handlers.startCurrentAttempt!(
            context({
              headers: { idempotencyKey: 'start-1' },
              operationId: 'startCurrentAttempt',
            }),
          ),
        ),
      ),
    ).toBe(publicCode)
  })

  it.each([
    ['UNKNOWN_ATTEMPT', 'RESOURCE_NOT_FOUND'],
    ['UNKNOWN_ENTITY', 'INVALID_GUESS'],
    ['STALE_VERSION', 'STALE_VERSION'],
    ['EVIDENCE_LIMIT', 'EVIDENCE_LIMIT'],
    ['TERMINAL_ATTEMPT', 'TERMINAL_ATTEMPT'],
    ['IDEMPOTENCY_CONFLICT', 'IDEMPOTENCY_CONFLICT'],
    ['SESSION_EXPIRED', 'AUTHENTICATION_REQUIRED'],
    ['INVALID_COMMAND', 'INVALID_REQUEST'],
  ] as const)(
    'maps command rejection %s',
    async (repositoryCode, publicCode) => {
      const handlers = createGameplayHandlers(
        repository({
          executeGameplayCommand: vi.fn(async () => ({
            ok: false,
            code: repositoryCode,
          })),
        }),
      )
      expect(
        await rejectedCode(
          Promise.resolve(
            handlers.runGameplayCommand!(
              context({
                body: { expectedVersion: 0, command: { kind: 'REVEAL' } },
                headers: { idempotencyKey: 'reveal-0' },
                params: { attemptId },
                operationId: 'runGameplayCommand',
              }),
            ),
          ),
        ),
      ).toBe(publicCode)
    },
  )
})
