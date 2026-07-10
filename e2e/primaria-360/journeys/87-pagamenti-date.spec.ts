import { test, expect } from '@playwright/test';
import { storagePath } from '../config/accounts';
import { readAppIds, withUser } from '../lib/harness';

// FASE 4 — i18n date nei PAGAMENTI genitore: la scadenza è resa in it-IT
// (gg/mm/aaaa) tramite isoToIt, mai in ISO grezzo (yyyy-mm-dd).
// genitore1 (Alunno1) ha una "Ricarica mensa" con scadenza 2026-07-07.

test.describe('FASE 4 — date pagamenti localizzate', () => {
  test.use({ storageState: storagePath('genitore1') });

  test('/parent/pagamenti mostra la scadenza in gg/mm/aaaa, non in ISO', async ({ page }) => {
    const uid = readAppIds()['genitore1'];
    await page.goto(withUser('/parent/pagamenti', uid), { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500); // caricamento pagamenti

    const body = (await page.textContent('body')) ?? '';
    // Deve comparire la scadenza localizzata e MAI il formato ISO grezzo.
    expect(body, 'scadenza non localizzata a gg/mm/aaaa').toContain('07/07/2026');
    expect(body, 'scadenza ancora in ISO grezzo').not.toContain('2026-07-07');
  });
});
