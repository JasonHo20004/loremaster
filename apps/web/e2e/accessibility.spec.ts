import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page, type TestInfo } from '@playwright/test'

const ATTEMPT_ID = '00000000-0000-4000-8000-000000000001'
const CLOSES_AT = '2030-01-01T00:00:00.000Z'

const suggestions = [
  {
    entityId: 'harbor-master',
    canonicalName: 'Harbor Master',
    publicRole: 'Keeper of tides',
    aliases: ['Master'],
  },
  {
    entityId: 'night-clerk',
    canonicalName: 'Night Clerk',
    publicRole: 'Keeper of ledgers',
    aliases: ['Clerk'],
  },
]

const activeAttempt = {
  view: 'ATTEMPT',
  state: 'ACTIVE',
  attemptId: ATTEMPT_ID,
  version: 3,
  startedAt: '2029-12-31T00:00:00.000Z',
  closesAt: CLOSES_AT,
  evidenceLevel: 1,
  wrongGuessesAtLevel: 0,
  totalWrongGuesses: 0,
  briefing: 'A sealed transit record has one name out of place.',
  suggestions,
  guessHistory: [],
  evidence: [{ level: 1, text: 'The tide ledger was amended at dusk.' }],
} as const

const terminalAttempt = {
  ...activeAttempt,
  state: 'SOLVED',
  evidenceLevel: 4,
  evidence: [1, 2, 3, 4].map((level) => ({
    level,
    text: `Evidence record ${level}.`,
    explanation: `Explanation for record ${level}.`,
    sourceReferences: [`Archive folio ${level}`],
  })),
  answer: suggestions[0],
} as const

type Projection =
  | typeof activeAttempt
  | typeof terminalAttempt
  | {
      readonly view: 'NOT_STARTED'
      readonly slotId: '2029-12-31'
      readonly opensAt: '2029-12-31T00:00:00.000Z'
      readonly closesAt: typeof CLOSES_AT
    }

async function mockGame(
  page: Page,
  projection: Projection,
  options: { readonly abortStart?: boolean } = {},
): Promise<void> {
  await page.context().addCookies([
    {
      name: 'loremaster_local_csrf',
      value: 'a'.repeat(43),
      domain: '127.0.0.1',
      path: '/',
    },
  ])
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path === '/api/v1/session') {
      await route.fulfill({
        contentType: 'application/json',
        status: 200,
        body: JSON.stringify({ data: { expiresAt: CLOSES_AT } }),
      })
      return
    }
    if (path === '/api/v1/cases/current/attempt') {
      if (options.abortStart) {
        await route.abort('failed')
      } else {
        await route.fulfill({
          contentType: 'application/json',
          status: 200,
          body: JSON.stringify({
            data: {
              outcomeCode: 'STARTED',
              replayed: false,
              attempt: activeAttempt,
            },
          }),
        })
      }
      return
    }
    if (path === '/api/v1/cases/current') {
      await route.fulfill({
        contentType: 'application/json',
        status: 200,
        body: JSON.stringify({ data: projection }),
      })
      return
    }
    if (path === `/api/v1/attempts/${ATTEMPT_ID}`) {
      await route.fulfill({
        contentType: 'application/json',
        status: 200,
        body: JSON.stringify({ data: projection }),
      })
      return
    }
    if (path === '/api/v1/profile') {
      await route.fulfill({
        contentType: 'application/json',
        status: 200,
        body: JSON.stringify({
          data: {
            currentStreak: 2,
            longestStreak: 4,
            solvedCount: 2,
            failedCount: 1,
            accuracyPercentage: 67,
            regionalKnowledge: [
              {
                regionId: 'north-archive',
                alphaHundredths: 270,
                betaHundredths: 330,
                sampleCount: 2,
                displayPercentage: 45,
              },
            ],
          },
        }),
      })
      return
    }
    if (path === '/api/v1/leaderboards/2029-12-31') {
      await route.fulfill({
        contentType: 'application/json',
        status: 200,
        body: JSON.stringify({
          data: {
            items: [
              {
                attemptId: ATTEMPT_ID,
                pseudonym: 'Archive Finch',
                evidenceLevel: 1,
                totalWrongGuesses: 0,
                elapsedMilliseconds: 42000,
                score: 1200,
                rank: 1,
              },
            ],
            nextCursor: null,
          },
        }),
      })
      return
    }
    await route.fulfill({
      contentType: 'application/json',
      status: 200,
      body: JSON.stringify({ data: { items: [] } }),
    })
  })
}

async function expectNoSeriousAxeViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze()
  const violations = results.violations.filter(
    ({ impact }) => impact === 'serious' || impact === 'critical',
  )
  expect(violations).toEqual([])
}

async function capture(page: Page, testInfo: TestInfo, name: string) {
  await page.screenshot({
    fullPage: true,
    path: testInfo.outputPath(`${name}.png`),
  })
}

test('start view is responsive, keyboard reachable, and axe-clean', async ({
  page,
}, testInfo) => {
  await mockGame(page, {
    view: 'NOT_STARTED',
    slotId: '2029-12-31',
    opensAt: '2029-12-31T00:00:00.000Z',
    closesAt: CLOSES_AT,
  })
  await page.setViewportSize({ width: 360, height: 740 })
  await page.goto('/')
  await expect(
    page.getByRole('heading', { name: 'A sealed record awaits' }),
  ).toBeVisible()
  await expectNoSeriousAxeViolations(page)
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true)
  await capture(page, testInfo, 'start-mobile')

  await page.keyboard.press('Tab')
  await expect(
    page.getByRole('link', { name: 'Skip to content' }),
  ).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.locator('main')).toBeFocused()
})

test('active and terminal views survive 200% reflow and reduced motion', async ({
  page,
}, testInfo) => {
  await mockGame(page, activeAttempt)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto('/')
  await expect(
    page.getByRole('heading', { name: 'The investigation is open' }),
  ).toBeVisible()
  await expectNoSeriousAxeViolations(page)
  await capture(page, testInfo, 'active-desktop')
  await page.setViewportSize({ width: 640, height: 520 })
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true)
  const reducedTransition = await page
    .getByRole('button', { name: 'Reveal evidence 2' })
    .evaluate((element) => getComputedStyle(element).transitionDuration)
  expect(Number.parseFloat(reducedTransition)).toBeLessThanOrEqual(0.00001)
  await capture(page, testInfo, 'active-200-percent-reflow')

  await page.unrouteAll({ behavior: 'wait' })
  await mockGame(page, terminalAttempt)
  await page.reload()
  await expect(
    page.getByRole('heading', { name: 'The record is restored' }),
  ).toBeVisible()
  await expectNoSeriousAxeViolations(page)
  await capture(page, testInfo, 'terminal-200-percent-reflow')
})

test('uncertain mutation and forced-colors states remain explicit', async ({
  page,
}, testInfo) => {
  await mockGame(
    page,
    {
      view: 'NOT_STARTED',
      slotId: '2029-12-31',
      opensAt: '2029-12-31T00:00:00.000Z',
      closesAt: CLOSES_AT,
    },
    { abortStart: true },
  )
  await page.goto('/')
  await page.getByRole('button', { name: 'Start investigation' }).click()
  await expect(
    page.getByRole('heading', { name: 'Action outcome unknown' }),
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Retry same action' }),
  ).toBeVisible()
  await expectNoSeriousAxeViolations(page)
  await page.emulateMedia({ forcedColors: 'active' })
  expect(
    await page.evaluate(() => matchMedia('(forced-colors: active)').matches),
  ).toBe(true)
  expect(
    await page
      .getByRole('navigation', { name: 'Primary navigation' })
      .evaluate((element) => getComputedStyle(element).boxShadow),
  ).toBe('none')
  await capture(page, testInfo, 'uncertain-forced-colors')
})

test('profile and ledger reflow without losing information', async ({
  page,
}) => {
  await mockGame(page, {
    view: 'NOT_STARTED',
    slotId: '2029-12-31',
    opensAt: '2029-12-31T00:00:00.000Z',
    closesAt: CLOSES_AT,
  })
  await page.setViewportSize({ width: 360, height: 740 })
  await page.goto('/profile')
  await expect(
    page.getByRole('heading', { name: 'Your archive record' }),
  ).toBeVisible()
  await expect(page.getByText('45% knowledge')).toBeVisible()
  await expectNoSeriousAxeViolations(page)
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true)

  await page.getByRole('link', { name: 'Daily ledger' }).click()
  await expect(
    page.getByRole('heading', { name: 'Investigators for 2029-12-31' }),
  ).toBeVisible()
  await expect(page.getByRole('table')).toBeVisible()
  await expectNoSeriousAxeViolations(page)
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true)
})
