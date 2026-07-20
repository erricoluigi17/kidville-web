import { test, expect } from '@playwright/test';
import { STORAGE } from './fixtures';

// Feed «News» del genitore (branch feat/news): pagina feed, dettaglio, digest e
// widget in home + voce nel Menu sheet. Il DB E2E della CI NON è migrato → il feed
// risponde {disponibile:false} e la lista mostra l'empty-state «Ancora nessuna
// news». Qui si verifica il rendering e l'assenza di crash, non la presenza di dati.
test.use({ storageState: STORAGE.genitore });

test('la pagina News rende testata, accesso al digest e feed (vuoto degradato o card)', async ({ page }) => {
  const erroriPagina: string[] = [];
  page.on('pageerror', (err) => erroriPagina.push(err.message));

  await page.goto('/parent/news');
  await expect(page.getByRole('heading', { name: 'News' }).first()).toBeVisible({ timeout: 15_000 });

  // L'accesso al digest mensile è sempre presente.
  await expect(page.getByText('Digest mensile').first()).toBeVisible({ timeout: 15_000 });

  // Il feed: empty-state (DB non migrato) OPPURE almeno una card. Mai un crash.
  const vuoto = page.getByText(/Ancora nessuna news|Nessun risultato/i);
  const barraRicerca = page.getByPlaceholder(/Cerca nelle news/i);
  await expect(vuoto.or(barraRicerca).first()).toBeVisible({ timeout: 15_000 });

  expect(erroriPagina).toEqual([]);
});

test('l\'archivio digest rende la lista (vuota degradata) senza crash', async ({ page }) => {
  const erroriPagina: string[] = [];
  page.on('pageerror', (err) => erroriPagina.push(err.message));

  await page.goto('/parent/news/digest');
  await expect(page.getByRole('heading', { name: 'Digest mensile' }).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/Ancora nessun digest|Kidville News/i).first()).toBeVisible({ timeout: 15_000 });

  expect(erroriPagina).toEqual([]);
});

test('la home genitore monta il widget News senza crash', async ({ page }) => {
  const erroriPagina: string[] = [];
  page.on('pageerror', (err) => erroriPagina.push(err.message));

  await page.goto('/parent');
  // La home carica (hero/saluto). Il widget News si nasconde se vuoto: si verifica
  // solo che non provochi eccezioni.
  await expect(page.getByText(/Ciao/i).first()).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(1500); // lascia partire la fetch best-effort del widget
  expect(erroriPagina).toEqual([]);
});

test('la voce «News» è presente nel Menu sheet e porta al feed', async ({ page }) => {
  await page.goto('/parent');
  // Apre il Menu sheet (bottom-nav) e clicca la voce News del gruppo Comunicazioni.
  await page.getByRole('button', { name: /Menu/i }).click();
  const voceNews = page.getByRole('link', { name: /News/i }).filter({ hasText: 'Novità e comunicati' });
  await expect(voceNews.first()).toBeVisible({ timeout: 10_000 });
  await voceNews.first().click();
  await expect(page).toHaveURL(/\/parent\/news/);
});
