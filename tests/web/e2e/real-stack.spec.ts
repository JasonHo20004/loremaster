import { expect, test, type BrowserContext, type Page } from '@playwright/test'

const apiOrigin = process.env.LOREMASTER_E2E_API_ORIGIN!
const controlOrigin = process.env.LOREMASTER_E2E_CONTROL_ORIGIN!
const controlToken = process.env.LOREMASTER_E2E_CONTROL_TOKEN!
const firstSlot = process.env.LOREMASTER_E2E_FIRST_SLOT!
const secondSlot = process.env.LOREMASTER_E2E_SECOND_SLOT!
const hostileMarker = process.env.LOREMASTER_E2E_HOSTILE_MARKER!
const rawHostileMarker = process.env.LOREMASTER_E2E_RAW_HOSTILE_MARKER!

async function control(path: string): Promise<void> {
  const response = await fetch(`${controlOrigin}/__e2e/${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${controlToken}` },
  })
  expect(response.ok).toBe(true)
}

async function csrf(context: BrowserContext): Promise<string> {
  const cookie = (await context.cookies(apiOrigin)).find(
    ({ name }) => name === 'loremaster_local_csrf',
  )
  expect(cookie).toBeDefined()
  return cookie!.value
}

async function start(page: Page): Promise<string> {
  const responsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/v1/cases/current/attempt') &&
      response.request().method() === 'POST',
  )
  await page.getByRole('button', { name: 'Start investigation' }).click()
  const payload = (await (await responsePromise).json()) as {
    data: { attempt: { attemptId: string } }
  }
  await expect(
    page.getByRole('heading', { name: 'The investigation is open' }),
  ).toBeVisible()
  await expect(
    page.getByRole('heading', { name: 'The investigation is open' }),
  ).toBeFocused()
  return payload.data.attempt.attemptId
}

async function chooseMira(page: Page): Promise<void> {
  const combobox = page.getByRole('combobox', {
    name: 'Search the public entity index',
  })
  await combobox.fill('Mira')
  await page.getByRole('option', { name: /Mira Vale/u }).click()
  await page.getByRole('button', { name: 'Submit guess' }).click()
}

test.describe.serial('S6.7 composed browser acceptance', () => {
  test('bootstraps, starts explicitly, preserves refresh, solves, and isolates contexts', async ({
    browser,
    page,
  }) => {
    await page.goto('/')
    await expect(
      page.getByRole('heading', { name: 'A sealed record awaits' }),
    ).toBeVisible()
    expect(await page.context().cookies(apiOrigin)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'loremaster_local_session' }),
        expect.objectContaining({ name: 'loremaster_local_csrf' }),
      ]),
    )

    await start(page)
    await page.reload()
    await expect(
      page.getByRole('heading', { name: 'The investigation is open' }),
    ).toBeVisible()
    await page.getByRole('button', { name: 'Reveal evidence 1' }).click()
    await expect(page.getByText('Evidence 1', { exact: true })).toBeVisible()
    await chooseMira(page)
    await expect(
      page.getByRole('heading', { name: 'The record is restored' }),
    ).toBeVisible()
    await expect(
      page.getByRole('heading', { name: 'The record is restored' }),
    ).toBeFocused()
    await expect(page.getByRole('heading', { name: 'Mira Vale' })).toBeVisible()

    await page.getByRole('link', { name: 'View investigator profile' }).click()
    await expect(page.getByText('1', { exact: true }).first()).toBeVisible()
    await page.reload()
    await expect(
      page.getByRole('heading', { name: 'Your archive record' }),
    ).toBeVisible()

    const isolated = await browser.newContext()
    const isolatedPage = await isolated.newPage()
    await isolatedPage.goto('/')
    await expect(
      isolatedPage.getByRole('heading', { name: 'A sealed record awaits' }),
    ).toBeVisible()
    await isolatedPage.goto('/profile')
    await expect(
      isolatedPage.getByText('No completed cases yet.'),
    ).toBeVisible()
    await isolated.close()
  })

  test('reuses idempotency keys and reconciles a committed response loss', async ({
    page,
  }) => {
    await page.goto('/')
    const keys: string[] = []
    let loseRequest = true
    await page.route('**/api/v1/cases/current/attempt', async (route) => {
      keys.push(route.request().headers()['idempotency-key'] ?? '')
      if (loseRequest) {
        loseRequest = false
        await route.abort('failed')
      } else {
        await route.continue()
      }
    })
    await page.getByRole('button', { name: 'Start investigation' }).click()
    await expect(
      page.getByRole('heading', { name: 'Action outcome unknown' }),
    ).toBeVisible()
    await expect(
      page.getByRole('heading', { name: 'Action outcome unknown' }),
    ).toBeFocused()
    await page.reload()
    await expect(
      page.getByRole('heading', { name: 'Action outcome unknown' }),
    ).toBeVisible()
    await page.getByRole('button', { name: 'Retry same action' }).click()
    await expect(
      page.getByRole('heading', { name: 'The investigation is open' }),
    ).toBeVisible()
    expect(keys).toHaveLength(2)
    expect(keys[1]).toBe(keys[0])

    await page.unroute('**/api/v1/cases/current/attempt')
    let releaseDelayedResponse = () => undefined
    await page.route(
      '**/api/v1/attempts/*/commands',
      async (route) => {
        await new Promise<void>((resolve) => {
          releaseDelayedResponse = resolve
        })
        await route.continue()
      },
      { times: 1 },
    )
    await page.getByRole('button', { name: 'Reveal evidence 1' }).click()
    await expect(page.getByRole('status')).toHaveText('Recording your action…')
    await expect(
      page.getByRole('button', { name: 'Submit guess' }),
    ).toBeDisabled()
    releaseDelayedResponse()
    await expect(page.getByText('Evidence 1', { exact: true })).toBeVisible()

    const committedKeys: string[] = []
    await page.route('**/api/v1/attempts/*/commands', async (route) => {
      committedKeys.push(route.request().headers()['idempotency-key'] ?? '')
      if (committedKeys.length === 1) {
        await route.fetch()
        await route.abort('failed')
      } else {
        await route.continue()
      }
    })
    await page.getByRole('button', { name: 'Reveal evidence 2' }).click()
    await expect(
      page.getByRole('heading', { name: 'Action outcome unknown' }),
    ).toBeVisible()
    await page.getByRole('button', { name: 'Retry same action' }).click()
    await expect(page.getByText('Evidence 2', { exact: true })).toBeVisible()
    await expect(page.getByText('Evidence 3', { exact: true })).toHaveCount(0)
    await expect(
      page.getByRole('button', { name: 'Reveal evidence 3' }),
    ).toBeVisible()
    expect(committedKeys).toHaveLength(2)
    expect(committedKeys[1]).toBe(committedKeys[0])
    await page.reload()
    await expect(page.getByText('Evidence 2', { exact: true })).toBeVisible()
    await expect(
      page.getByRole('heading', { name: 'Action outcome unknown' }),
    ).toHaveCount(0)
    expect(committedKeys[0]).toMatch(/^[0-9a-f-]{36}$/u)
  })

  test('shows stale-state recovery and paginates the real leaderboard', async ({
    context,
    page,
  }) => {
    await page.goto('/')
    const attemptId = await start(page)
    const direct = await context.request.post(
      `${apiOrigin}/api/v1/attempts/${attemptId}/commands`,
      {
        headers: {
          Origin: process.env.LOREMASTER_E2E_BASE_URL!,
          'Content-Type': 'application/json',
          'X-CSRF-Token': await csrf(context),
          'Idempotency-Key': crypto.randomUUID(),
        },
        data: { expectedVersion: 0, command: { kind: 'REVEAL' } },
      },
    )
    expect(direct.ok()).toBe(true)
    await page.getByRole('button', { name: 'Reveal evidence 1' }).click()
    await expect(page.getByText(/The case changed elsewhere/u)).toBeVisible()
    await expect(page.getByText('Evidence 1', { exact: true })).toBeVisible()

    await control('seed-leaderboard')
    await page.goto('/leaderboard')
    await expect(page.getByRole('row')).toHaveCount(26)
    await expect(page.getByRole('status')).toHaveText(
      '25 total leaderboard entries loaded.',
    )
    await page.getByRole('button', { name: 'Load more' }).click()
    await expect(page.getByRole('row')).toHaveCount(27)
    await expect(page.getByRole('status')).toHaveText(
      '26 total leaderboard entries loaded.',
    )
  })

  test('rolls over deterministically, preserves the old attempt, and renders hostile text inert', async ({
    context,
    page,
  }) => {
    const hostileRequests: string[] = []
    page.on('request', (request) => {
      if (request.url().includes('loremaster-hostile')) {
        hostileRequests.push(request.url())
      }
    })
    await page.goto('/')
    const oldAttemptId = await start(page)
    await control('inject-hostile')
    await control('rollover')
    await page.reload()
    await expect(
      page.getByRole('heading', { name: 'A sealed record awaits' }),
    ).toBeVisible()
    await expect(page.getByText(`Daily case · ${secondSlot}`)).toBeVisible()

    const oldAttempt = await context.request.get(
      `${apiOrigin}/api/v1/attempts/${oldAttemptId}`,
      { headers: { Origin: process.env.LOREMASTER_E2E_BASE_URL! } },
    )
    expect(oldAttempt.ok()).toBe(true)
    expect((await oldAttempt.json()).data.state).toBe('EXPIRED')

    await start(page)
    await expect(page.getByText(hostileMarker, { exact: false })).toBeVisible()
    await expect(
      page.getByText(rawHostileMarker, { exact: false }),
    ).toBeVisible()
    await expect(
      page.locator('.briefing script, .briefing img, .briefing a'),
    ).toHaveCount(0)
    expect(await page.evaluate(() => '__loremaster_xss' in globalThis)).toBe(
      false,
    )
    expect(hostileRequests).toEqual([])

    await control('expire-sessions')
    await page.getByRole('button', { name: 'Reveal evidence 1' }).click()
    await expect(
      page.getByRole('heading', { name: 'This identity cannot be recovered' }),
    ).toBeVisible()
    expect(firstSlot).not.toBe(secondSlot)
  })
})
