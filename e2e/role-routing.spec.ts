import { test, expect } from '@playwright/test';
import { EMAILS, STORAGE, login } from './fixtures';

// M4B: smistamento per ruolo — atterraggio, guardia d'area, picker multi-profilo.

test('login docente atterra su /teacher', async ({ page }) => {
  await login(page, EMAILS.docente);
  await page.waitForURL('**/teacher');
  // Saluto dipendente dall'ora: asserzione tempo-indipendente (client-side).
  await expect(page.getByRole('heading', { level: 1 })).toContainText(/Buongiorno|Buon pomeriggio|Buonasera/);
});

test.describe('docente con sessione attiva', () => {
  test.use({ storageState: STORAGE.docente });

  test('naviga /parent → redirect su /teacher', async ({ page }) => {
    await page.goto('/parent');
    await page.waitForURL('**/teacher');
    // Saluto dipendente dall'ora: asserzione tempo-indipendente (client-side).
    await expect(page.getByRole('heading', { level: 1 })).toContainText(/Buongiorno|Buon pomeriggio|Buonasera/);
  });
});

test('utente con doppio profilo: picker → area scelta', async ({ page }) => {
  await login(page, EMAILS.doppio);

  // Il form viene sostituito in-place dal picker (stessa card, URL invariato).
  const picker = page.getByRole('group', { name: 'Scelta del ruolo' });
  await expect(picker).toBeVisible();
  await expect(picker.getByRole('button', { name: 'Docente' })).toBeVisible();

  await picker.getByRole('button', { name: 'Genitore' }).click();
  await page.waitForURL('**/parent');
  await expect(page.locator('main#content')).toBeVisible();
});
