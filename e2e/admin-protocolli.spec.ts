import { test, expect } from '@playwright/test';
import { STORAGE } from './fixtures';

// Registro protocolli (spec 2026-07-12): la pagina deve rendere shell, KPI,
// filtri e stato della lista anche sul DB CI NON migrato (tabelle protocolli
// assenti → l'API degrada con `nonMigrato` e la pagina mostra l'empty-state
// dedicato). Mai crash, mai errore a schermo.
test.use({ storageState: STORAGE.admin });

test('il registro protocolli rende KPI, azioni e lista senza crash', async ({ page }) => {
  await page.goto('/admin/protocolli');
  await expect(page.getByRole('heading', { name: 'Registro protocolli' })).toBeVisible();

  // KPI (StatCard)
  for (const label of ['In arrivo', 'In partenza', 'Ultimo numero']) {
    await expect(page.getByText(label, { exact: true }).first()).toBeVisible({ timeout: 15_000 });
  }

  // Azioni principali sempre presenti
  await expect(page.getByRole('button', { name: /Protocolla documento/i })).toBeVisible();
  await expect(page.getByRole('button', { name: /Genera documento/i })).toBeVisible();

  // Lista: empty-state ("Nessuna registrazione" su DB vuoto, "Registro non
  // ancora attivo" su DB CI non migrato) oppure la tabella con le colonne.
  const listaOk = page
    .getByText(/Nessuna registrazione|Registro non ancora attivo/)
    .or(page.getByRole('cell', { name: /^0{0,6}\d+\/\d{4}$/ }));
  await expect(listaOk.first()).toBeVisible({ timeout: 15_000 });
});
