import { test, expect } from '@playwright/test';
import { IDS, STORAGE } from './fixtures';

// Appello docente (/teacher/attendance, sezione Girasoli): registrazione + persistenza.
test.use({ storageState: STORAGE.docente });

// La CI E2E gira su `next dev` (playwright.config webServer): la pagina appello è il
// PRIMO test a colpire /teacher/attendance + /api/diary/students + /api/attendance/*,
// che compilano a FREDDO. Sotto carico runner questo cold-compile può superare i 30s
// (la pagina resta su "Caricamento alunni da anagrafica…"; i fetch hanno .catch, non
// si impiantano → è solo lentezza di compile). Timeout molto generosi + test-timeout
// esplicito accomodano il cold-compile senza cambiare cosa si asserisce.
const RENDER = 60_000;
const AZIONE = 20_000;

test('appello: registra presente/assente e persiste al reload', async ({ page }) => {
  test.setTimeout(150_000);
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
