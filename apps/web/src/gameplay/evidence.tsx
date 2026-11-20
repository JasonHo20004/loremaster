import type { ReactNode } from 'react'

import { romanNumeral } from '../case-format.js'

interface EvidenceEntryProps {
  readonly level: number
  readonly text: string
  readonly children?: ReactNode
}

/** One journal entry. The numeral marker is decorative; the label is text. */
export function EvidenceEntry({
  level,
  text,
  children,
}: EvidenceEntryProps): React.JSX.Element {
  return (
    <li className="evidence-entry">
      <span className="evidence-marker" aria-hidden="true">
        {romanNumeral(level)}
      </span>
      <div className="evidence-body">
        <h3 className="evidence-label">Evidence {level}</h3>
        <p className="evidence-clue">{text}</p>
        {children}
      </div>
    </li>
  )
}

interface PipsProps {
  readonly filled: number
  readonly total: number
  readonly tone?: 'wrong'
}

/** Rune pips mirror a counter that is already present as text. */
export function Pips({ filled, total, tone }: PipsProps): React.JSX.Element {
  return (
    <span
      className={tone === 'wrong' ? 'pips pips-wrong' : 'pips'}
      aria-hidden="true"
    >
      {Array.from({ length: total }, (_, index) => (
        <span key={index} className="pip" data-on={index < filled} />
      ))}
    </span>
  )
}
