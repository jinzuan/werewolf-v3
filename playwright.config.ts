import { defineConfig, devices } from 'playwright/test';

export default defineConfig({
  testDir: './e2e',
  forbidOnly: true,
  timeout: 120_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  reporter: 'list',
  use: {
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
  },
});
