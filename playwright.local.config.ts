import { defineConfig } from '@playwright/test';

const root = 'C:/Users/LENOVO/Documents/GitHub/RONB-Corporate-Championship';
const port = Number(process.env.PLAYWRIGHT_PORT ?? 3000);

// Windows helper config: identical to playwright.config.ts but without the webServer
// block, because that command uses POSIX `PORT=... npx ...` syntax that cmd.exe cannot run.
export default defineConfig({
  testDir: `${root}/tests`,
  testMatch: '**/*.pw.ts',
  workers: 1,
  fullyParallel: false,
  use: {
    baseURL: `http://localhost:${port}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // This machine's Application Control policy blocks chromium_headless_shell's
    // chrome-headless-shell.exe, so headless launches use the full Chromium build.
    launchOptions: {
      executablePath:
        'C:/Users/LENOVO/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe',
    },
  },
  reporter: 'list',
  outputDir: `${root}/test-results`,
});
