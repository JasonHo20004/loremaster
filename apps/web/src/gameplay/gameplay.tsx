import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from 'react'
import type { GameplayCommandRequest } from '@loremaster/contracts'

import type { ApiClient } from '../api/client.js'
import type {
  AttemptProjection,
  GameController,
  GameControllerState,
} from '../state/controller.js'

type ActiveAttempt = Extract<AttemptProjection, { readonly state: 'ACTIVE' }>
type TerminalAttempt = Exclude<AttemptProjection, ActiveAttempt>
type Suggestion = ActiveAttempt['suggestions'][number]

export interface SuggestionSearch {
  (
    attemptId: string,
    query: string,
    signal: AbortSignal,
  ): Promise<readonly Suggestion[]>
}

interface GameplayExperienceProps {
  readonly client: ApiClient
  readonly controller: GameController
  readonly manageControllerLifecycle?: boolean
  readonly onNewSession?: () => Promise<void>
}

interface CurrentCaseViewProps {
  readonly searchSuggestions: SuggestionSearch
  readonly state: GameControllerState
  readonly onNewSession: () => Promise<void>
  readonly onReconcile: () => Promise<void>
  readonly onRefresh: () => Promise<void>
  readonly onReplay: () => Promise<void>
  readonly onStart: () => Promise<void>
  readonly onSubmit: (request: GameplayCommandRequest) => Promise<void>
}

const TERMINAL_COPY = {
  SOLVED: {
    eyebrow: 'Case solved',
    title: 'The record is restored',
    detail: 'Your deduction matched the archive.',
  },
  GIVEN_UP: {
    eyebrow: 'Case closed',
    title: 'The solution is unsealed',
    detail: 'You ended this investigation before solving it.',
  },
  EXHAUSTED: {
    eyebrow: 'Attempts exhausted',
    title: 'The solution is unsealed',
    detail: 'The final incorrect guess closed this investigation.',
  },
  EXPIRED: {
    eyebrow: 'Time expired',
    title: 'The solution is unsealed',
    detail: 'The UTC case window closed before the investigation finished.',
  },
} as const

function formatUtc(value: string): string {
  return new Intl.DateTimeFormat('en', {
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    month: 'short',
    timeZone: 'UTC',
    timeZoneName: 'short',
    year: 'numeric',
  }).format(new Date(value))
}

function safeAction(action: () => Promise<unknown>): void {
  void action().catch(() => undefined)
}

function mutationIsBlocking(state: GameControllerState): boolean {
  return (
    state.mutationStatus === 'IN_FLIGHT' || state.mutationStatus === 'UNCERTAIN'
  )
}

function MutationRecovery({
  state,
  onReconcile,
  onReplay,
}: Pick<CurrentCaseViewProps, 'state' | 'onReconcile' | 'onReplay'>) {
  if (state.mutationStatus === 'IDLE') return null
  if (state.mutationStatus === 'IN_FLIGHT') {
    return (
      <p className="notice" role="status">
        Recording your action…
      </p>
    )
  }
  if (state.mutationStatus === 'STALE') {
    return (
      <p className="notice" role="status">
        The case changed elsewhere. The latest record is shown; review it before
        trying again.
      </p>
    )
  }
  return (
    <section className="recovery-panel" aria-labelledby="recovery-title">
      <h2 id="recovery-title">Action outcome unknown</h2>
      <p>
        The service may have recorded this action. New actions are paused until
        you retry the exact same request or check the authoritative record.
      </p>
      <div className="button-row">
        <button type="button" onClick={() => safeAction(onReplay)}>
          Retry same action
        </button>
        <button
          className="secondary-button"
          type="button"
          onClick={() => safeAction(onReconcile)}
        >
          Check current record
        </button>
      </div>
    </section>
  )
}

function ActionError({ state }: { readonly state: GameControllerState }) {
  const alert = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (state.error !== undefined && state.status === 'READY') {
      alert.current?.focus()
    }
  }, [state.error, state.status])
  if (
    state.error === undefined ||
    state.status !== 'READY' ||
    state.mutationStatus === 'UNCERTAIN'
  ) {
    return null
  }
  const requestId =
    'requestId' in state.error ? state.error.requestId : undefined
  return (
    <div ref={alert} className="action-error" role="alert" tabIndex={-1}>
      <strong>The action could not be completed.</strong> Review the latest case
      record before trying again.
      {requestId === undefined ? null : (
        <small> Support reference: {requestId}</small>
      )}
    </div>
  )
}

interface EntityComboboxProps {
  readonly attempt: ActiveAttempt
  readonly disabled: boolean
  readonly onGuess: (entityId: string) => Promise<void>
  readonly searchSuggestions: SuggestionSearch
}

export function EntityCombobox({
  attempt,
  disabled,
  onGuess,
  searchSuggestions,
}: EntityComboboxProps): React.JSX.Element {
  const inputId = useId()
  const listboxId = useId()
  const hintId = `${inputId}-hint`
  const errorId = `${inputId}-error`
  const inputRef = useRef<HTMLInputElement>(null)
  const searchGeneration = useRef(0)
  const [activeIndex, setActiveIndex] = useState(-1)
  const [announcement, setAnnouncement] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<readonly Suggestion[]>([])
  const [selected, setSelected] = useState<Suggestion>()
  const guessedIds = new Set(
    attempt.guessHistory.map((guess) => guess.entityId),
  )
  const selectedWasGuessed =
    selected !== undefined && guessedIds.has(selected.entityId)
  const isOpen = results.length > 0 && selected === undefined

  useEffect(() => {
    const normalized = query.trim().slice(0, 80)
    const generation = ++searchGeneration.current
    if (normalized.length === 0 || selected !== undefined) {
      setResults([])
      setActiveIndex(-1)
      setLoading(false)
      return
    }
    const abort = new AbortController()
    const timer = globalThis.setTimeout(() => {
      setLoading(true)
      setError('')
      void searchSuggestions(attempt.attemptId, normalized, abort.signal)
        .then((items) => {
          if (generation !== searchGeneration.current) return
          setResults(items)
          setActiveIndex(items.length === 0 ? -1 : 0)
          setAnnouncement(
            items.length === 1
              ? '1 matching entity'
              : `${items.length} matching entities`,
          )
        })
        .catch(() => {
          if (abort.signal.aborted || generation !== searchGeneration.current)
            return
          setResults([])
          setActiveIndex(-1)
          setError('Suggestions could not be loaded. Try typing again.')
        })
        .finally(() => {
          if (generation === searchGeneration.current) setLoading(false)
        })
    }, 250)
    return () => {
      globalThis.clearTimeout(timer)
      abort.abort()
    }
  }, [attempt.attemptId, query, searchSuggestions, selected])

  function choose(suggestion: Suggestion): void {
    setSelected(suggestion)
    setQuery(suggestion.canonicalName)
    setResults([])
    setActiveIndex(-1)
    setAnnouncement(`${suggestion.canonicalName} selected`)
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Escape') {
      setResults([])
      setActiveIndex(-1)
      return
    }
    if (results.length === 0) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const offset = event.key === 'ArrowDown' ? 1 : -1
      setActiveIndex((current) => {
        const start = current < 0 ? (offset > 0 ? -1 : 0) : current
        return (start + offset + results.length) % results.length
      })
    } else if (event.key === 'Enter' && activeIndex >= 0) {
      event.preventDefault()
      const suggestion = results[activeIndex]
      if (suggestion !== undefined) choose(suggestion)
    }
  }

  function submitGuess(): void {
    if (selected === undefined || selectedWasGuessed || disabled) return
    safeAction(async () => {
      setError('')
      try {
        await onGuess(selected.entityId)
        setSelected(undefined)
        setQuery('')
        setAnnouncement('Guess recorded')
        inputRef.current?.focus()
      } catch {
        setError(
          'The guess was not completed. Review the case status and try again.',
        )
        inputRef.current?.focus()
      }
    })
  }

  return (
    <section className="guess-panel" aria-labelledby={`${inputId}-heading`}>
      <h2 id={`${inputId}-heading`}>Name the subject</h2>
      <label htmlFor={inputId}>Search the public entity index</label>
      <div className="combobox-wrap">
        <input
          ref={inputRef}
          id={inputId}
          type="text"
          role="combobox"
          autoComplete="off"
          aria-autocomplete="list"
          aria-controls={listboxId}
          aria-expanded={isOpen}
          aria-activedescendant={
            isOpen && activeIndex >= 0
              ? `${listboxId}-option-${activeIndex}`
              : undefined
          }
          aria-describedby={`${hintId}${selectedWasGuessed || error ? ` ${errorId}` : ''}`}
          aria-invalid={selectedWasGuessed || error !== ''}
          disabled={disabled}
          maxLength={80}
          value={query}
          onChange={(event) => {
            setQuery(event.currentTarget.value)
            setSelected(undefined)
            setError('')
          }}
          onKeyDown={onKeyDown}
        />
        {isOpen ? (
          <ul id={listboxId} className="suggestions" role="listbox">
            {results.map((suggestion, index) => (
              <li
                id={`${listboxId}-option-${index}`}
                key={suggestion.entityId}
                role="option"
                aria-selected={index === activeIndex}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => choose(suggestion)}
              >
                <strong>{suggestion.canonicalName}</strong>
                <span>{suggestion.publicRole}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <p id={hintId} className="field-hint">
        {loading
          ? 'Searching…'
          : 'Choose a canonical result. Typed text alone cannot be submitted.'}
      </p>
      {selectedWasGuessed ? (
        <p id={errorId} className="field-error" role="alert">
          That entity is already in your guess history. Choose another.
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="field-error" role="alert">
          {error}
        </p>
      ) : null}
      <span className="visually-hidden" aria-live="polite">
        {announcement}
      </span>
      <button
        type="button"
        disabled={disabled || selected === undefined || selectedWasGuessed}
        onClick={submitGuess}
      >
        Submit guess
      </button>
    </section>
  )
}

function GuessHistory({ attempt }: { readonly attempt: ActiveAttempt }) {
  if (attempt.guessHistory.length === 0) return null
  const entities = new Map(
    attempt.suggestions.map((suggestion) => [suggestion.entityId, suggestion]),
  )
  return (
    <section aria-labelledby="guess-history-title">
      <h2 id="guess-history-title">Previous guesses</h2>
      <ol className="guess-history">
        {attempt.guessHistory.map((guess) => (
          <li key={`${guess.entityId}-${guess.guessedAt}`}>
            <span>
              {entities.get(guess.entityId)?.canonicalName ?? 'Known entity'}
            </span>
            <span>Not the answer</span>
          </li>
        ))}
      </ol>
    </section>
  )
}

function ActiveCase({
  attempt,
  disabled,
  onSubmit,
  searchSuggestions,
}: {
  readonly attempt: ActiveAttempt
  readonly disabled: boolean
  readonly onSubmit: CurrentCaseViewProps['onSubmit']
  readonly searchSuggestions: SuggestionSearch
}): React.JSX.Element {
  const [confirmingGiveUp, setConfirmingGiveUp] = useState(false)
  const giveUpButton = useRef<HTMLButtonElement>(null)
  const cancelButton = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (confirmingGiveUp) cancelButton.current?.focus()
  }, [confirmingGiveUp])

  function closeConfirmation(): void {
    setConfirmingGiveUp(false)
    globalThis.setTimeout(() => giveUpButton.current?.focus(), 0)
  }

  return (
    <article className="gameplay" aria-labelledby="view-title">
      <header className="case-heading">
        <div>
          <p className="eyebrow">Active daily case</p>
          <h1 id="view-title">The investigation is open</h1>
        </div>
        <p className="utc-time">
          Closes{' '}
          <time dateTime={attempt.closesAt}>{formatUtc(attempt.closesAt)}</time>
        </p>
      </header>
      <section className="briefing" aria-labelledby="briefing-title">
        <h2 id="briefing-title">Briefing</h2>
        <p>{attempt.briefing}</p>
      </section>
      <dl className="case-counters">
        <div>
          <dt>Evidence</dt>
          <dd>{attempt.evidenceLevel} of 4</dd>
        </div>
        <div>
          <dt>Wrong at this level</dt>
          <dd>{attempt.wrongGuessesAtLevel} of 3</dd>
        </div>
        <div>
          <dt>Total wrong</dt>
          <dd>{attempt.totalWrongGuesses}</dd>
        </div>
      </dl>
      <section aria-labelledby="evidence-title">
        <h2 id="evidence-title">Evidence</h2>
        {attempt.evidence.length === 0 ? (
          <p className="muted-copy">No evidence has been revealed yet.</p>
        ) : (
          <ol className="evidence-list">
            {attempt.evidence.map((evidence) => (
              <li key={evidence.level}>
                <span>Evidence {evidence.level}</span>
                <p>{evidence.text}</p>
              </li>
            ))}
          </ol>
        )}
      </section>
      <GuessHistory attempt={attempt} />
      <EntityCombobox
        attempt={attempt}
        disabled={disabled}
        searchSuggestions={searchSuggestions}
        onGuess={(entityId) =>
          onSubmit({
            expectedVersion: attempt.version,
            command: { kind: 'GUESS', entityId },
          })
        }
      />
      <section className="case-actions" aria-labelledby="case-actions-title">
        <h2 id="case-actions-title">Other actions</h2>
        {attempt.evidenceLevel < 4 ? (
          <div>
            <p>
              Reveal the next evidence level. This does not count as
              participation.
            </p>
            <button
              className="secondary-button"
              type="button"
              disabled={disabled}
              onClick={() =>
                safeAction(() =>
                  onSubmit({
                    expectedVersion: attempt.version,
                    command: { kind: 'REVEAL' },
                  }),
                )
              }
            >
              Reveal evidence {attempt.evidenceLevel + 1}
            </button>
          </div>
        ) : (
          <p>All four evidence levels are visible.</p>
        )}
        <button
          ref={giveUpButton}
          className="danger-button"
          type="button"
          disabled={disabled}
          onClick={() => setConfirmingGiveUp(true)}
        >
          Give up
        </button>
      </section>
      {confirmingGiveUp ? (
        <div className="dialog-backdrop">
          <section
            className="confirm-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="give-up-title"
            aria-describedby="give-up-description"
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                closeConfirmation()
                return
              }
              if (event.key !== 'Tab') return
              const target = event.target
              if (event.shiftKey && target === cancelButton.current) {
                event.preventDefault()
                ;(
                  event.currentTarget.querySelector(
                    '.danger-button',
                  ) as HTMLElement | null
                )?.focus()
              } else if (!event.shiftKey && target !== cancelButton.current) {
                event.preventDefault()
                cancelButton.current?.focus()
              }
            }}
          >
            <h2 id="give-up-title">End this investigation?</h2>
            <p id="give-up-description">
              Giving up is final and will unseal the solution.
            </p>
            <div className="button-row">
              <button
                ref={cancelButton}
                type="button"
                onClick={closeConfirmation}
              >
                Keep investigating
              </button>
              <button
                className="danger-button"
                type="button"
                onClick={() => {
                  setConfirmingGiveUp(false)
                  globalThis.setTimeout(() => giveUpButton.current?.focus(), 0)
                  safeAction(() =>
                    onSubmit({
                      expectedVersion: attempt.version,
                      command: { kind: 'GIVE_UP' },
                    }),
                  )
                }}
              >
                Confirm give up
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </article>
  )
}

function TerminalCase({ attempt }: { readonly attempt: TerminalAttempt }) {
  const copy = TERMINAL_COPY[attempt.state]
  return (
    <article className="gameplay terminal-case" aria-labelledby="view-title">
      <header className="case-heading">
        <div>
          <p className="eyebrow">{copy.eyebrow}</p>
          <h1 id="view-title">{copy.title}</h1>
          <p>{copy.detail}</p>
        </div>
      </header>
      <section className="answer-card" aria-labelledby="answer-title">
        <p className="eyebrow">Archive answer</p>
        <h2 id="answer-title">{attempt.answer.canonicalName}</h2>
        <p>{attempt.answer.publicRole}</p>
      </section>
      <section aria-labelledby="complete-evidence-title">
        <h2 id="complete-evidence-title">Complete evidence record</h2>
        <ol className="evidence-list terminal-evidence">
          {attempt.evidence.map((evidence) => (
            <li key={evidence.level}>
              <span>Evidence {evidence.level}</span>
              <p>{evidence.text}</p>
              <h3>Explanation</h3>
              <p>{evidence.explanation}</p>
              <h3>Sources</h3>
              <ul>
                {evidence.sourceReferences.map((source, index) => (
                  <li key={`${evidence.level}-${index}`}>{source}</li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      </section>
      <nav className="reporting-links" aria-label="Case reporting">
        <a href="/profile">View investigator profile</a>
        <a href="/leaderboard">View daily ledger</a>
      </nav>
    </article>
  )
}

export function CurrentCaseView(
  props: CurrentCaseViewProps,
): React.JSX.Element {
  const { state } = props
  if (state.status === 'IDLE' || state.status === 'HYDRATING') {
    return (
      <section
        className="archive-card"
        aria-labelledby="view-title"
        aria-busy="true"
      >
        <div className="card-copy">
          <p className="eyebrow">Daily case</p>
          <h1 id="view-title">Opening the archive</h1>
          <p>Your guest record and the current UTC case are being restored.</p>
        </div>
      </section>
    )
  }
  if (state.status === 'SESSION_LOST') {
    return (
      <section className="archive-card" aria-labelledby="view-title">
        <div className="card-copy">
          <p className="eyebrow">Guest session ended</p>
          <h1 id="view-title">This identity cannot be recovered</h1>
          <p>
            Starting a new guest session will not restore this browser’s
            previous attempt or history.
          </p>
          <button type="button" onClick={() => safeAction(props.onNewSession)}>
            Start a new guest session
          </button>
        </div>
      </section>
    )
  }
  if (state.status === 'READ_ERROR') {
    return (
      <section className="archive-card" aria-labelledby="view-title">
        <div className="card-copy">
          <p className="eyebrow">Archive unavailable</p>
          <h1 id="view-title">The record could not be loaded</h1>
          <p>
            {state.error?.message ?? 'The service could not be reached.'} This
            did not change your case. Try the safe read again.
          </p>
          <button type="button" onClick={() => safeAction(props.onRefresh)}>
            Retry loading
          </button>
        </div>
      </section>
    )
  }

  const current = state.currentCase
  if (current === undefined || current.view === 'NO_CASE') {
    return (
      <section className="archive-card" aria-labelledby="view-title">
        <div className="card-copy">
          <p className="eyebrow">Daily case</p>
          <h1 id="view-title">The archive is quiet</h1>
          <p>
            No case is available. Check again after the next UTC archive update.
          </p>
          <button type="button" onClick={() => safeAction(props.onRefresh)}>
            Check again
          </button>
        </div>
      </section>
    )
  }
  if (current.view === 'NOT_STARTED') {
    const disabled = mutationIsBlocking(state)
    return (
      <div className="gameplay-stack">
        <section className="archive-card" aria-labelledby="view-title">
          <div className="card-copy">
            <p className="eyebrow">Daily case · {current.slotId}</p>
            <h1 id="view-title">A sealed record awaits</h1>
            <p>
              Available until{' '}
              <time dateTime={current.closesAt}>
                {formatUtc(current.closesAt)}
              </time>
              . Reading this page has not started an attempt.
            </p>
            <button
              type="button"
              disabled={disabled}
              onClick={() => safeAction(props.onStart)}
            >
              Start investigation
            </button>
          </div>
        </section>
        <ActionError state={state} />
        <MutationRecovery {...props} />
      </div>
    )
  }

  return (
    <div className="gameplay-stack">
      {current.state === 'ACTIVE' ? (
        <ActiveCase
          attempt={current}
          disabled={mutationIsBlocking(state)}
          onSubmit={props.onSubmit}
          searchSuggestions={props.searchSuggestions}
        />
      ) : (
        <TerminalCase attempt={current} />
      )}
      <ActionError state={state} />
      <MutationRecovery {...props} />
    </div>
  )
}

export function GameplayExperience({
  client,
  controller,
  manageControllerLifecycle = true,
  onNewSession,
}: GameplayExperienceProps): React.JSX.Element {
  const state = useSyncExternalStore(
    (listener) => controller.subscribe(listener),
    () => controller.state,
  )

  useEffect(() => {
    if (!manageControllerLifecycle) return
    const detach = controller.attachLifecycle(window, document)
    void controller.initialize()
    return () => {
      detach()
      controller.dispose()
    }
  }, [controller, manageControllerLifecycle])

  const searchSuggestions: SuggestionSearch = async (
    attemptId,
    query,
    signal,
  ) => {
    const response = await client.requestReadWithRetry('getSuggestions', {
      path: { attemptId },
      query: { q: query },
      signal,
    })
    return response.data.items
  }

  return (
    <CurrentCaseView
      state={state}
      searchSuggestions={searchSuggestions}
      onNewSession={onNewSession ?? (() => controller.initialize(true))}
      onReconcile={async () => {
        await controller.reconcilePendingOperation()
      }}
      onRefresh={() => controller.refreshCurrentCase(true)}
      onReplay={() => controller.replayPendingOperation()}
      onStart={() => controller.startAttempt()}
      onSubmit={(request) => controller.submitCommand(request)}
    />
  )
}
