import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './app'
import { ApiClient } from './api/client.js'
import { PendingOperationStore } from './api/pending-operation.js'
import { ErrorBoundary } from './error-boundary'
import { readPublicConfiguration } from './public-config'
import { GameController } from './state/controller.js'
import './styles.css'

const configuration = readPublicConfiguration()
const client = new ApiClient({ apiBaseUrl: configuration.apiBaseUrl })
const controller = new GameController({
  client,
  pendingStore: new PendingOperationStore(window.sessionStorage),
})

const rootElement = document.querySelector('#root')
if (rootElement === null) throw new Error('Missing application root')

createRoot(rootElement).render(
  <StrictMode>
    <ErrorBoundary>
      <App client={client} controller={controller} />
    </ErrorBoundary>
  </StrictMode>,
)
