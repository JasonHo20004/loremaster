import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './app'
import { ErrorBoundary } from './error-boundary'
import { readPublicConfiguration } from './public-config'
import './styles.css'

readPublicConfiguration()

const rootElement = document.querySelector('#root')
if (rootElement === null) throw new Error('Missing application root')

createRoot(rootElement).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
