import { writeFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import { STORAGE } from './fixtures';

// Flusso pubblico /iscrizione (happy path) + import admin con degrado email
// VISIBILE (provider non configurato). CF/email fissi: il seed ripulisce gli
// artefatti (submission, alunno, parents, account) al run successivo.
const CF_CHILD = 'TSTBNE20A01H501X';
const CF_ADULT = 'TSTDLT80A01H501Y';
const EMAIL_ISCRIZIONE = 'iscrizione.e2e@kidville.test';

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

async function caricaDocumento(page: Page, pngPath: string) {
  await page.locator('input[type="file"]').setInputFiles(pngPath);
  // L'upload sostituisce il testo del campo file con il nome del file.
  await expect(page.getByText('documento.png').first()).toBeVisible({ timeout: 15_000 });
}

test('happy path: la richiesta pubblica viene inviata', async ({ page }, testInfo) => {
  const pngPath = testInfo.outputPath('documento.png');
  writeFileSync(pngPath, PNG_1PX);

  await page.goto('/iscrizione');
  await expect(page.getByText('Iscrizione Nuovo Alunno').first()).toBeVisible();

  // Passo 1 — bambino (soli campi obbligatori).
  await page.getByPlaceholder('Es. Marco').fill('Tino');
  await page.getByPlaceholder('Es. Rossi').fill('Iscrizione-E2E');
  await page.locator('select').selectOption('M');
  await page.locator('input[type="date"]').fill('2021-05-05');
  await page.getByPlaceholder('Es. RSSMRC99A01H501Z').fill(CF_CHILD);
  await caricaDocumento(page, pngPath);
  await page.getByRole('button', { name: 'Avanti' }).click();

  // Passo 2 — adulto di riferimento (email inclusa: serve per le credenziali).
  await expect(page.getByText('Adulto 1 (obbligatorio)')).toBeVisible();
  await page.locator('select').first().selectOption('mother');
  await page.getByPlaceholder('Es. Maria', { exact: true }).fill('Ines');
  await page.getByPlaceholder('Es. Rossi').fill('Iscrizione-E2E');
  await page.getByPlaceholder('Es. RSSMRA75B41F205X').fill(CF_ADULT);
  await page.locator('select').nth(1).selectOption('CI');
  await page.getByPlaceholder('Es. AB1234567').fill('AB1234567');
  await page.getByPlaceholder('Es. maria.rossi@email.it').fill(EMAIL_ISCRIZIONE);
  await caricaDocumento(page, pngPath);
  await page.getByRole('button', { name: 'Avanti' }).click();

  // Riepilogo → invio.
  await expect(page.getByText('Riepilogo')).toBeVisible();
  await expect(page.getByText(/Stai iscrivendo 1 bambino/)).toBeVisible();
  await page.getByRole('button', { name: 'Invia richiesta' }).click();

  await expect(page.getByRole('heading', { name: 'Richiesta inviata!' })).toBeVisible({
    timeout: 15_000,
  });
});

test.describe('import in segreteria', () => {
  test.use({ storageState: STORAGE.admin });

  test('l’import mostra il degrado email visibile', async ({ page }) => {
    await page.goto('/admin/iscrizioni');

    await expect(page.getByText('Iscrizioni Nuovi Alunni')).toBeVisible();
    const richiesta = page.getByText('Tino Iscrizione-E2E').first();
    await expect(richiesta).toBeVisible({ timeout: 15_000 });
    await richiesta.click();

    // L'import esige una classe per bambino: prima sezione disponibile
    // (l'alunno importato viene ripulito dal seed al run successivo).
    await page.locator('select').first().selectOption({ index: 1 });
    await page.getByRole('button', { name: 'Importa nelle anagrafiche' }).click();

    // Esito: import ok + credenziali + degrado email (RESEND non configurato).
    await expect(page.getByText('Iscrizione importata')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/Credenziali:/)).toBeVisible();
    await expect(
      page.getByText('Email non inviata: comunicare le credenziali manualmente.')
    ).toBeVisible();
  });
});
