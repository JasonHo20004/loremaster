import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'

const origin = 'http://localhost:8080'
const firstSlot = process.env.LOREMASTER_E2E_FIRST_SLOT!
const secondSlot = process.env.LOREMASTER_E2E_SECOND_SLOT!
const clockFile = process.env.LOREMASTER_E2E_CLOCK_FILE!
const hostileMarker = process.env.LOREMASTER_E2E_HOSTILE_MARKER!
const composePrefix = [
  'compose',
  '-p',
  process.env.LOREMASTER_S8_PROJECT!,
  '-f',
  resolve('deploy/compose/compose.yaml'),
  '-f',
  resolve('deploy/compose/t25.override.yaml'),
]

function compose(...args: string[]): string {
  return execFileSync('docker', [...composePrefix, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
  }).trim()
}

function gameplayCounts(): string {
  return compose(
    'exec',
    '-T',
    'postgres',
    'psql',
    '-X',
    '-At',
    '-v',
    'ON_ERROR_STOP=1',
    '-U',
    'migration',
    '-d',
    'loremaster',
    '-c',
    `SELECT (SELECT count(*) FROM loremaster.attempts)::text || ':' || (SELECT count(*) FROM loremaster.command_receipts)::text;`,
  )
}

async function start(page: Page): Promise<string> {
  const response = page.waitForResponse(
    (item) =>
      item.url().endsWith('/api/v1/cases/current/attempt') &&
      item.request().method() === 'POST',
  )
  await page.getByRole('button', { name: 'Start investigation' }).click()
  const payload = (await (await response).json()) as {
    data: { attempt: { attemptId: string } }
  }
  await expect(
    page.getByRole('heading', { name: 'The investigation is open' }),
  ).toBeVisible()
  return payload.data.attempt.attemptId
}
test.describe.serial('packaged gateway and runtime', () => {
  test('refresh, solve, profile, leaderboard, and second guest isolation', async ({
    browser,
    page,
  }) => {
    await page.goto('/')
    await expect(
      page.getByRole('heading', { name: 'A sealed record awaits' }),
    ).toBeVisible()
    const firstAttempt = await start(page)
    await page.reload()
    await expect(
      page.getByRole('heading', { name: 'The investigation is open' }),
    ).toBeVisible()
    await page.getByRole('button', { name: 'Reveal evidence 1' }).click()
    const search = page.getByRole('combobox', {
      name: 'Search the public entity index',
    })
    await search.fill('Mira')
    await page.getByRole('option', { name: /Mira Vale/u }).click()
    await page.getByRole('button', { name: 'Submit guess' }).click()
    await expect(
      page.getByRole('heading', { name: 'The record is restored' }),
    ).toBeVisible()
    await page.getByRole('link', { name: 'View investigator profile' }).click()
    await expect(
      page.getByRole('heading', { name: 'Your archive record' }),
    ).toBeVisible()
    await page.goto('/leaderboard')
    await expect(
      page.getByRole('heading', { name: `Investigators for ${firstSlot}` }),
    ).toBeVisible()
    await expect(page.getByRole('status')).toHaveText(
      '1 total leaderboard entries loaded.',
    )
    const second = await browser.newContext()
    try {
      const isolated = await second.newPage()
      await isolated.goto('/')
      await expect(
        isolated.getByRole('heading', { name: 'A sealed record awaits' }),
      ).toBeVisible()
      await isolated.goto('/profile')
      await expect(isolated.getByText('No completed cases yet.')).toBeVisible()
      const foreignAttempt = await second.request.get(
        `${origin}/api/v1/attempts/${firstAttempt}`,
      )
      expect(foreignAttempt.status()).toBe(404)
    } finally {
      await second.close()
    }
  })

  test('committed response loss retries one idempotent command', async ({
    page,
  }) => {
    test.setTimeout(120_000)
    await page.goto('/')
    await start(page)
    const keys: string[] = []
    await page.route('**/api/v1/attempts/*/commands', async (route) => {
      keys.push(route.request().headers()['idempotency-key'] ?? '')
      if (keys.length === 1) {
        await route.fetch()
        await route.abort('failed')
      } else await route.continue()
    })
    await page.getByRole('button', { name: 'Reveal evidence 1' }).click()
    await expect(
      page.getByRole('heading', { name: 'Action outcome unknown' }),
    ).toBeVisible()
    await page.getByRole('button', { name: 'Retry same action' }).click()
    await expect(page.getByText('Evidence 1', { exact: true })).toBeVisible()
    expect(keys).toHaveLength(2)
    expect(keys[0]).toBe(keys[1])
    await page.unrouteAll()
    const before = gameplayCounts().split(':').map(Number)
    compose('stop', '-t', '15', 'worker')
    compose('stop', '-t', '15', 'redis')
    try {
      await page.getByRole('button', { name: 'Reveal evidence 2' }).click()
      await expect(page.getByText('Evidence 2', { exact: true })).toBeVisible()
      const after = gameplayCounts().split(':').map(Number)
      expect(after).toEqual([before[0], before[1] + 1])
    } finally {
      compose('start', 'redis')
      compose('start', 'worker')
    }
    await expect
      .poll(
        () => {
          const workerId = compose('ps', '-q', 'worker')
          return JSON.parse(
            execFileSync('docker', ['inspect', workerId], {
              encoding: 'utf8',
            }),
          )[0].State.Health.Status
        },
        { timeout: 30_000 },
      )
      .toBe('healthy')
  })

  test('real PostgreSQL midnight rollover leaves the old attempt and hostile text inert', async ({
    page,
    context,
  }) => {
    await page.goto('/')
    const old = await start(page)
    writeFileSync(clockFile, `@${secondSlot} 00:00:05\n`)
    await expect
      .poll(async () => {
        const response = await context.request.get(
          `${origin}/api/v1/cases/current`,
        )
        const body = await response.text()
        return body.includes(secondSlot)
      })
      .toBe(true)
    await page.reload()
    await expect(
      page.getByRole('heading', { name: 'A sealed record awaits' }),
    ).toBeVisible()
    await expect(page.getByText(`Daily case · ${secondSlot}`)).toBeVisible()
    const previous = await context.request.get(
      `${origin}/api/v1/attempts/${old}`,
    )
    expect(previous.ok()).toBe(true)
    expect((await previous.json()).data.state).toBe('EXPIRED')
    const external: string[] = []
    page.on('request', (request) => {
      if (request.url().includes('loremaster-hostile'))
        external.push(request.url())
    })
    await start(page)
    await expect(page.getByText(hostileMarker, { exact: false })).toBeVisible()
    await expect(
      page.locator('.briefing script, .briefing img, .briefing a'),
    ).toHaveCount(0)
    expect(await page.evaluate(() => '__loremaster_xss' in globalThis)).toBe(
      false,
    )
    expect(external).toEqual([])
    expect(firstSlot).not.toBe(secondSlot)
  })
})
