import { useRef } from 'react'

import type { ReportingState } from '../reporting/controller.js'

interface LeaderboardViewProps {
  readonly slotId?: string
  readonly state: ReportingState
  readonly onLoadMore: () => Promise<void>
  readonly onRetry: () => Promise<void>
}

function safeAction(action: () => Promise<unknown>): void {
  void action().catch(() => undefined)
}

export function LeaderboardView({
  slotId,
  state,
  onLoadMore,
  onRetry,
}: LeaderboardViewProps): React.JSX.Element {
  const loadMore = useRef<HTMLButtonElement>(null)

  if (slotId === undefined) {
    return (
      <section className="report-card" aria-labelledby="leaderboard-title">
        <p className="eyebrow">Daily ledger</p>
        <h1 id="leaderboard-title">No daily ledger available</h1>
        <p className="muted-copy">
          The current projection does not contain an open daily case.
        </p>
      </section>
    )
  }

  const loading =
    state.leaderboardStatus === 'IDLE' || state.leaderboardStatus === 'LOADING'
  const entries =
    state.leaderboardSlotId === slotId ? state.leaderboardEntries : []

  return (
    <section
      className="report-card report-stack"
      aria-labelledby="leaderboard-title"
    >
      <div>
        <p className="eyebrow">Daily ledger</p>
        <h1 id="leaderboard-title">Investigators for {slotId}</h1>
        <p className="muted-copy">
          Rankings and results are shown in the order recorded by the archive.
        </p>
      </div>

      {loading ? <p role="status">Loading daily ledger…</p> : null}
      {state.leaderboardStatus === 'ERROR' ? (
        <div className="report-error" role="alert">
          <p>The daily ledger could not be read. Your case is unaffected.</p>
          <button type="button" onClick={() => safeAction(onRetry)}>
            Try ledger again
          </button>
        </div>
      ) : null}

      {!loading &&
      state.leaderboardStatus !== 'ERROR' &&
      entries.length === 0 ? (
        <p className="empty-report">
          No solved cases have been recorded today.
        </p>
      ) : null}

      {entries.length > 0 ? (
        <div
          className="table-scroll"
          role="region"
          aria-label={`Scrollable daily leaderboard for ${slotId}`}
          tabIndex={0}
        >
          <table>
            <caption className="visually-hidden">
              Daily leaderboard for {slotId}
            </caption>
            <thead>
              <tr>
                <th scope="col">Rank</th>
                <th scope="col">Investigator</th>
                <th scope="col">Evidence</th>
                <th scope="col">Wrong guesses</th>
                <th scope="col">Elapsed</th>
                <th scope="col">Score</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.attemptId}>
                  <td>{entry.rank}</td>
                  <th scope="row">{entry.pseudonym}</th>
                  <td>{entry.evidenceLevel}</td>
                  <td>{entry.totalWrongGuesses}</td>
                  <td>{entry.elapsedMilliseconds} ms</td>
                  <td>{entry.score}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {entries.length > 0 ? (
        <button
          ref={loadMore}
          type="button"
          disabled={
            state.leaderboardStatus === 'APPENDING' ||
            state.leaderboardNextCursor == null
          }
          onClick={() => safeAction(onLoadMore)}
        >
          {state.leaderboardStatus === 'APPENDING'
            ? 'Loading more…'
            : state.leaderboardNextCursor == null
              ? 'All entries loaded'
              : 'Load more'}
        </button>
      ) : null}
    </section>
  )
}
