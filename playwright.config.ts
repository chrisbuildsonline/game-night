import { defineConfig, devices } from '@playwright/test';

const PORT = 8701;

export default defineConfig({
  testDir: './e2e',
  outputDir: 'test-results',
  // The server keeps ONE shared game state per game (one household), so tests must run one at a time.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'bun src/server.ts',
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: false,
    timeout: 30_000,
    // :memory: keeps the e2e run away from the real game-night.sqlite; no AWS keys forces the offline fallbacks.
    env: { PORT: String(PORT), GAME_DB: ':memory:', BEDROCK: 'off', GAME_NIGHT_TOKEN: '' },
  },
});
