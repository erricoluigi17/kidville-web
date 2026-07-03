import { test, expect } from '@playwright/test';
import { STORAGE } from './fixtures';

// Bacheca docente (/teacher/avvisi): lista di plesso + pubblicazione
// (consentita al gruppo teacher via avvisi_config della scuola E2E).
test.use({ storageState: STORAGE.docente });

test('bacheca: vede l’avviso seedato e ne pubblica uno nuovo', async ({ page }) => {
  await page.goto('/teacher/avvisi');

  await expect(page.getByRole('heading', { name: 'Bacheca' })).toBeVisible();
  await expect(page.getByText('Avviso E2E: uscita al parco')).toBeVisible({ timeout: 15_000 });

  // Nuovo avviso (presa visione, destinatari Tutti — i default del form).
  await page.getByRole('button', { name: 'Nuovo' }).click();
  await expect(page.getByText('📢 Nuovo Avviso')).toBeVisible();
  await page.getByPlaceholder('Es. Gita al parco').fill('Bacheca E2E: nuovo avviso');
  await page
    .getByPlaceholder("Scrivi il testo dell'avviso...")
    .fill('Contenuto creato dalla suite Playwright.');
  await page.getByRole('button', { name: 'Pubblica Avviso' }).click();

  // Il modal si chiude e la lista ricarica con il nuovo avviso.
  await expect(page.getByText('Bacheca E2E: nuovo avviso')).toBeVisible({ timeout: 15_000 });
});
