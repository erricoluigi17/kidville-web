import fs from 'node:fs';
import { test as setup, expect } from '@playwright/test';
import { ALL_ACCOUNTS, PASSWORD, AUTH_DIR, storagePath, idsPath } from './config/accounts';

// Login UI reale per i 16 account di test (sessione Supabase via cookie +
// identità applicativa in localStorage). Salva storageState per riuso e
// risolve l'appId (da /api/me) per il deep-link ?userId= sulle pagine profonde.

setup('login account TEST 1A (26 personas)', async ({ browser }) => {
  setup.setTimeout(360_000); // 26 login reali sequenziali
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  const ids: Record<string, string> = {};

  for (const acc of ALL_ACCOUNTS) {
    const ctx = await browser.newContext({ locale: 'it-IT', timezoneId: 'Europe/Rome' });
    const page = await ctx.newPage();
    await page.goto('/auth/login');
    await page.locator('#email').fill(acc.email);
    await page.locator('#password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Entra' }).click();

    // Profilo singolo per tutti gli account di test → nessun picker; attende il landing.
    await expect(page).toHaveURL(acc.landing, { timeout: 30_000 });

    // appId applicativo (utenti.id / parents.id) per il deep-link ?userId=.
    const me = await page.evaluate(async () => {
      try { const r = await fetch('/api/me'); return r.ok ? await r.json() : null; } catch { return null; }
    });
    if (me?.id) ids[acc.key] = String(me.id);

    await ctx.storageState({ path: storagePath(acc.key) });
    await ctx.close();
    // eslint-disable-next-line no-console
    console.log(`  ✓ login ${acc.key} (${acc.email})${me?.id ? ' appId ' + String(me.id).slice(0, 8) : ''}`);
  }

  fs.writeFileSync(idsPath, JSON.stringify(ids, null, 2));
  expect(Object.keys(ids).length).toBeGreaterThanOrEqual(10);
});
