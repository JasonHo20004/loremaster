import { defineConfig, devices } from '@playwright/test'

const baseURL = process.env.LOREMASTER_E2E_BASE_URL
if (baseURL === undefined) {
  throw new Error('LOREMASTER_E2E_BASE_URL is required')
}

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: 'line',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
