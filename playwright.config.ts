import { defineConfig } from '@playwright/test';

const port = Number(process.env.PLAYWRIGHT_PORT ?? 3000);

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.pw.ts',
  workers: 1,
  fullyParallel: false,
  use: {
    baseURL: `http://localhost:${port}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: `PORT=${port} TEST_APP_ORIGIN=http://localhost:${port} npx tsx tests/browser-server.ts`,
    url: `http://localhost:${port}/health`,
    reuseExistingServer: false,
    timeout: 30000,
  },
  reporter: 'list',
  outputDir: 'test-results',
});
