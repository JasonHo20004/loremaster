import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { page, userEvent } from 'vitest/browser'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { App } from './app'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  window.history.replaceState(null, '', '/')
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('application shell', () => {
  it('renders semantic navigation and the default archive state', async () => {
    await act(async () => root.render(<App />))

    await expect.element(page.getByRole('navigation')).toBeVisible()
    await expect
      .element(page.getByRole('heading', { name: 'The archive is quiet' }))
      .toBeVisible()
    await expect
      .element(page.getByRole('link', { name: 'Current case' }))
      .toHaveAttribute('aria-current', 'page')
  })

  it('moves between views without reloading the document', async () => {
    await act(async () => root.render(<App />))

    await userEvent.click(page.getByRole('link', { name: 'Daily ledger' }))

    await expect
      .element(page.getByRole('heading', { name: 'The ledger is sealed' }))
      .toBeVisible()
    await expect
      .element(page.getByRole('link', { name: 'Daily ledger' }))
      .toHaveAttribute('aria-current', 'page')
    expect(window.location.pathname).toBe('/leaderboard')
  })
})
