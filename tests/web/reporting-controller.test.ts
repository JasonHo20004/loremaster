import { describe, expect, it, vi } from 'vitest'

import type { ApiClient } from '../../apps/web/src/api/client.js'
import { ApiClientError } from '../../apps/web/src/api/errors.js'
import { ReportingController } from '../../apps/web/src/reporting/controller.js'

const CURSOR = `v1.active.YQ.${'A'.repeat(43)}`

describe('web reporting reads', () => {
  it('suppresses duplicate append requests and preserves API order and ranks', async () => {
    let releasePage: (() => void) | undefined
    const secondPage = new Promise<void>((resolve) => {
      releasePage = resolve
    })
    const requestReadWithRetry = vi
      .fn()
      .mockResolvedValueOnce({
        data: {
          items: [
            {
              attemptId: '00000000-0000-4000-8000-000000000001',
              pseudonym: 'First',
              evidenceLevel: 1,
              totalWrongGuesses: 0,
              elapsedMilliseconds: 42,
              score: 0,
              rank: 1,
            },
          ],
          nextCursor: CURSOR,
        },
      })
      .mockImplementationOnce(async () => {
        await secondPage
        return {
          data: {
            items: [
              {
                attemptId: '00000000-0000-4000-8000-000000000002',
                pseudonym: 'Second',
                evidenceLevel: 1,
                totalWrongGuesses: 0,
                elapsedMilliseconds: 42,
                score: 0,
                rank: 1,
              },
            ],
            nextCursor: null,
          },
        }
      })
    const controller = new ReportingController({
      requestReadWithRetry,
    } as unknown as ApiClient)

    await controller.selectLeaderboardSlot('2030-01-01')
    const first = controller.loadMoreLeaderboard()
    const duplicate = controller.loadMoreLeaderboard()

    expect(requestReadWithRetry).toHaveBeenCalledTimes(2)
    releasePage?.()
    await Promise.all([first, duplicate])
    expect(controller.state.leaderboardEntries.map(({ rank }) => rank)).toEqual(
      [1, 1],
    )
    expect(
      controller.state.leaderboardEntries.map(({ score }) => score),
    ).toEqual([0, 0])
    expect(controller.state.leaderboardNextCursor).toBeNull()
  })

  it('isolates a failed profile read and permits an explicit retry', async () => {
    const profile = {
      currentStreak: 0,
      longestStreak: 0,
      solvedCount: 0,
      failedCount: 0,
      accuracyPercentage: 0,
      regionalKnowledge: [],
    }
    const requestReadWithRetry = vi
      .fn()
      .mockRejectedValueOnce(new ApiClientError('NETWORK_ERROR'))
      .mockResolvedValueOnce({ data: profile })
    const controller = new ReportingController({
      requestReadWithRetry,
    } as unknown as ApiClient)

    await controller.refreshProfile()
    expect(controller.state.profileStatus).toBe('ERROR')
    await controller.refreshProfile(true)
    expect(controller.state).toMatchObject({
      profile,
      profileStatus: 'READY',
    })
  })
})
