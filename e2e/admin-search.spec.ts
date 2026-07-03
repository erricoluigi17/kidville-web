import { test, expect } from '@playwright/test';
import { STORAGE } from './fixtures';

// Ricerca globale in TopBar (debounce 300ms, gruppi scoped sulla scuola E2E).
test.use({ storageState: STORAGE.admin });

test('la ricerca trova l’alunna seedata e naviga al click', async ({ page }) => {
  await page.goto('/admin');

  const input = page.getByLabel('Ricerca globale');
  await expect(input).toBeVisible({ timeout: 15_000 });

  await input.fill('Arcobaleno');
  await expect(page.getByText('Alunni', { exact: true })).toBeVisible();
  const risultato = page.getByRole('button', { name: /Aurora Arcobaleno-E2E/ });
  await expect(risultato).toBeVisible();

  await risultato.click();
  await page.waitForURL('**/admin/students**');
});

test('query senza corrispondenze → nessun risultato', async ({ page }) => {
  await page.goto('/admin');

  const input = page.getByLabel('Ricerca globale');
  await input.fill('zzzintrovabile');
  await expect(page.getByText(/Nessun risultato per/)).toBeVisible();
});
