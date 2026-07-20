import { test, expect } from '@playwright/test';
import { STORAGE } from './fixtures';

// Sezione «News» del cockpit admin (branch feat/news): cockpit a 5 viste
// (Elenco | Editor | Proposte | Categorie | Digest), deep-linkabili via ?vista=.
// Il DB E2E della CI NON è migrato → le route news rispondono {disponibile:false}
// e i pannelli mostrano il proprio empty-state («Le News non sono ancora
// disponibili…»): qui si verifica che rendano quello stato, MAI un crash.
test.use({ storageState: STORAGE.admin });

test('il cockpit News rende testata e le 5 viste sono deep-linkabili (degrado grazioso)', async ({ page }) => {
  const erroriPagina: string[] = [];
  page.on('pageerror', (err) => erroriPagina.push(err.message));

  await page.goto('/admin/news');
  await expect(page.getByRole('heading', { name: 'News' }).first()).toBeVisible({ timeout: 15_000 });

  // Le viste si aprono da URL (la nav vive nella pagina). Ogni pannello rende o
  // il proprio contenuto o l'empty-state di degrado, senza eccezioni JS.
  const nonDisponibile = page.getByText(/non sono ancora disponibili/i);

  await page.goto('/admin/news?vista=elenco');
  await expect(page.getByRole('heading', { name: 'News' }).first()).toBeVisible({ timeout: 15_000 });

  await page.goto('/admin/news?vista=categorie');
  // Categorie: o l'input «Nuova categoria», o l'empty-state di degrado.
  const inputCategoria = page.getByLabel(/Nuova categoria/i);
  await expect(inputCategoria.or(nonDisponibile).first()).toBeVisible({ timeout: 15_000 });

  await page.goto('/admin/news?vista=digest');
  await expect(page.getByText(/Genera \/ invia un digest/i).or(nonDisponibile).first()).toBeVisible({ timeout: 15_000 });

  await page.goto('/admin/news?vista=proposte');
  await expect(page.getByText(/Nessuna proposta in attesa/i).or(nonDisponibile).first()).toBeVisible({ timeout: 15_000 });

  expect(erroriPagina).toEqual([]);
});

test("l'editor rende il form e degrada con grazia al salvataggio", async ({ page }) => {
  const erroriPagina: string[] = [];
  page.on('pageerror', (err) => erroriPagina.push(err.message));

  await page.goto('/admin/news?vista=editor');

  // Il form dell'editor c'è (il campo Titolo è sempre presente, indipendente dal DB).
  const titolo = page.getByLabel('Titolo');
  await expect(titolo).toBeVisible({ timeout: 15_000 });
  await titolo.fill('Bozza di collaudo E2E');

  // Comunicato breve: niente dipendenza dal caricamento pieno del rich-text.
  await page.getByRole('button', { name: 'Comunicato breve' }).click();

  // Pubblica: su DB non migrato risponde con l'errore grazioso; su DB migrato
  // conferma «Salvato». Si accetta l'uno o l'altro — mai un crash.
  await page.getByRole('button', { name: 'Pubblica' }).click();
  const ok = page.getByText(/Salvato\./i);
  const degrado = page.getByText(/non sono ancora disponibili|non riuscito/i);
  await expect(ok.or(degrado).first()).toBeVisible({ timeout: 15_000 });

  expect(erroriPagina).toEqual([]);
});
