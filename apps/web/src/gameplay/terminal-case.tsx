import { useEffect, useRef } from 'react'

import { formatSlotDate, slotIdForProjection } from '../case-format.js'
import type { AttemptProjection } from '../state/controller.js'
import { ArchiveSeal, Glyph, OrnamentDivider } from '../ui/emblems.js'
import { EvidenceEntry } from './evidence.js'

type TerminalAttempt = Exclude<AttemptProjection, { readonly state: 'ACTIVE' }>

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

export function TerminalCase({
  attempt,
}: {
  readonly attempt: TerminalAttempt
}): React.JSX.Element {
  const copy = TERMINAL_COPY[attempt.state]
  const solved = attempt.state === 'SOLVED'
  const slotId = slotIdForProjection(attempt)
  const terminalHeading = useRef<HTMLHeadingElement>(null)
  useEffect(() => terminalHeading.current?.focus(), [])
  return (
    <article
      className="gameplay terminal-case"
      data-outcome={solved ? 'solved' : 'unsolved'}
      aria-labelledby="view-title"
    >
      <header className="case-heading result-heading">
        <ArchiveSeal
          state={solved ? 'solved' : 'unsolved'}
          className="result-seal"
        />
        <p className="eyebrow">
          <Glyph name={solved ? 'seal-check' : 'seal-cross'} />
          {copy.eyebrow}
        </p>
        <h1 ref={terminalHeading} id="view-title" tabIndex={-1}>
          {copy.title}
        </h1>
        <p className="result-detail">{copy.detail}</p>
        {slotId === undefined ? null : (
          <p className="case-meta">
            Daily case of{' '}
            <time dateTime={slotId}>{formatSlotDate(slotId)}</time>
          </p>
        )}
      </header>
      <section className="answer-reveal" aria-labelledby="answer-title">
        <p className="eyebrow">Archive answer</p>
        <h2 id="answer-title" className="answer-name">
          {attempt.answer.canonicalName}
        </h2>
        <OrnamentDivider className="answer-divider" />
        <p className="answer-role">{attempt.answer.publicRole}</p>
      </section>
      <dl className="case-summary">
        <div>
          <dt>Evidence revealed</dt>
          <dd>{attempt.evidenceLevel} of 4</dd>
        </div>
        <div>
          <dt>Wrong guesses</dt>
          <dd>{attempt.totalWrongGuesses}</dd>
        </div>
      </dl>
      <section
        className="evidence-record"
        aria-labelledby="complete-evidence-title"
      >
        <h2 id="complete-evidence-title">Complete evidence record</h2>
        <ol className="evidence-list terminal-evidence">
          {attempt.evidence.map((evidence) => (
            <EvidenceEntry
              key={evidence.level}
              level={evidence.level}
              text={evidence.text}
            >
              <div className="evidence-deduction">
                <h4 className="evidence-subhead">
                  <Glyph name="quill" />
                  Deduction
                </h4>
                <p>{evidence.explanation}</p>
              </div>
              <div className="evidence-sources">
                <h4 className="evidence-subhead">
                  <Glyph name="folio" />
                  {evidence.sourceReferences.length === 1
                    ? 'Archive source'
                    : 'Archive sources'}
                </h4>
                <ul>
                  {evidence.sourceReferences.map((source, index) => (
                    <li key={`${evidence.level}-${index}`}>{source}</li>
                  ))}
                </ul>
              </div>
            </EvidenceEntry>
          ))}
        </ol>
      </section>
      <nav className="reporting-links" aria-label="Case reporting">
        <a href="/profile">
          <Glyph name="profile" />
          View investigator profile
        </a>
        <a href="/leaderboard">
          <Glyph name="ledger" />
          View daily ledger
        </a>
      </nav>
    </article>
  )
}
