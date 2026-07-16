import { test, expect } from '@playwright/test';
import { STORAGE } from './fixtures';

// Bacheca docente (/teacher/avvisi): lista di plesso + pubblicazione
// (consentita al gruppo teacher via avvisi_config della scuola E2E).
test.use({ storageState: STORAGE.docente });

test('bacheca: vede l’avviso seedato e ne pubblica uno per la propria classe', async ({ page }) => {
  await page.goto('/teacher/avvisi');

  await expect(page.getByRole('heading', { name: 'Bacheca' })).toBeVisible();
  await expect(page.getByText('Avviso E2E: uscita al parco')).toBeVisible({ timeout: 15_000 });

  // Nuovo avviso. Come docente (educator) il form è in modalità ristretta:
  // niente destinatario «Tutti», scope forzato a 'classe', la propria classe
  // (Girasoli, da utenti_sezioni) è preselezionata.
  await page.getByRole('button', { name: 'Nuovo' }).click();
  await expect(page.getByText('📢 Nuovo Avviso')).toBeVisible();

  // Il toggle destinatari («Destinatari» / «🌐 Tutti») NON esiste per il docente.
  await expect(page.getByText('Destinatari')).toHaveCount(0);
  await expect(page.getByText('Le tue classi')).toBeVisible();

  await page.getByPlaceholder('Es. Gita al parco').fill('Bacheca E2E: nuovo avviso');
  await page
    .getByPlaceholder("Scrivi il testo dell'avviso...")
    .fill('Contenuto creato dalla suite Playwright.');

  // La classe propria è già selezionata → pubblico direttamente.
  await page.getByRole('button', { name: 'Pubblica Avviso' }).click();

  // Il modal si chiude e la lista ricarica con il nuovo avviso.
  await expect(page.getByText('Bacheca E2E: nuovo avviso')).toBeVisible({ timeout: 15_000 });
});
