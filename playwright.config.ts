import { defineConfig, devices } from '@playwright/test';

const PORT = 3100;
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  // L'harness one-off del test 360° Primaria ha una sua config isolata: va escluso
  // da questa suite (infanzia), altrimenti i suoi spec/auth verrebbero raccolti qui.
  testIgnore: '**/primaria-360/**',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    locale: 'it-IT',
    timezoneId: 'Europe/Rome',
  },
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['setup'],
    },
  ],
  webServer: {
    command: `npm run dev -- --port ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    /**
     * Il logger si spegne da sé sotto vitest (guardia su `process.env.VITEST`, letta al
     * caricamento del modulo), ma Playwright NON è vitest: avvia un vero server Next, in un
     * processo separato, dove quella variabile non esiste. Senza questa riga le 239 route
     * loggherebbero per davvero durante gli E2E, e sono due problemi distinti:
     *
     *  1. RUMORE. Gli spec girano seriali (`workers: 1`) su `next dev` e sono già instabili
     *     sotto carico: quando un E2E è rosso, l'output del server è il primo posto in cui si
     *     guarda — e va tenuto leggibile.
     *  2. SCRITTURE VERE. `KV_LOG_LEVEL=silent` spegne anche la PERSISTENZA su `app_log`
     *     (stessa guardia in `src/lib/logging/app-log.ts`). In locale `.env.local` punta al DB
     *     di PRODUZIONE: una suite E2E che ci scrive dentro righe di log è un incidente, non un
     *     test. In CI il DB è un progetto separato e non migrato — lì `app_log` non esiste
     *     nemmeno, e ogni riga sarebbe un tentativo fallito in più.
     *
     * `'silent'` è il valore ESATTO atteso dalla guardia (confronto stretto, minuscolo):
     * `KV_LOG_LEVEL === 'silent'` in `logger.ts` e in `app-log.ts`. Qualunque altro valore
     * (`'off'`, `'SILENT'`, `'1'`) lascerebbe il logger acceso senza dirlo a nessuno.
     *
     * Playwright FONDE questa mappa sopra `process.env` (`{ ...process.env, ...options.env }`),
     * non la sostituisce: PATH, CI e il resto dell'ambiente restano. E Next non sovrascrive una
     * variabile già presente nel processo con quella di `.env.local`, quindi qui il valore
     * vince — anche se un domani qualcuno mettesse `KV_LOG_LEVEL` nel file.
     */
    env: { KV_LOG_LEVEL: 'silent' },
  },
});
