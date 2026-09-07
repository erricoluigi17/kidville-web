import { writeFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { STORAGE } from './fixtures';

// Chat genitore↔maestra: nuova conversazione, messaggio, allegato immagine,
// e verifica lato docente. Il seed azzera i thread E2E a ogni run.

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

test.describe('lato genitore', () => {
  test.use({ storageState: STORAGE.genitore });

  test('nuova chat con la maestra: messaggio + allegato', async ({ page }, testInfo) => {
    const pngPath = testInfo.outputPath('allegato.png');
    writeFileSync(pngPath, PNG_1PX);

    await page.goto('/parent/chat');
    await expect(page.getByRole('heading', { name: 'Messaggi' })).toBeVisible({
      timeout: 15_000,
    });

    // Contatto = maestra della sezione della figlia (utenti_sezioni).
    await page.getByRole('button', { name: 'Nuova Chat' }).click();
    const contatto = page.getByText('Dora Docente-E2E').first();
    await expect(contatto).toBeVisible({ timeout: 15_000 });

    // ── E CHI NON DEVE COMPARIRE, NON COMPARE ────────────────────────────────
    //
    // «Quando clicchi su nuova chat, non devono proprio comparire le altre
    // persone.» Fino al 2026-09-07 non era vero: un fallback consegnava al
    // genitore TUTTI i docenti di TUTTE le sedi appena un figlio non aveva
    // sezione — misurato in produzione, 63 nomi di 5 plessi, 9 dei quali
    // disattivati. `Diana Docente2-E2E` insegna in SEDE 2: è la controprova che
    // il filtro c'è, e va PRIMA del click perché dopo la modale si chiude.
    //
    // ⚠️ È un'asserzione NEGATIVA e va guardata con sospetto: passerebbe anche
    // con la modale vuota. Per questo la riga sopra pretende che la maestra
    // GIUSTA sia visibile — le due insieme dicono «queste sì, quelle no».
    await expect(page.getByText('Diana Docente2-E2E')).toHaveCount(0);

    await contatto.click();

    // Messaggio di testo.
    const input = page.getByPlaceholder(/Scrivi un messaggio/).first();
    await expect(input).toBeVisible({ timeout: 15_000 });
    await input.fill('Ciao maestra! Messaggio E2E.');
    await page.getByRole('button', { name: 'Invia messaggio' }).first().click();
    // Il testo compare anche nella preview del thread: basta la prima occorrenza.
    await expect(page.getByText('Ciao maestra! Messaggio E2E.').first()).toBeVisible();

    // Allegato immagine: input file nascosto → chip di anteprima → invio.
    await page.locator('input[type="file"]').first().setInputFiles(pngPath);
    // Chip di anteprima (emoji e nome sono nodi separati: match sul nome).
    await expect(page.getByText('allegato.png').first()).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Invia messaggio' }).first().click();
    // Messaggio-allegato inviato: testo "📎 Allegato" nel thread e <img>
    // dell'immagine nel DOM (il PNG di test 1×1 ha box a dimensione zero,
    // quindi niente toBeVisible sull'immagine stessa).
    await expect(page.getByText('📎 Allegato').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByAltText('Allegato').first()).toBeAttached();
  });
});

test.describe('lato docente', () => {
  test.use({ storageState: STORAGE.docente });

  test('la maestra vede la conversazione e il messaggio', async ({ page }) => {
    await page.goto('/teacher/chat');
    await expect(page.getByText('Messaggi con le famiglie')).toBeVisible({ timeout: 15_000 });

    const thread = page.getByText('Gaia Genitore-E2E').first();
    await expect(thread).toBeVisible({ timeout: 15_000 });
    await thread.click();

    await expect(page.getByText('Ciao maestra! Messaggio E2E.').first()).toBeVisible({
      timeout: 15_000,
    });
  });
});
