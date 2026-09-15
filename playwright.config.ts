import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.pw.ts',
  workers: 1,
  fullyParallel: false,
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npx tsx tests/browser-server.ts',
    url: 'http://localhost:3000/health',
    reuseExistingServer: false,
    timeout: 30000,
  },
  reporter: 'list',
  outputDir: 'test-results',
});
