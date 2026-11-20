import type { ReactNode } from 'react'

/*
 * Decorative archive artwork. Every graphic here is aria-hidden; meaning is
 * always carried by adjacent text so nothing depends on the illustration.
 */

export type GlyphName =
  | 'case'
  | 'profile'
  | 'ledger'
  | 'quill'
  | 'folio'
  | 'flame'
  | 'crown'
  | 'seal-check'
  | 'seal-cross'
  | 'target'
  | 'check'
  | 'cross'

const GLYPH_PATHS: Readonly<Record<GlyphName, ReactNode>> = {
  case: (
    <>
      <path d="M6 3.5h8.5L18 7v13.5H6Z" />
      <path d="M14.5 3.5V7H18M8.75 8.5h4M8.75 11h6.5" />
      <circle cx="12" cy="16" r="2.4" />
      <path d="m10.6 18 -1 2.6M13.4 18l1 2.6" />
    </>
  ),
  profile: (
    <>
      <path d="m12 3 7 2.8v5.4c0 4.4-2.9 7.8-7 9.8-4.1-2-7-5.4-7-9.8V5.8Z" />
      <circle cx="12" cy="10" r="2.4" />
      <path d="M8.4 16.2c.8-1.7 2-2.6 3.6-2.6s2.8.9 3.6 2.6" />
    </>
  ),
  ledger: (
    <>
      <path d="M3 5.6c3.1-.9 6.1-.5 9 1.4 2.9-1.9 5.9-2.3 9-1.4v13.2c-3.1-.9-6.1-.5-9 1.4-2.9-1.9-5.9-2.3-9-1.4Z" />
      <path d="M12 7v13.2M6 9.6h3M6 12.6h3M15 9.6h3M15 12.6h3" />
    </>
  ),
  quill: (
    <>
      <path d="M19.5 4.5c-5.8.8-10.1 4.7-12 10.6L6 20" />
      <path d="M19.5 4.5c.4 5.2-2.7 9.5-8.8 10.9M10.4 10.6l2.9 2.9" />
    </>
  ),
  folio: (
    <>
      <path d="M5 4.5h10.5L19 8v11.5H5Z" />
      <path d="M8.5 10.5h7M8.5 13.5h7M8.5 16.5h4.5" />
    </>
  ),
  flame: (
    <>
      <path d="M12 21c-3.9 0-6.5-2.6-6.5-6.1 0-3.2 2.2-5.3 3.6-7.2.5 1.6 1.4 2.6 2.4 3 .1-3.3 1.6-5.9 3.9-7.7-.4 2.9.9 4.9 2.3 6.6 1.3 1.6 1.8 3 1.8 5.1 0 3.6-3 6.3-7.5 6.3Z" />
      <path d="M12 18.4c-1.4 0-2.4-.9-2.4-2.3 0-1.3.9-2.1 1.6-2.9.2.8.7 1.3 1.3 1.5.2-1 .7-1.8 1.4-2.4 0 1.1.6 1.8 1 2.4.3.5.5 1 .5 1.6 0 1.3-1.2 2.1-3.4 2.1Z" />
    </>
  ),
  crown: (
    <>
      <path d="M4.5 18.5h15M5.5 18.5 4 8.5l4.6 3.6L12 5.5l3.4 6.6L20 8.5l-1.5 10" />
      <circle cx="12" cy="14.5" r="1.2" />
    </>
  ),
  'seal-check': (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m8.4 12.3 2.5 2.5 4.8-5.2" />
    </>
  ),
  'seal-cross': (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m9.2 9.2 5.6 5.6M14.8 9.2l-5.6 5.6" />
    </>
  ),
  target: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="4.5" />
      <circle cx="12" cy="12" r="1" />
    </>
  ),
  check: <path d="m5.5 12.5 4 4 9-9.5" />,
  cross: <path d="m6.5 6.5 11 11M17.5 6.5l-11 11" />,
}

interface GlyphProps {
  readonly name: GlyphName
  readonly className?: string
}

export function Glyph({ name, className }: GlyphProps): React.JSX.Element {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {GLYPH_PATHS[name]}
    </svg>
  )
}

/* The Loremaster brand seal is unchanged from the original masthead. */
export function BrandSeal(): React.JSX.Element {
  return (
    <svg
      className="brand-seal"
      viewBox="0 0 64 64"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <path
        className="brand-seal-orbit"
        d="M25 5 8 16v28l17 15m14-54 17 11v28L39 59M4 24v16m56-16v16"
      />
      <path className="brand-seal-shield" d="m32 5 18 15v23L32 58 14 43V20Z" />
      <path
        className="brand-seal-book"
        d="M21.5 25.2c4.1-.5 7.6.8 10.5 3.5 2.9-2.7 6.4-4 10.5-3.5v14.6c-4.1-.5-7.6.8-10.5 3.5-2.9-2.7-6.4-4-10.5-3.5Zm10.5 3.5v14.6"
      />
      <path className="brand-seal-spark" d="m32 12 4 6-4 6-4-6Z" />
      <path
        className="brand-seal-detail"
        d="m19 22 13-11 13 11M19 45l13 10 13-10M25 30l4 2m6 0 4-2M25 35l4 2m6 0 4-2"
      />
    </svg>
  )
}

/* Scalloped wax outline (18 lobes) and its two halves split by a crack. */
const WAX_WHOLE =
  'M85.9 54.7Q91.7 63.9 81.3 67.3Q83.6 77.9 72.7 77.5Q71.3 88.3 61.2 84.2Q56.1 93.8 48 86.5Q39.9 93.8 34.8 84.2Q24.8 88.3 23.3 77.5Q12.4 77.9 14.7 67.3Q4.3 63.9 10.1 54.7Q1.5 48 10.1 41.3Q4.3 32.1 14.7 28.7Q12.4 18.1 23.3 18.5Q24.7 7.7 34.8 11.8Q39.9 2.2 48 9.5Q56.1 2.2 61.2 11.8Q71.3 7.7 72.7 18.5Q83.6 18.1 81.3 28.7Q91.7 32.1 85.9 41.3Q94.5 48 85.9 54.7Z'
const WAX_LEFT =
  'M48 86.5Q39.9 93.8 34.8 84.2Q24.8 88.3 23.3 77.5Q12.4 77.9 14.7 67.3Q4.3 63.9 10.1 54.7Q1.5 48 10.1 41.3Q4.3 32.1 14.7 28.7Q12.4 18.1 23.3 18.5Q24.7 7.7 34.8 11.8Q39.9 2.2 48 9.5L48 18L44.5 27L51.5 37L45 49L52.5 60L46.5 70L48 78Z'
const WAX_RIGHT =
  'M48 9.5Q56.1 2.2 61.2 11.8Q71.3 7.7 72.7 18.5Q83.6 18.1 81.3 28.7Q91.7 32.1 85.9 41.3Q94.5 48 85.9 54.7Q91.7 63.9 81.3 67.2Q83.6 77.9 72.7 77.5Q71.2 88.3 61.2 84.2Q56.1 93.8 48 86.5L48 78L46.5 70L52.5 60L45 49L51.5 37L44.5 27L48 18Z'

export type SealState =
  'sealed' | 'solved' | 'unsolved' | 'quiet' | 'warning' | 'loading'

function WholeSeal({ solved }: { readonly solved: boolean }) {
  return (
    <>
      <circle className="seal-halo" cx="48" cy="48" r="47" />
      <path className="seal-wax" d={WAX_WHOLE} />
      <path className="seal-gloss" d="M24.5 33.5c4.4-8.2 12.6-13.4 22-14" />
      <circle className="seal-ring" cx="48" cy="48" r="27" />
      <circle className="seal-ticks" cx="48" cy="48" r="23.5" />
      {solved ? (
        <path className="seal-glyph" d="m37 48.5 7.5 7.5 15.5-17" />
      ) : (
        <>
          <path className="seal-glyph" d="M48 33 57 48 48 63 39 48Z" />
          <path className="seal-glyph-fill" d="M48 41.5 52 48l-4 6.5-4-6.5Z" />
        </>
      )}
    </>
  )
}

function BrokenSeal() {
  return (
    <>
      <g className="seal-half seal-half-left">
        <path className="seal-wax" d={WAX_LEFT} />
        <path className="seal-gloss" d="M24.5 33.5c4.4-8.2 12.6-13.4 20-14" />
        <path className="seal-ring" d="M47 21a27 27 0 0 0 0 54" />
      </g>
      <g className="seal-half seal-half-right">
        <path className="seal-wax" d={WAX_RIGHT} />
        <path className="seal-ring" d="M49 21a27 27 0 0 1 0 54" />
      </g>
    </>
  )
}

function OpenSeal({ state }: { readonly state: SealState }) {
  return (
    <>
      <circle className="seal-outline" cx="48" cy="48" r="40" />
      <circle className="seal-dashed" cx="48" cy="48" r="32" />
      {state === 'warning' ? (
        <path className="seal-glyph" d="M48 34v17M48 60v.5" />
      ) : state === 'loading' ? (
        <path
          className="seal-glyph seal-spinner"
          d="M48 22a26 26 0 0 1 26 26"
        />
      ) : (
        <path
          className="seal-glyph"
          d="M39 31h18M39 65h18M41 31c0 9 14 10 14 17s-14 8-14 17M55 31c0 9-14 10-14 17s14 8 14 17"
        />
      )}
    </>
  )
}

interface ArchiveSealProps {
  readonly state: SealState
  readonly className?: string
}

export function ArchiveSeal({
  state,
  className,
}: ArchiveSealProps): React.JSX.Element {
  return (
    <svg
      className={
        className === undefined ? 'archive-seal' : `archive-seal ${className}`
      }
      data-state={state}
      viewBox="0 0 96 96"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      {state === 'sealed' || state === 'solved' ? (
        <WholeSeal solved={state === 'solved'} />
      ) : state === 'unsolved' ? (
        <BrokenSeal />
      ) : (
        <OpenSeal state={state} />
      )}
    </svg>
  )
}

export function OrnamentDivider({
  className,
}: {
  readonly className?: string
}): React.JSX.Element {
  return (
    <svg
      className={
        className === undefined
          ? 'ornament-divider'
          : `ornament-divider ${className}`
      }
      viewBox="0 0 240 16"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M6 8h88M146 8h88"
        stroke="currentColor"
        strokeLinecap="round"
        strokeOpacity="0.7"
      />
      <path
        d="m98 8 6-3.5 4.5 3.5-4.5 3.5ZM142 8l-6-3.5-4.5 3.5 4.5 3.5Z"
        fill="currentColor"
        fillOpacity="0.75"
      />
      <path
        d="M120 1.5 126.5 8 120 14.5 113.5 8Z"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <path d="M120 5.2 122.8 8 120 10.8 117.2 8Z" fill="currentColor" />
    </svg>
  )
}
