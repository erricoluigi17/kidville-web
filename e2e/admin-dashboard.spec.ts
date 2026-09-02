import { test, expect } from '@playwright/test';
import { STORAGE } from './fixtures';

// Dashboard admin: KPI + card presenze realtime (scope = sola scuola E2E,
// quindi numeri deterministici dal seed: Tulipani 1 presente + 1 assente,
// Girasoli e Margherite senza appello).
//
// ⚠️ I NUMERI QUI SOTTO DIPENDONO DAL SEED, e il 2026-09-01 sono cambiati.
// La sede 1 aveva 4 alunni iscritti (1/4 = 25%); ora ne ha 5, perché
// `scripts/seed-e2e.mjs` semina anche `A5` — il figlio del profilo doppio, nella
// sezione «Margherite» che suo padre NON insegna. Non è un dettaglio di comodo:
// finché il suo unico figlio stava nella sezione che lui insegna, ogni test sul
// doppio profilo era verde perché il DOCENTE vedeva la propria classe, e non
// poteva diventare rosso nemmeno col gate della famiglia rotto. Il perché per
// esteso sta nel blocco dei legami del seed e in `e2e/doppio-profilo.spec.ts`.
// `B2` (l'altro figlio) sta nella sede 2 e non entra in questo conteggio.
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

  // Sede E2E: 1 presente su 5 iscritti (20%), Girasoli = appello mancante.
  await expect(page.getByText('20%')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('1/5 presenti')).toBeVisible();
  await expect(page.getByText('Kidville E2E').first()).toBeVisible();
  await expect(page.getByText('Appello mancante').first()).toBeVisible();
});
