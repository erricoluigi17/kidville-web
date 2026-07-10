import { defineConfig, devices } from '@playwright/test';

// Config ISOLATA del test 360° Primaria: NON usa il globalSetup della suite
// infanzia (niente seed e2e00000). Prerequisiti dati: script seed-primaria-360.mjs
// (già eseguito). Server: riusa il dev server già attivo su :3000.
const BASE = process.env.KV360_BASE || 'http://localhost:3000';

export default defineConfig({
  testDir: __dirname,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  reporter: [['list']],
  use: {
    baseURL: BASE,
    locale: 'it-IT',
    timezoneId: 'Europe/Rome',
    viewport: { width: 1366, height: 900 },
    actionTimeout: 20_000,
    navigationTimeout: 30_000,
  },
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    { name: 'journeys', testMatch: /journeys\/.*\.spec\.ts/, dependencies: ['setup'] },
  ],
  webServer: {
    command: 'npm run dev',
    url: BASE,
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
