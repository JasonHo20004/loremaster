import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { page, userEvent } from 'vitest/browser'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiClient } from '../api/client.js'
import {
  PendingOperationStore,
  type PendingStorage,
} from '../api/pending-operation.js'
import type {
  AttemptProjection,
  GameControllerState,
} from '../state/controller.js'
import { GameController } from '../state/controller.js'
import { CurrentCaseView, GameplayExperience } from './gameplay.js'

const ATTEMPT_ID = '00000000-0000-4000-8000-000000000001'
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
]

function activeAttempt(
  evidenceLevel: 0 | 1 | 2 | 3 | 4 = 1,
): Extract<AttemptProjection, { readonly state: 'ACTIVE' }> {
  return {
    view: 'ATTEMPT',
    state: 'ACTIVE',
    attemptId: ATTEMPT_ID,
    version: 3,
    startedAt: '2029-12-31T00:00:00.000Z',
    closesAt: '2030-01-01T00:00:00.000Z',
    evidenceLevel,
    wrongGuessesAtLevel: 1,
    totalWrongGuesses: 1,
    briefing: 'Read <script>carefully</script>, not as markup.',
    suggestions: SUGGESTIONS,
    guessHistory: [
      { entityId: 'night-clerk', guessedAt: '2029-12-31T00:01:00.000Z' },
    ],
    evidence: [
      { level: 1, text: 'A link-like clue: https://invalid.example/track' },
      { level: 2, text: 'Second clue' },
      { level: 3, text: 'Third clue' },
      { level: 4, text: 'Fourth clue' },
    ].slice(0, evidenceLevel) as Extract<
      AttemptProjection,
      { readonly state: 'ACTIVE' }
    >['evidence'],
  }
}

function terminalAttempt(): Exclude<
  AttemptProjection,
  { readonly state: 'ACTIVE' }
> {
  return {
    ...activeAttempt(4),
    state: 'SOLVED',
    answer: {
      ...SUGGESTIONS[0]!,
      canonicalName: '<img src=x onerror=alert(1)>',
    },
    evidence: [1, 2, 3, 4].map((level) => ({
      level,
      text: `Clue ${level}`,
      explanation: `<script>explanation ${level}</script>`,
      sourceReferences: [`javascript:source-${level}`],
    })) as Exclude<AttemptProjection, { readonly state: 'ACTIVE' }>['evidence'],
  }
}

let container: HTMLDivElement
let root: Root

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

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function renderState(
  state: GameControllerState,
  options: {
    readonly onStart?: () => Promise<void>
    readonly onSubmit?: (request: {
      readonly expectedVersion: number
      readonly command:
        | { readonly kind: 'GUESS'; readonly entityId: string }
        | { readonly kind: 'REVEAL' }
        | { readonly kind: 'GIVE_UP' }
    }) => Promise<void>
    readonly searchSuggestions?: (
      attemptId: string,
      query: string,
      signal: AbortSignal,
    ) => Promise<typeof SUGGESTIONS>
  } = {},
): void {
  act(() =>
    root.render(
      <CurrentCaseView
        state={state}
        searchSuggestions={
          options.searchSuggestions ?? (async () => SUGGESTIONS)
        }
        onNewSession={async () => undefined}
        onReconcile={async () => undefined}
        onRefresh={async () => undefined}
        onReplay={async () => undefined}
        onStart={options.onStart ?? (async () => undefined)}
        onSubmit={options.onSubmit ?? (async () => undefined)}
      />,
    ),
  )
}

describe('accessible gameplay experience', () => {
  it('does not start from a read and requires the explicit Start action', async () => {
    const onStart = vi.fn(async () => undefined)
    renderState(
      {
        status: 'READY',
        mutationStatus: 'IDLE',
        currentCase: {
          view: 'NOT_STARTED',
          slotId: '2029-12-31',
          opensAt: '2029-12-31T00:00:00.000Z',
          closesAt: '2030-01-01T00:00:00.000Z',
        },
      },
      { onStart },
    )

    expect(onStart).not.toHaveBeenCalled()
    await userEvent.click(
      page.getByRole('button', { name: 'Start investigation' }),
    )
    expect(onStart).toHaveBeenCalledOnce()
  })

  it('submits only a keyboard-selected canonical entity and rejects a repeat', async () => {
    const onSubmit = vi.fn(async () => undefined)
    const searchSuggestions = vi.fn(async (_attemptId, query: string) =>
      query === 'night' ? [SUGGESTIONS[1]!] : [SUGGESTIONS[0]!],
    )
    renderState(
      {
        status: 'READY',
        mutationStatus: 'IDLE',
        currentCase: activeAttempt(),
      },
      { onSubmit, searchSuggestions },
    )

    const input = page.getByRole('combobox', {
      name: 'Search the public entity index',
    })
    await userEvent.fill(input, 'harbor')
    await new Promise((resolve) => globalThis.setTimeout(resolve, 300))
    await userEvent.keyboard('{Enter}')
    await userEvent.click(page.getByRole('button', { name: 'Submit guess' }))

    expect(searchSuggestions).toHaveBeenCalledWith(
      ATTEMPT_ID,
      'harbor',
      expect.any(AbortSignal),
    )
    expect(onSubmit).toHaveBeenCalledWith({
      expectedVersion: 3,
      command: { kind: 'GUESS', entityId: 'harbor-master' },
    })
    await expect.element(input).toHaveValue('')

    await userEvent.fill(input, 'night')
    await new Promise((resolve) => globalThis.setTimeout(resolve, 300))
    await userEvent.keyboard('{Enter}')
    await expect
      .element(
        page.getByText(
          'That entity is already in your guess history. Choose another.',
        ),
      )
      .toBeVisible()
    await expect
      .element(page.getByRole('button', { name: 'Submit guess' }))
      .toBeDisabled()
  })

  it('denies a fifth reveal and confirms give up with focus restoration', async () => {
    renderState({
      status: 'READY',
      mutationStatus: 'IDLE',
      currentCase: activeAttempt(4),
    })

    expect(
      page.getByRole('button', { name: /Reveal evidence/u }).query(),
    ).toBeNull()
    await expect
      .element(page.getByText('All four evidence levels are visible.'))
      .toBeVisible()

    await userEvent.click(page.getByRole('button', { name: 'Give up' }))
    await expect
      .element(
        page.getByRole('alertdialog', { name: 'End this investigation?' }),
      )
      .toBeVisible()
    await expect
      .element(page.getByRole('button', { name: 'Keep investigating' }))
      .toHaveFocus()
    await userEvent.click(
      page.getByRole('button', { name: 'Keep investigating' }),
    )
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0))
    await expect
      .element(page.getByRole('button', { name: 'Give up' }))
      .toHaveFocus()
  })

  it('renders terminal disclosure and hostile strings as inert text', async () => {
    renderState({
      status: 'READY',
      mutationStatus: 'IDLE',
      currentCase: terminalAttempt(),
    })

    await expect
      .element(page.getByText('<img src=x onerror=alert(1)>'))
      .toBeVisible()
    await expect
      .element(page.getByText('<script>explanation 4</script>'))
      .toBeVisible()
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelectorAll('.terminal-evidence > li')).toHaveLength(
      4,
    )
  })

  it('blocks actions and explains uncertain mutation recovery honestly', async () => {
    renderState({
      status: 'READY',
      mutationStatus: 'UNCERTAIN',
      currentCase: activeAttempt(),
      pendingOperation: { kind: 'GAMEPLAY_COMMAND', createdAt: 100 },
    })

    await expect
      .element(page.getByRole('heading', { name: 'Action outcome unknown' }))
      .toBeVisible()
    await expect
      .element(page.getByRole('button', { name: 'Submit guess' }))
      .toBeDisabled()
    await expect
      .element(page.getByRole('button', { name: 'Retry same action' }))
      .toBeVisible()
  })

  it('allows a fresh action after stale state has been refreshed', async () => {
    renderState({
      status: 'READY',
      mutationStatus: 'STALE',
      currentCase: activeAttempt(),
    })

    await expect
      .element(page.getByText(/The latest record is shown/u))
      .toBeVisible()
    await expect
      .element(page.getByRole('button', { name: 'Reveal evidence 2' }))
      .toBeEnabled()
    await expect
      .element(page.getByRole('button', { name: 'Give up' }))
      .toBeEnabled()
  })

  it('plays a composed start, reveal, canonical guess, and solve journey', async () => {
    const started = {
      ...activeAttempt(0),
      version: 1,
      wrongGuessesAtLevel: 0 as const,
      totalWrongGuesses: 0,
      guessHistory: [],
    }
    const revealed = {
      ...activeAttempt(1),
      version: 2,
      wrongGuessesAtLevel: 0 as const,
      totalWrongGuesses: 0,
      guessHistory: [],
    }
    const solved = {
      ...terminalAttempt(),
      version: 3,
      answer: SUGGESTIONS[0]!,
    }
    const fetchImplementation = vi.fn<typeof fetch>(async (input, init) => {
      const path = new URL(input instanceof Request ? input.url : String(input))
        .pathname
      const method = init?.method ?? 'GET'
      if (path === '/api/v1/session') {
        return Response.json({
          data: { expiresAt: '2030-01-01T00:00:00.000Z' },
        })
      }
      if (path === '/api/v1/cases/current' && method === 'GET') {
        return Response.json({
          data: {
            view: 'NOT_STARTED',
            slotId: '2029-12-31',
            opensAt: '2029-12-31T00:00:00.000Z',
            closesAt: '2030-01-01T00:00:00.000Z',
          },
        })
      }
      if (path === '/api/v1/cases/current/attempt') {
        return Response.json({
          data: {
            outcomeCode: 'STARTED',
            replayed: false,
            attempt: started,
          },
        })
      }
      if (path.endsWith('/suggestions')) {
        return Response.json({ data: { items: [SUGGESTIONS[0]!] } })
      }
      if (path.endsWith('/commands')) {
        const body = JSON.parse(String(init?.body)) as {
          readonly command: { readonly kind: string }
        }
        return Response.json({
          data:
            body.command.kind === 'REVEAL'
              ? {
                  outcomeCode: 'REVEALED',
                  replayed: false,
                  attempt: revealed,
                }
              : {
                  outcomeCode: 'CORRECT',
                  replayed: false,
                  attempt: solved,
                },
        })
      }
      return Response.json({}, { status: 500 })
    })
    const client = new ApiClient({
      apiBaseUrl: new URL('http://localhost/api/v1'),
      browserOrigin: 'http://localhost',
      cookieSource: () => `loremaster_local_csrf=${'a'.repeat(43)}`,
      fetchImplementation,
    })
    const controller = new GameController({
      client,
      pendingStore: new PendingOperationStore(new MemoryStorage()),
    })

    act(() =>
      root.render(
        <GameplayExperience client={client} controller={controller} />,
      ),
    )
    await expect
      .element(page.getByRole('heading', { name: 'A sealed record awaits' }))
      .toBeVisible()
    await userEvent.click(
      page.getByRole('button', { name: 'Start investigation' }),
    )
    await expect
      .element(page.getByRole('heading', { name: 'The investigation is open' }))
      .toBeVisible()

    await userEvent.click(
      page.getByRole('button', { name: 'Reveal evidence 1' }),
    )
    await expect
      .element(
        page.getByText('A link-like clue: https://invalid.example/track'),
      )
      .toBeVisible()

    const input = page.getByRole('combobox', {
      name: 'Search the public entity index',
    })
    await userEvent.fill(input, 'harbor')
    await new Promise((resolve) => globalThis.setTimeout(resolve, 300))
    await userEvent.keyboard('{Enter}')
    await userEvent.click(page.getByRole('button', { name: 'Submit guess' }))

    await expect
      .element(page.getByRole('heading', { name: 'The record is restored' }))
      .toBeVisible()
    await expect
      .element(page.getByRole('heading', { name: 'Harbor Master' }))
      .toBeVisible()
    expect(fetchImplementation).toHaveBeenCalledTimes(6)
  })
})
