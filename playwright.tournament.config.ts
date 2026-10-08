import { defineConfig } from '@playwright/test';
const port = Number(process.env.TOURNAMENT_TEST_PORT ?? 3015);
export default defineConfig({
  testDir: './tests',
  testMatch: 'tournament.e2e.ts',
  workers: 1,
  timeout: 240000,
  use: {
    baseURL: `http://localhost:${port}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: `PORT=${port} TEST_APP_ORIGIN=http://localhost:${port} npx tsx tests/tournament-browser-server.ts`,
    url: `http://localhost:${port}/health`,
    reuseExistingServer: false,
    timeout: 30000,
  },
  reporter: [['list'], ['json', { outputFile: 'playwright-report/tournament-report.json' }]],
  outputDir: 'playwright-report/tournament-results',
});
