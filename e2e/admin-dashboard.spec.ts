import { test, expect } from '@playwright/test';
import { STORAGE } from './fixtures';

// Dashboard admin: KPI + card presenze realtime (scope = sola scuola E2E,
// quindi numeri deterministici dal seed: Tulipani 1 presente + 1 assente,
// Girasoli senza appello).
test.use({ storageState: STORAGE.admin });

test('la dashboard mostra i KPI e le presenze realtime seedate', async ({ page }) => {
  await page.goto('/admin');

  await expect(page.getByRole('heading', { name: 'Dashboard Direzione' })).toBeVisible();

  // KPI (i valori arrivano da /api/admin/dashboard; qui contano le tile).
  for (const label of [
    'Alunni iscritti',
    'Incassato nel mese',
    'Iscrizioni in attesa',
    'Prenotazioni mensa oggi',
    'Fatture da emettere',
  ]) {
    await expect(page.getByText(label).first()).toBeVisible({ timeout: 15_000 });
  }
  await expect(page.getByText('Pagamenti scaduti').first()).toBeVisible();

  // Card presenze realtime: aggregato multi-sede scoped sulla scuola E2E.
  await expect(page.getByText('Presenze in tempo reale')).toBeVisible();
  await expect(page.getByText('Live · 60s')).toBeVisible();
  for (const tile of ['Presenti oggi', 'Iscritti', 'Assenti', 'Appelli mancanti']) {
    await expect(page.getByText(tile, { exact: true })).toBeVisible();
  }

  // Sede E2E: 1 presente su 4 iscritti (25%), Girasoli = appello mancante.
  await expect(page.getByText('25%')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('1/4 presenti')).toBeVisible();
  await expect(page.getByText('Kidville E2E').first()).toBeVisible();
  await expect(page.getByText('Appello mancante').first()).toBeVisible();
});
