import { defineConfig, devices } from '@playwright/test';

/**
 * E2E against the local demo stack (APP_MODE=demo, seeded DB).
 * Start infra first: `npm run dev:infra && npm run db:migrate && npm run db:seed`.
 * The config starts API, worker and web unless they are already running.
 */
const env = { ...process.env, NODE_OPTIONS: '' };

export default defineConfig({
  testDir: '.',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: '../../playwright-report' }]],
  outputDir: '../../test-results',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3100',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1366, height: 800 }, ...(process.env.CI ? {} : { channel: 'chrome' }) } }],
  webServer: [
    { command: 'npm run dev -w @crm/api', url: 'http://localhost:4100/ready', reuseExistingServer: true, timeout: 120_000, cwd: '../..', env },
    { command: 'npm run dev -w @crm/worker', url: 'http://localhost:4100/health', reuseExistingServer: true, timeout: 120_000, cwd: '../..', env },
    { command: 'npm run dev -w @crm/web', url: 'http://localhost:3100/login', reuseExistingServer: true, timeout: 180_000, cwd: '../..', env },
  ],
});
