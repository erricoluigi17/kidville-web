import { test, expect } from '@playwright/test';
import { IDS, STORAGE } from './fixtures';

// Appello docente (/teacher/attendance, sezione Girasoli): registrazione + persistenza.
test.use({ storageState: STORAGE.docente });

test('appello: registra presente/assente e persiste al reload', async ({ page }) => {
  await page.goto('/teacher/attendance');

  await expect(page.getByRole('heading', { name: 'Appello' })).toBeVisible();
  await expect(page.getByText('Aurora')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Bruno')).toBeVisible();

  // Aurora presente: i 3 bottoni lasciano il posto al badge + azioni uscita.
  await page.locator(`#btn-presente-${IDS.A1}`).click();
  await expect(page.locator(`#btn-checkout-${IDS.A1}`)).toBeVisible();

  // Bruno assente.
  await page.locator(`#btn-assente-${IDS.A2}`).click();
  await expect(page.locator(`#btn-presente-${IDS.A2}`)).toHaveCount(0);

  // Sezione completa: 2/2 registrati.
  await expect(page.getByText('Completo')).toBeVisible();

  // Persistenza reale (upsert su presenze): al reload gli stati restano.
  await page.reload();
  await expect(page.locator(`#btn-checkout-${IDS.A1}`)).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(`#btn-presente-${IDS.A2}`)).toHaveCount(0);
  await expect(page.getByText('Assente', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Completo')).toBeVisible();
});
