import { test, expect } from '@playwright/test';
import { STORAGE } from './fixtures';

// Anagrafica generale (/admin/students). NB: la pagina interroga la scuola
// demo hardcoded, quindi le asserzioni sono sul funzionamento (tab, ricerca,
// stati vuoti), non su righe E2E.
test.use({ storageState: STORAGE.admin });

test('anagrafica: lista, ricerca e tab funzionano', async ({ page }) => {
  await page.goto('/admin/students');

  await expect(page.getByText('Anagrafica Generale')).toBeVisible();
  await expect(page.getByText('Totale Alunni')).toBeVisible({ timeout: 20_000 });

  // La tabella ha almeno una riga (anagrafica demo popolata).
  const righe = page.locator('tbody tr');
  await expect(righe.first()).toBeVisible();

  // Ricerca client-side: query impossibile → stato vuoto → reset.
  const ricerca = page.getByPlaceholder('Cerca per nome, cognome o codice fiscale...');
  await ricerca.fill('zzzintrovabile');
  await expect(page.getByText('Nessun alunno trovato')).toBeVisible();
  await ricerca.fill('');
  await expect(righe.first()).toBeVisible();

  // Tab Sezioni e Staff rispondono.
  await page.getByRole('button', { name: 'Sezioni' }).click();
  await expect(page.getByText('Girasoli').first()).toBeVisible();
  await page.getByRole('button', { name: 'Staff' }).click();
  await expect(page.getByRole('heading', { name: 'Anagrafica Generale' })).toBeVisible();
});
