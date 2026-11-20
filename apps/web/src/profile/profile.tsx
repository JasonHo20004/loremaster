import type { ReportingState } from '../reporting/controller.js'
import { Glyph } from '../ui/emblems.js'

interface ProfileViewProps {
  readonly state: ReportingState
  readonly onRetry: () => Promise<void>
}

function safeAction(action: () => Promise<unknown>): void {
  void action().catch(() => undefined)
}

function formatHundredths(value: number): string {
  const digits = value.toString().padStart(3, '0')
  return `${digits.slice(0, -2)}.${digits.slice(-2)}`
}

/** Decorative meter scale for a percentage that is also shown as text. */
function meterScale(percentage: number): string {
  const bounded = Math.min(100, Math.max(0, percentage))
  return `scaleX(${bounded / 100})`
}

export function ProfileView({
  state,
  onRetry,
}: ProfileViewProps): React.JSX.Element {
  if (state.profileStatus === 'IDLE' || state.profileStatus === 'LOADING') {
    return (
      <section className="report-card" aria-labelledby="profile-title">
        <div className="report-intro">
          <p className="eyebrow">Investigator profile</p>
          <h1 id="profile-title">Opening your case history</h1>
        </div>
        <p className="loading-line" role="status">
          Loading profile…
        </p>
      </section>
    )
  }

  if (state.profileStatus === 'ERROR' || state.profile === undefined) {
    return (
      <section className="report-card" aria-labelledby="profile-title">
        <div className="report-intro">
          <p className="eyebrow">Investigator profile</p>
          <h1 id="profile-title">Profile unavailable</h1>
        </div>
        <div className="report-error">
          <p role="alert">
            Your case history could not be read. The current case is unaffected.
          </p>
          <button type="button" onClick={() => safeAction(onRetry)}>
            Try profile again
          </button>
        </div>
      </section>
    )
  }

  const profile = state.profile
  const hasHistory = profile.solvedCount + profile.failedCount > 0
  return (
    <section
      className="report-card report-stack"
      aria-labelledby="profile-title"
    >
      <div className="report-intro">
        <p className="eyebrow">Investigator profile</p>
        <h1 id="profile-title">Your archive record</h1>
        <p className="muted-copy">
          A participation day is a UTC day when you submit at least one guess.
          Starting, revealing, or giving up alone does not count.
        </p>
      </div>

      <dl className="profile-summary">
        <div className="stat stat-feature">
          <dt>
            <Glyph name="flame" />
            Current streak
          </dt>
          <dd>{profile.currentStreak}</dd>
        </div>
        <div className="stat stat-feature">
          <dt>
            <Glyph name="crown" />
            Longest streak
          </dt>
          <dd>{profile.longestStreak}</dd>
        </div>
        <div className="stat">
          <dt>
            <Glyph name="seal-check" />
            Solved
          </dt>
          <dd>{profile.solvedCount}</dd>
        </div>
        <div className="stat">
          <dt>
            <Glyph name="seal-cross" />
            Failed
          </dt>
          <dd>{profile.failedCount}</dd>
        </div>
        <div className="stat">
          <dt>
            <Glyph name="target" />
            Accuracy
          </dt>
          <dd>
            {profile.accuracyPercentage}%
            <span className="stat-meter" aria-hidden="true">
              <span
                style={{
                  transform: meterScale(profile.accuracyPercentage),
                }}
              />
            </span>
          </dd>
        </div>
      </dl>

      {!hasHistory ? (
        <p className="empty-report">No completed cases yet.</p>
      ) : null}

      <section aria-labelledby="regional-title">
        <h2 id="regional-title">Regional knowledge</h2>
        {profile.regionalKnowledge.length === 0 ? (
          <p className="empty-report">No regional observations yet.</p>
        ) : (
          <ul className="regional-list">
            {profile.regionalKnowledge.map((region) => (
              <li key={region.regionId}>
                <strong>{region.regionId}</strong>
                <span className="region-knowledge">
                  {region.displayPercentage}% knowledge
                </span>
                <span className="knowledge-meter" aria-hidden="true">
                  <span
                    style={{
                      transform: meterScale(region.displayPercentage),
                    }}
                  />
                </span>
                <small>
                  {region.sampleCount} observations · α{' '}
                  {formatHundredths(region.alphaHundredths)} · β{' '}
                  {formatHundredths(region.betaHundredths)}
                </small>
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  )
}
