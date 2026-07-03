import { test, expect } from '@playwright/test';
import { STORAGE } from './fixtures';

// Agenda docente (composer M6.4 su /teacher): creazione evento → il genitore lo vede.
test.use({ storageState: STORAGE.docente });

test('la maestra crea un evento e il genitore lo vede in agenda', async ({ page, browser }) => {
  await page.goto('/teacher');

  // Card agenda della sezione attiva (Girasoli) con l'evento seedato.
  await expect(page.getByText('La giornata in sezione')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Gita al museo E2E')).toBeVisible();

  // Composer: titolo + tipo Riunione, visibile ai genitori (default attivo).
  await page.getByPlaceholder('Titolo (es. Uscita al parco)').fill('Riunione genitori E2E');
  await page.locator('select').selectOption('riunione');
  await expect(page.getByLabel('Visibile ai genitori')).toBeChecked();
  await page.getByRole('button', { name: 'Aggiungi' }).click();

  // L'evento creato compare nella lista della card.
  await expect(page.getByText('Riunione genitori E2E')).toBeVisible();

  // Il genitore (contesto separato con la sua sessione) lo vede nella home.
  const contestoGenitore = await browser.newContext({ storageState: STORAGE.genitore });
  const pagina = await contestoGenitore.newPage();
  await pagina.goto('/parent');
  await expect(pagina.getByText('Prossimi appuntamenti')).toBeVisible({ timeout: 15_000 });
  await expect(pagina.getByText('Riunione genitori E2E')).toBeVisible();
  await contestoGenitore.close();
});
