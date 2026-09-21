import { useEffect, useState, type MouseEvent } from 'react'

import { routes, viewFromPath, type AppView } from './route'

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

export function App(): React.JSX.Element {
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
          <span className="brand-mark" aria-hidden="true">
            <span>LM</span>
          </span>
          <span className="brand-type">
            <span className="brand-name">Loremaster</span>
            <span className="brand-subtitle">The Daily Archive</span>
          </span>
        </a>
        <nav aria-label="Primary navigation">
          <ul>
            {routes.map((route) => (
              <li key={route.view}>
                <a
                  href={route.href}
                  aria-current={view === route.view ? 'page' : undefined}
                  onClick={(event) => navigate(event, route.href)}
                >
                  <span className="nav-rune" aria-hidden="true" />
                  {route.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </header>

      <main id="content" tabIndex={-1}>
        <section className="archive-card" aria-labelledby="view-title">
          <div className="seal" aria-hidden="true">
            <span>?</span>
          </div>
          <div className="card-copy">
            <p className="eyebrow">{copy.eyebrow}</p>
            <h1 id="view-title">{copy.title}</h1>
            <p>{copy.detail}</p>
          </div>
          <div className="status-line" aria-label="Archive status">
            <span className="status-dot" />
            Awaiting archive
          </div>
        </section>
      </main>

      <footer>
        <span className="footer-rule" aria-hidden="true" />
        <p>One case. One day. Records turn over at 00:00 UTC.</p>
      </footer>
    </div>
  )
}
