import { expect, test } from '@playwright/test'

test('opens the shell and preserves route state on refresh', async ({
  page,
}) => {
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/v1/session') {
      await route.fulfill({
        contentType: 'application/json',
        status: 200,
        body: JSON.stringify({
          data: {
            expiresAt: '2030-01-01T00:00:00.000Z',
          },
        }),
      })
      return
    }
    if (path === '/api/v1/profile') {
      await route.fulfill({
        contentType: 'application/json',
        status: 200,
        body: JSON.stringify({
          data: {
            currentStreak: 0,
            longestStreak: 0,
            solvedCount: 0,
            failedCount: 0,
            accuracyPercentage: 0,
            regionalKnowledge: [],
          },
        }),
      })
      return
    }
    await route.fulfill({
      contentType: 'application/json',
      status: 200,
      body: JSON.stringify({ data: { view: 'NO_CASE' } }),
    })
  })

  await page.goto('/')

  await expect(
    page.getByRole('heading', { name: 'The archive is quiet' }),
  ).toBeVisible()
  await page.getByRole('link', { name: 'Profile' }).click()
  await expect(page).toHaveURL('/profile')
  await expect(
    page.getByRole('heading', { name: 'Your archive record' }),
  ).toBeVisible()
  await expect(page.getByText('No completed cases yet.')).toBeVisible()

  await page.reload()

  await expect(
    page.getByRole('heading', { name: 'Your archive record' }),
  ).toBeVisible()
  await expect(page.getByRole('link', { name: 'Profile' })).toHaveAttribute(
    'aria-current',
    'page',
  )
})
