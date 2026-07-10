import { test, expect } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { PASSWORD, SEGRETERIA, DOCENTI, GENITORI } from '../config/accounts';
import { Recorder, step, wireErrors } from '../lib/harness';

// FEATURE 1A — Logout in TUTTE le aree. Login fresco per area (context usa e getta):
// non tocca gli storageState condivisi dalle altre journey.

async function freshLogin(browser: Browser, email: string, area: RegExp, mobile: boolean): Promise<{ page: Page; close: () => Promise<void> }> {
  const ctx = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1366, height: 900 } });
  const page = await ctx.newPage();
  await page.goto('/auth/login');
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Entra' }).click();
  await expect(page).toHaveURL(area, { timeout: 30000 });
  return { page, close: () => ctx.close() };
}

test('50 · Logout — Segreteria/Direzione (menu account TopBar)', async ({ browser }) => {
  const rec = new Recorder('50-logout', 'segreteria');
  const { page, close } = await freshLogin(browser, SEGRETERIA.email, /\/admin/, false);
  wireErrors(page);
  await step(page, rec, {
    flusso: 'logout-admin', pagina: '/admin', label: 'Segreteria · clic su "Segreteria" (menu account) → Esci',
    atteso: 'Il blocco ruolo apre un menu con "Esci" → redirect /auth/login',
    action: async () => {
      await page.getByRole('button', { name: /Menu account/i }).click();
      await page.waitForTimeout(400);
      await page.getByRole('menuitem', { name: /Esci/i }).click();
      await page.waitForURL(/\/auth\/login/, { timeout: 15000 });
    },
    expect: async () => /\/auth\/login/.test(page.url()),
  });
  await close();
  rec.save();
  expect(rec.findings.length).toBeGreaterThan(0);
});

test('51 · Logout — Docente (menu bottom-sheet)', async ({ browser }) => {
  const rec = new Recorder('51-logout-docente', 'docente');
  const { page, close } = await freshLogin(browser, DOCENTI[0].email, /\/teacher/, true);
  await step(page, rec, {
    flusso: 'logout-docente', pagina: '/teacher', label: 'Docente · Menu → Esci',
    atteso: 'Il menu bottom-sheet contiene "Esci" → redirect /auth/login',
    action: async () => {
      await page.getByRole('button', { name: /Menu · tutte le sezioni/i }).click();
      await page.waitForTimeout(500);
      await page.getByRole('button', { name: /^Esci$/i }).click();
      await page.waitForURL(/\/auth\/login/, { timeout: 15000 });
    },
    expect: async () => /\/auth\/login/.test(page.url()),
  });
  await close();
  rec.save();
});

test('52 · Logout — Genitore (menu bottom-sheet)', async ({ browser }) => {
  const rec = new Recorder('52-logout-genitore', 'genitore');
  const { page, close } = await freshLogin(browser, GENITORI[0].email, /\/parent/, true);
  await step(page, rec, {
    flusso: 'logout-genitore', pagina: '/parent', label: 'Genitore · Menu → Esci',
    atteso: 'Il menu bottom-sheet contiene "Esci" → redirect /auth/login',
    action: async () => {
      await page.getByRole('button', { name: /Menu · tutte le sezioni/i }).click();
      await page.waitForTimeout(500);
      await page.getByRole('button', { name: /^Esci$/i }).click();
      await page.waitForURL(/\/auth\/login/, { timeout: 15000 });
    },
    expect: async () => /\/auth\/login/.test(page.url()),
  });
  await close();
  rec.save();
});
