import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  testMatch: 'offline-release.spec.ts',
  workers: 1,
  timeout: 180000,
  expect: { timeout: 30000 },
  use: { baseURL: 'http://127.0.0.1:4174', trace: 'retain-on-failure' },
  webServer: {
    command: 'PORT=4174 BASE_PATH=/ pnpm run serve',
    url: 'http://127.0.0.1:4174',
    reuseExistingServer: false,
    timeout: 30000,
  },
});