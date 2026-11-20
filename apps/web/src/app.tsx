import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEvent,
} from 'react'

import type { ApiClient } from './api/client.js'
import { romanNumeral, slotIdForProjection } from './case-format.js'
import { GameplayExperience } from './gameplay/gameplay.js'
import { LeaderboardView } from './leaderboard/leaderboard.js'
import { ProfileView } from './profile/profile.js'
import {
  ReportingController,
  type ReportingState,
} from './reporting/controller.js'
import { routes, viewFromPath, type AppView } from './route'
import type { GameController, GameControllerState } from './state/controller.js'
import { ArchiveSeal, BrandSeal, Glyph, type GlyphName } from './ui/emblems.js'

const navGlyph: Record<AppView, GlyphName> = {
  case: 'case',
  profile: 'profile',
  leaderboard: 'ledger',
}

const viewCopy: Record<
  AppView,
  {
    readonly eyebrow: string
    readonly title: string
    readonly detail: string
    readonly documentTitle: string
  }
> = {
  case: {
    eyebrow: 'Daily case',
    title: 'The archive is quiet',
    detail: 'Today’s record will appear here when the archive is ready.',
    documentTitle: 'Current Case | Loremaster',
  },
  profile: {
    eyebrow: 'Investigator profile',
    title: 'No record opened',
    detail: 'Your case history will gather here.',
    documentTitle: 'Investigator Profile | Loremaster',
  },
  leaderboard: {
    eyebrow: 'Daily ledger',
    title: 'The ledger is sealed',
    detail: 'Today’s investigators will be recorded here.',
    documentTitle: 'Daily Ledger | Loremaster',
  },
}

interface AppProps {
  readonly client?: ApiClient
  readonly controller?: GameController
}

const EMPTY_GAME_STATE: GameControllerState = {
  status: 'IDLE',
  mutationStatus: 'IDLE',
}

const EMPTY_REPORTING_STATE: ReportingState = {
  profileStatus: 'IDLE',
  leaderboardEntries: [],
  leaderboardStatus: 'IDLE',
}

export function App({ client, controller }: AppProps = {}): React.JSX.Element {
  const [view, setView] = useState(() => viewFromPath(window.location.pathname))
  const reporting = useMemo(
    () => (client === undefined ? undefined : new ReportingController(client)),
    [client],
  )
  const gameState = useSyncExternalStore(
    (listener) => controller?.subscribe(listener) ?? (() => undefined),
    () => controller?.state ?? EMPTY_GAME_STATE,
  )
  const reportingState = useSyncExternalStore(
    (listener) => reporting?.subscribe(listener) ?? (() => undefined),
    () => reporting?.state ?? EMPTY_REPORTING_STATE,
  )
  const refreshedTerminal = useRef<string | undefined>(undefined)
  const main = useRef<HTMLElement>(null)
  const previousView = useRef(view)

  useEffect(() => {
    const updateView = (): void =>
      setView(viewFromPath(window.location.pathname))
    window.addEventListener('popstate', updateView)
    return () => window.removeEventListener('popstate', updateView)
  }, [])

  useEffect(() => {
    document.title = viewCopy[view].documentTitle
    if (previousView.current !== view) {
      main.current?.focus()
      previousView.current = view
    }
  }, [view])

  useEffect(() => {
    if (controller === undefined) return
    const detach = controller.attachLifecycle(window, document)
    void controller.initialize()
    return () => {
      detach()
      controller.dispose()
    }
  }, [controller])

  useEffect(() => () => reporting?.dispose(), [reporting])

  const slotId = slotIdForProjection(gameState.currentCase)
  useEffect(() => {
    if (reporting === undefined || gameState.status !== 'READY') return
    if (view === 'profile') void reporting.refreshProfile()
    if (view === 'leaderboard' && slotId !== undefined) {
      void reporting.selectLeaderboardSlot(slotId)
    }
  }, [gameState.status, reporting, slotId, view])

  useEffect(() => {
    const attempt = gameState.displayedAttempt
    if (
      reporting === undefined ||
      attempt === undefined ||
      attempt.state === 'ACTIVE'
    ) {
      return
    }
    const terminalKey = `${attempt.attemptId}:${attempt.version}`
    if (refreshedTerminal.current === terminalKey) return
    refreshedTerminal.current = terminalKey
    const terminalSlotId = slotIdForProjection(attempt)
    if (terminalSlotId !== undefined) {
      reporting.refreshAfterTerminal(terminalSlotId)
    }
  }, [gameState.displayedAttempt, reporting])

  function navigate(event: MouseEvent<HTMLAnchorElement>, href: string): void {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return
    }
    event.preventDefault()
    window.history.pushState(null, '', href)
    setView(viewFromPath(href))
  }

  const copy = viewCopy[view]

  return (
    <div className="app-shell">
      <a className="skip-link" href="#content">
        Skip to content
      </a>
      <header className="site-header">
        <a
          className="brand"
          href="/"
          aria-label="Loremaster home"
          onClick={(event) => navigate(event, '/')}
        >
          <BrandSeal />
          <span className="brand-type">
            <span className="brand-name">Loremaster</span>
            <span className="brand-subtitle">The Daily Archive</span>
          </span>
        </a>
        <p className="masthead-note">
          A daily exercise in deduction.
          <br />
          Read closely. Find the connection.
        </p>
        <nav className="primary-nav" aria-label="Primary navigation">
          <ul>
            {routes.map((route) => (
              <li key={route.view}>
                <a
                  className="nav-tab"
                  href={route.href}
                  aria-current={view === route.view ? 'page' : undefined}
                  onClick={(event) => navigate(event, route.href)}
                >
                  <Glyph name={navGlyph[route.view]} className="nav-glyph" />
                  <span className="nav-label">{route.label}</span>
                  <span className="nav-rune" aria-hidden="true" />
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </header>

      <main ref={main} id="content" tabIndex={-1}>
        <div className="section-heading" aria-hidden="true">
          <span>{copy.eyebrow}</span>
          <span className="section-folio">
            Folio{' '}
            {romanNumeral(routes.findIndex((route) => route.view === view) + 1)}
          </span>
        </div>
        {view === 'case' && client !== undefined && controller !== undefined ? (
          <GameplayExperience
            client={client}
            controller={controller}
            manageControllerLifecycle={false}
            onNewSession={async () => {
              reporting?.reset()
              await controller.initialize(true)
            }}
          />
        ) : view === 'profile' && reporting !== undefined ? (
          <ProfileView
            state={reportingState}
            onRetry={() => reporting.refreshProfile(true)}
          />
        ) : view === 'leaderboard' && reporting !== undefined ? (
          <LeaderboardView
            slotId={slotId}
            state={reportingState}
            onLoadMore={() => reporting.loadMoreLeaderboard()}
            onRetry={() => reporting.refreshLeaderboard()}
          />
        ) : (
          <section className="archive-card" aria-labelledby="view-title">
            <ArchiveSeal state="quiet" className="archive-emblem" />
            <div className="card-copy">
              <p className="eyebrow">{copy.eyebrow}</p>
              <h1 id="view-title">{copy.title}</h1>
              <p>{copy.detail}</p>
            </div>
            <div className="status-line" aria-label="Archive status">
              <span className="status-dot" />
              {view === 'case'
                ? 'Awaiting archive'
                : view === 'profile'
                  ? 'No case history yet'
                  : 'No entries yet'}
            </div>
          </section>
        )}
      </main>

      <footer>
        <p className="footer-name">
          Loremaster <span> / </span> One case. One day.
        </p>
        <p>
          Records turn over at <strong>00:00 UTC</strong>.
        </p>
      </footer>
    </div>
  )
}
