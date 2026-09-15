import { describe, expect, it, vi } from 'vitest'

import {
  createReportingHandlers,
  PublicHttpError,
  type KernelHandlerContext,
  type ReportingRouteRepository,
} from '../../apps/api/src/index.js'

const identity = {
  expiresAt: new Date('2030-01-01T00:00:00.000Z'),
  guestId: '11111111-1111-4111-8111-111111111111',
  pseudonym: 'Guest-test',
  sessionId: '22222222-2222-4222-8222-222222222222',
}
const slotId = '2026-09-15'
const firstPosition = {
  attemptId: '33333333-3333-4333-8333-333333333333',
  evidenceLevel: 1 as const,
  totalWrongGuesses: 0,
  elapsedMilliseconds: 42_000,
}
const keys = {
  active: { version: 'active', key: new Uint8Array(32).fill(0x11) },
  previous: { version: 'old', key: new Uint8Array(32).fill(0x22) },
}

function context(
  overrides: Partial<KernelHandlerContext> = {},
): KernelHandlerContext {
  const controller = new AbortController()
  return {
    body: undefined,
    clock: { now: () => 0 },
    deadline: { deadlineAt: 5_000, now: () => 0, signal: controller.signal },
    headers: undefined,
    identity,
    operationId: 'getLeaderboard',
    params: { slotId },
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
  overrides: Partial<ReportingRouteRepository> = {},
): ReportingRouteRepository {
  return {
    readAttemptSuggestions: vi.fn(async () => []),
    readDailyLeaderboardPage: vi.fn(async () => ({
      items: [],
      nextPosition: null,
    })),
    readProfile: vi.fn(async () => ({
      currentStreak: 0,
      longestStreak: 0,
      solvedCount: 0,
      failedCount: 0,
      accuracyPercentage: 0,
      regionalKnowledge: [],
    })),
    ...overrides,
  }
}

async function publicError(run: Promise<unknown>): Promise<PublicHttpError> {
  try {
    await run
  } catch (error) {
    expect(error).toBeInstanceOf(PublicHttpError)
    return error as PublicHttpError
  }
  throw new Error('expected public error')
}

describe('S5.5 reporting route adapters', () => {
  it('scopes suggestions to the authenticated guest and hides denied contexts', async () => {
    const read = vi.fn<ReportingRouteRepository['readAttemptSuggestions']>(
      async () => undefined,
    )
    const handler = createReportingHandlers(
      repository({ readAttemptSuggestions: read }),
      keys,
    ).getSuggestions!
    const state = context({
      operationId: 'getSuggestions',
      params: { attemptId: firstPosition.attemptId },
      query: { q: 'Mira' },
    })
    const error = await publicError(Promise.resolve(handler(state)))
    expect(error.code).toBe('RESOURCE_NOT_FOUND')
    expect(read).toHaveBeenCalledWith(
      identity.guestId,
      firstPosition.attemptId,
      'Mira',
      state.deadline,
    )
  })

  it('returns the reconciled profile projection unchanged', async () => {
    const profile = {
      currentStreak: 2,
      longestStreak: 4,
      solvedCount: 3,
      failedCount: 1,
      accuracyPercentage: 75,
      regionalKnowledge: [
        {
          regionId: 'aster-quay',
          alphaHundredths: 250,
          betaHundredths: 200,
          sampleCount: 1,
          displayPercentage: 56,
        },
      ],
    }
    const handlers = createReportingHandlers(
      repository({ readProfile: vi.fn(async () => profile) }),
      keys,
    )
    await expect(
      handlers.getProfile!(context({ operationId: 'getProfile' })),
    ).resolves.toEqual({
      status: 200,
      body: { data: profile },
    })
  })

  it('issues an authenticated cursor and decodes it for the next page', async () => {
    const read = vi
      .fn<ReportingRouteRepository['readDailyLeaderboardPage']>()
      .mockResolvedValueOnce({ items: [], nextPosition: firstPosition })
      .mockResolvedValueOnce({ items: [], nextPosition: null })
    const handler = createReportingHandlers(
      repository({ readDailyLeaderboardPage: read }),
      keys,
    ).getLeaderboard!
    const first = (await handler(context({ query: { limit: '1' } }))) as {
      body: { data: { nextCursor: string } }
    }
    expect(first.body.data.nextCursor).toMatch(/^v1\.active\./u)
    await handler(
      context({ query: { limit: '1', cursor: first.body.data.nextCursor } }),
    )
    expect(read.mock.calls[1]?.[0]).toEqual({
      slotId,
      limit: 1,
      cursor: firstPosition,
    })
  })

  it('rejects tampered, wrong-slot, unknown-key, and validly signed nonexistent cursors', async () => {
    const issue = createReportingHandlers(
      repository({
        readDailyLeaderboardPage: vi.fn(async () => ({
          items: [],
          nextPosition: firstPosition,
        })),
      }),
      keys,
    ).getLeaderboard!
    const response = (await issue(context())) as {
      body: { data: { nextCursor: string } }
    }
    const cursor = response.body.data.nextCursor
    const tampered = `${cursor.slice(0, -1)}${cursor.endsWith('A') ? 'B' : 'A'}`
    const handler = createReportingHandlers(
      repository({
        readDailyLeaderboardPage: vi.fn(async () => {
          throw new RangeError('cursor tuple missing')
        }),
      }),
      keys,
    ).getLeaderboard!

    for (const [pathSlot, candidate] of [
      [slotId, tampered],
      ['2026-09-16', cursor],
      [slotId, cursor.replace('.active.', '.retired.')],
      [slotId, cursor],
    ] as const) {
      const error = await publicError(
        Promise.resolve(
          handler(
            context({
              params: { slotId: pathSlot },
              query: { cursor: candidate },
            }),
          ),
        ),
      )
      expect(error).toMatchObject({
        code: 'INVALID_REQUEST',
        fields: [{ path: '$.cursor', code: 'INVALID_FORMAT' }],
      })
    }
  })
})
