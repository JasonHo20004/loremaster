import { defineConfig, devices } from '@playwright/test'

const requestedPort = process.env.LOREMASTER_WEB_TEST_PORT ?? '4173'
if (!/^\d{4,5}$/u.test(requestedPort)) {
  throw new Error('LOREMASTER_WEB_TEST_PORT must be a four or five digit port')
}
const baseURL = `http://127.0.0.1:${requestedPort}`

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  reporter: 'line',
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `node ../../node_modules/typescript/bin/tsc -b && node node_modules/vite/bin/vite.js build && node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port ${requestedPort}`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 60_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
})
