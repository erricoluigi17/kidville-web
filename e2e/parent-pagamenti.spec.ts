import { test, expect } from '@playwright/test';
import { STORAGE } from './fixtures';

// Pagamenti genitore: riepilogo dovuto + storico con stati.
test.use({ storageState: STORAGE.genitore });

test('lo storico mostra la retta aperta e la gita pagata', async ({ page }) => {
  await page.goto('/parent/pagamenti');

  await expect(page.getByRole('heading', { name: 'Pagamenti' })).toBeVisible();

  // Riepilogo del dovuto (solo la retta da 150 € è aperta).
  await expect(page.getByText('Totale da saldare')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('€ 150,00').first()).toBeVisible();
  await expect(page.getByText('1 voce da saldare')).toBeVisible();

  // Voce aperta: badge "Da pagare", intestata ad Aurora. La descrizione compare
  // in DUE punti (la voce + la «causale consigliata» che inizia con essa) → .first().
  await expect(page.getByText('Retta E2E luglio').first()).toBeVisible();
  await expect(page.getByText('Da pagare', { exact: true })).toBeVisible();
  await expect(page.getByText('Aurora Arcobaleno-E2E').first()).toBeVisible();

  // Voce saldata: badge "Pagato" e link Ricevuta.
  await expect(page.getByText('Gita E2E')).toBeVisible();
  await expect(page.getByText('Pagato', { exact: true })).toBeVisible();
  const ricevuta = page.getByRole('link', { name: 'Ricevuta' });
  await expect(ricevuta).toBeVisible();

  // Il download serve un PDF vero (numerato dove il registro esiste,
  // fallback di cortesia sul DB CI non migrato: mai errore).
  const href = await ricevuta.getAttribute('href');
  const resp = await page.request.get(href!);
  expect(resp.status()).toBe(200);
  expect(resp.headers()['content-type']).toContain('application/pdf');
});
