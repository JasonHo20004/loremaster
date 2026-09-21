import { expect, test } from '@playwright/test'

test('opens the shell and preserves route state on refresh', async ({
  page,
}) => {
  await page.goto('/')

  await expect(
    page.getByRole('heading', { name: 'The archive is quiet' }),
  ).toBeVisible()
  await page.getByRole('link', { name: 'Profile' }).click()
  await expect(page).toHaveURL('/profile')
  await expect(
    page.getByRole('heading', { name: 'No record opened' }),
  ).toBeVisible()

  await page.reload()

  await expect(
    page.getByRole('heading', { name: 'No record opened' }),
  ).toBeVisible()
  await expect(page.getByRole('link', { name: 'Profile' })).toHaveAttribute(
    'aria-current',
    'page',
  )
})
