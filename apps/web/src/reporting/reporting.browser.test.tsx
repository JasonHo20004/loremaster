import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { page } from 'vitest/browser'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { LeaderboardView } from '../leaderboard/leaderboard.js'
import { ProfileView } from '../profile/profile.js'
import type { ReportingState } from './controller.js'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('reporting views', () => {
  it('presents zero history and exact regional profile values', async () => {
    const state: ReportingState = {
      profileStatus: 'READY',
      profile: {
        currentStreak: 0,
        longestStreak: 2,
        solvedCount: 0,
        failedCount: 0,
        accuracyPercentage: 0,
        regionalKnowledge: [
          {
            regionId: 'north-archive',
            alphaHundredths: 270,
            betaHundredths: 330,
            sampleCount: 2,
            displayPercentage: 45,
          },
        ],
      },
      leaderboardEntries: [],
      leaderboardStatus: 'IDLE',
    }

    await act(async () =>
      root.render(
        <ProfileView state={state} onRetry={async () => undefined} />,
      ),
    )

    await expect
      .element(page.getByText('No completed cases yet.'))
      .toBeVisible()
    await expect.element(page.getByText('45% knowledge')).toBeVisible()
    await expect
      .element(page.getByText('2 observations · α 2.70 · β 3.30'))
      .toBeVisible()
    await expect
      .element(page.getByText(/UTC day when you submit at least one guess/u))
      .toBeVisible()
  })

  it('renders shared ranks, zero scores, and hostile pseudonyms as inert text', async () => {
    const hostile = '<img src=x onerror=alert(1)>'
    const state: ReportingState = {
      profileStatus: 'IDLE',
      leaderboardStatus: 'READY',
      leaderboardSlotId: '2030-01-01',
      leaderboardNextCursor: null,
      leaderboardEntries: [
        {
          attemptId: '00000000-0000-4000-8000-000000000001',
          pseudonym: hostile,
          evidenceLevel: 4,
          totalWrongGuesses: 14,
          elapsedMilliseconds: 300000,
          score: 0,
          rank: 1,
        },
        {
          attemptId: '00000000-0000-4000-8000-000000000002',
          pseudonym: 'Archive Finch',
          evidenceLevel: 4,
          totalWrongGuesses: 14,
          elapsedMilliseconds: 300000,
          score: 0,
          rank: 1,
        },
      ],
    }

    await act(async () =>
      root.render(
        <LeaderboardView
          slotId="2030-01-01"
          state={state}
          onLoadMore={async () => undefined}
          onRetry={async () => undefined}
        />,
      ),
    )

    await expect.element(page.getByRole('table')).toBeVisible()
    await expect
      .element(page.getByRole('status'))
      .toHaveTextContent('2 total leaderboard entries loaded.')
    expect(container.querySelectorAll('tbody tr')[0]?.textContent).toContain(
      `1${hostile}414300000 ms0`,
    )
    expect(container.querySelectorAll('tbody tr')[1]?.textContent).toContain(
      '1Archive Finch414300000 ms0',
    )
    expect(container.querySelector('img')).toBeNull()
    await expect
      .element(page.getByRole('button', { name: 'All entries loaded' }))
      .toBeDisabled()
  })
})
