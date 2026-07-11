import { test, expect } from '@playwright/test';
import { IDS, STORAGE } from './fixtures';

// Appello docente (/teacher/attendance, sezione Girasoli): registrazione + persistenza.
test.use({ storageState: STORAGE.docente });

// Il roster (fetch alunni) e le transizioni dei bottoni (upsert presenze + refetch)
// possono renderizzarsi in ritardo sotto carico CI: gli elementi compaiono davvero,
// solo lenti. test.slow() (timeout test ×3) + timeout espliciti generosi evitano la
// flakiness di timing senza cambiare cosa si asserisce.
const RENDER = 30_000;
const AZIONE = 20_000;

test('appello: registra presente/assente e persiste al reload', async ({ page }) => {
  test.slow();
  await page.goto('/teacher/attendance');

  await expect(page.getByRole('heading', { name: 'Appello' })).toBeVisible({ timeout: RENDER });
  await expect(page.getByText('Aurora')).toBeVisible({ timeout: RENDER });
  await expect(page.getByText('Bruno')).toBeVisible({ timeout: RENDER });

  // Aurora presente: i 3 bottoni lasciano il posto al badge + azioni uscita.
  await page.locator(`#btn-presente-${IDS.A1}`).click();
  await expect(page.locator(`#btn-checkout-${IDS.A1}`)).toBeVisible({ timeout: AZIONE });

  // Bruno assente.
  await page.locator(`#btn-assente-${IDS.A2}`).click();
  await expect(page.locator(`#btn-presente-${IDS.A2}`)).toHaveCount(0, { timeout: AZIONE });

  // Sezione completa: 2/2 registrati.
  await expect(page.getByText('Completo')).toBeVisible({ timeout: AZIONE });

  // Persistenza reale (upsert su presenze): al reload gli stati restano.
  await page.reload();
  await expect(page.locator(`#btn-checkout-${IDS.A1}`)).toBeVisible({ timeout: RENDER });
  await expect(page.locator(`#btn-presente-${IDS.A2}`)).toHaveCount(0, { timeout: AZIONE });
  await expect(page.getByText('Assente', { exact: true }).first()).toBeVisible({ timeout: AZIONE });
  await expect(page.getByText('Completo')).toBeVisible({ timeout: AZIONE });
});
