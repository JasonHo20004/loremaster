import { useEffect, useState, type MouseEvent } from 'react'

import type { ApiClient } from './api/client.js'
import { GameplayExperience } from './gameplay/gameplay.js'
import { routes, viewFromPath, type AppView } from './route'
import type { GameController } from './state/controller.js'

const viewCopy: Record<
  AppView,
  { readonly eyebrow: string; readonly title: string; readonly detail: string }
> = {
  case: {
    eyebrow: 'Daily case',
    title: 'The archive is quiet',
    detail: 'Today’s record will appear here when the archive is ready.',
  },
  profile: {
    eyebrow: 'Investigator profile',
    title: 'No record opened',
    detail: 'Your case history will gather here.',
  },
  leaderboard: {
    eyebrow: 'Daily ledger',
    title: 'The ledger is sealed',
    detail: 'Today’s investigators will be recorded here.',
  },
}

interface AppProps {
  readonly client?: ApiClient
  readonly controller?: GameController
}

export function App({ client, controller }: AppProps = {}): React.JSX.Element {
  const [view, setView] = useState(() => viewFromPath(window.location.pathname))

  useEffect(() => {
    const updateView = (): void =>
      setView(viewFromPath(window.location.pathname))
    window.addEventListener('popstate', updateView)
    return () => window.removeEventListener('popstate', updateView)
  }, [])

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
          <span className="brand-type">
            <span className="brand-subtitle">The Daily Archive</span>
            <span className="brand-name">Loremaster</span>
          </span>
        </a>
        <p className="masthead-note">
          A daily exercise in deduction.
          <br />
          Read closely. Find the connection.
        </p>
        <nav aria-label="Primary navigation">
          <ul>
            {routes.map((route, index) => (
              <li key={route.view}>
                <a
                  href={route.href}
                  aria-current={view === route.view ? 'page' : undefined}
                  onClick={(event) => navigate(event, route.href)}
                >
                  <span className="nav-index" aria-hidden="true">
                    0{index + 1}
                  </span>
                  {route.label}
                  <span className="nav-arrow" aria-hidden="true">
                    ↗
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </header>

      <main id="content" tabIndex={-1}>
        <div className="section-heading" aria-hidden="true">
          <span>{copy.eyebrow}</span>
          <span>
            Loremaster /{' '}
            {view === 'case' ? '01' : view === 'profile' ? '02' : '03'}
          </span>
        </div>
        {view === 'case' && client !== undefined && controller !== undefined ? (
          <GameplayExperience client={client} controller={controller} />
        ) : (
          <section className="archive-card" aria-labelledby="view-title">
            <div className="archive-illustration" aria-hidden="true">
              <svg viewBox="0 0 180 140" fill="none">
                <path d="M43 33V17h63l27 27v58H43Z" />
                <path d="M106 17v27h27M57 56h48M57 67h35" />
                <path
                  className="folder-fill"
                  d="M22 53h49l12 13h75l-13 61H33Z"
                />
                <path d="M22 53h49l12 13h75l-13 61H33ZM48 88h29M48 97h46" />
                <circle cx="125" cy="102" r="12" />
                <path d="M125 96v12M119 102h12" />
              </svg>
            </div>
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
