import { test, expect } from '@playwright/test';
import { IDS, STORAGE } from './fixtures';

// Dati fittizi: il dettaglio SQL è verificato in PGlite; qui si prova il percorso UI
// anche sul DB CI non migrato. Il service worker non deve aggirare page.route.
test.use({ storageState: STORAGE.admin, serviceWorkers: 'block' });
const categoria = '11111111-1111-4111-8111-111111111111';
const spesa = '22222222-2222-4222-8222-222222222222';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/admin/settings/categorie?*', (r) => r.fulfill({ json: { success: true, data: [{ id: categoria, nome: 'Retta', slug: 'retta', scuola_id: null, attivo: true }] } }));
  await page.route('**/api/pagamenti/cassa/categorie?*', (r) => r.fulfill({ json: { disponibile: true, categorie: [{ id: spesa, nome: 'Cancelleria', scuola_id: null, attivo: true }] } }));
  await page.route('**/api/pagamenti/cassa/report?*', (r) => r.fulfill({ json: {
    disponibile: true, entrate_per_categoria: [{ categoria_id: categoria, categoria_nome: 'Retta', totale: 140, per_metodo: { contanti: 40, bonifico: 100 } }],
    uscite_per_categoria: [{ categoria_id: spesa, categoria_nome: 'Cancelleria', totale: 35, contanti: 15, altri: 20 }], mensile: [], per_sede: [],
  } }));
  await page.route('**/api/pagamenti/cassa/dettaglio?*', (r) => {
    const q = new URL(r.request().url()).searchParams;
    const entrata = q.get('tipo') === 'entrata';
    const seconda = q.get('pagina') === '2';
    return r.fulfill({ json: {
      disponibile: true, conteggio: 51, pagina: seconda ? 2 : 1, limite: 50,
      totali: { totale: entrata ? 140 : 35, contanti: entrata ? 40 : 15, altri: entrata ? 100 : 20 },
      righe: Array.from({ length: entrata && !seconda ? 50 : 1 }, (_, index) => ({ id: `${seconda ? 'seconda' : 'prima'}-${index}`, origine: entrata ? 'incasso' : 'cassa', scuola_id: 'e2e', scuola_nome: 'Sede di collaudo', data: '2026-10-14', categoria_id: entrata ? categoria : spesa, categoria_nome: entrata ? 'Retta' : 'Cancelleria', metodo: 'bonifico', importo: entrata ? 100 : 35, descrizione: entrata ? index === 0 ? 'Incasso retta ottobre' : `Incasso di collaudo ${index + 1}` : seconda ? 'Spesa seconda pagina' : 'Cancelleria ottobre', note: 'Nota fittizia di collaudo', allegato_path: null, storno_di: null, stornato_il: null, pagamento_id: entrata ? 'pagamento-fittizio' : null })),
    } });
  });
});

test('riepilogo: totali, dettaglio categoria e ritorno del focus', async ({ page }) => {
  await page.goto('/admin/pagamenti?vista=riepilogo');
  const totali = page.getByTestId('cassa-report-totali');
  await expect(totali).toContainText('140,00', { timeout: 15_000 });
  await expect(totali).toContainText('35,00');
  await expect(totali).toContainText('105,00');
  const apri = page.getByRole('button', { name: 'Vedi entrate di Retta', exact: true });
  const richiesta = page.waitForRequest((r) => r.url().includes('/cassa/dettaglio'));
  await apri.click();
  const q = new URL((await richiesta).url()).searchParams;
  expect(q.get('tipo')).toBe('entrata');
  expect(q.get('categoria_id')).toBe(categoria);
  const dialogo = page.getByRole('dialog');
  await expect(dialogo.getByText('Incasso retta ottobre', { exact: true })).toBeVisible();
  await expect(dialogo.getByTestId('cassa-dettaglio-totali')).toContainText('140,00');
  await dialogo.getByRole('button', { name: 'Successiva', exact: true }).scrollIntoViewIfNeeded();
  await expect(dialogo.getByRole('button', { name: 'Successiva', exact: true })).toBeVisible();
  const chiudi = dialogo.getByRole('button', { name: 'Chiudi dettaglio' });
  await expect(chiudi).toBeInViewport();
  const bounds = await dialogo.boundingBox();
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  await dialogo.getByRole('button', { name: 'Chiudi dettaglio' }).click();
  await expect(apri).toBeFocused();
});

test('uscite su mobile: filtri, note e paginazione con totale completo', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/admin/pagamenti?vista=uscite');
  await expect(page.getByRole('heading', { name: 'Uscite dettagliate' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Cancelleria ottobre', { exact: true })).toBeVisible();
  await page.getByText('Note', { exact: true }).click();
  await expect(page.getByText('Nota fittizia di collaudo', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Successiva', exact: true }).click();
  await expect(page.getByText('Spesa seconda pagina', { exact: true })).toBeVisible();
  await expect(page.getByTestId('cassa-dettaglio-totali')).toContainText('35,00');
  const nuova = page.waitForRequest((r) => r.url().includes('/cassa/dettaglio') && new URL(r.url()).searchParams.get('categoria_id') === spesa);
  await page.getByLabel('Categoria', { exact: true }).selectOption(spesa);
  expect(new URL((await nuova).url()).searchParams.get('pagina')).toBe('1');
  await expect(page.getByText('Cancelleria ottobre', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test.describe('Filtri di sede e mensilità', () => {
  test.use({ storageState: STORAGE.adminTutteLeSedi });

  test('sede, mensilità e categoria aggiornano movimenti, somme ed export', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.route('**/api/admin/sedi', (r) => r.fulfill({ json: { success: true, data: [{ id: IDS.SCUOLA, nome: 'Sede Alfa' }, { id: IDS.SCUOLA_COLLAUDO, nome: 'Sede Beta' }] } }));
    await page.route('**/api/pagamenti/cassa/dettaglio?*', (r) => {
      const q = new URL(r.request().url()).searchParams;
      const selezionata = q.get('scuola_id') === IDS.SCUOLA_COLLAUDO && q.get('da') === '2028-02-01' && q.get('a') === '2028-02-29' && q.get('categoria_id') === spesa;
      return r.fulfill({ json: { disponibile: true, conteggio: selezionata ? 1 : 0, pagina: 1, limite: 50, totali: { totale: selezionata ? 23 : 0, contanti: 0, altri: selezionata ? 23 : 0 }, righe: selezionata ? [{ id: 'spesa-fittizia-beta', origine: 'cassa', scuola_id: IDS.SCUOLA_COLLAUDO, scuola_nome: 'Sede Beta', data: '2028-02-12', importo: 23, metodo: 'bonifico', categoria_id: spesa, categoria_nome: 'Cancelleria', descrizione: 'Spesa di Beta a febbraio', note: null, allegato_path: null, storno_di: null, stornato_il: null, pagamento_id: null }] : [] } });
    });
    await page.goto('/admin/pagamenti?vista=uscite');
    await expect(page.getByRole('heading', { name: 'Uscite dettagliate' })).toBeVisible({ timeout: 15_000 });
    await page.getByLabel('Mensilità', { exact: true }).fill('2028-02');
    await page.getByLabel('Sede', { exact: true }).selectOption(IDS.SCUOLA_COLLAUDO);
    await expect(page.getByLabel('Mensilità', { exact: true })).toHaveValue('2028-02');
    await page.getByLabel('Categoria', { exact: true }).selectOption(spesa);
    await expect(page.getByText('Spesa di Beta a febbraio', { exact: true })).toBeVisible();
    await expect(page.getByTestId('cassa-dettaglio-totali')).toContainText('23,00');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    await page.route('**/api/pagamenti/cassa/report?*', (r) => {
      const q = new URL(r.request().url()).searchParams;
      const totale = q.get('scuola_id') === IDS.SCUOLA_COLLAUDO && q.get('da') === '2027-02-01' && q.get('a') === '2027-02-28' && q.get('categoria_pagamento_id') === categoria ? 80 : 140;
      return r.fulfill({ json: { disponibile: true, entrate_per_categoria: [{ categoria_id: categoria, categoria_nome: 'Retta', totale, per_metodo: { bonifico: totale } }], uscite_per_categoria: [], mensile: [], per_sede: [] } });
    });
    await page.goto('/admin/pagamenti?vista=riepilogo');
    await expect(page.getByTestId('cassa-report-totali')).toContainText('140,00', { timeout: 15_000 });
    await page.getByLabel('Mensilità', { exact: true }).fill('2027-02');
    await page.getByLabel('Sede', { exact: true }).selectOption(IDS.SCUOLA_COLLAUDO);
    await page.getByLabel('Categoria di pagamento', { exact: true }).selectOption(categoria);
    await expect(page.getByTestId('cassa-report-totali')).toContainText('80,00');
    const csv = page.getByRole('link', { name: /Scarica CSV/ });
    const q = new URL((await csv.getAttribute('href'))!, 'http://localhost').searchParams;
    expect(Object.fromEntries(q)).toMatchObject({ scuola_id: IDS.SCUOLA_COLLAUDO, da: '2027-02-01', a: '2027-02-28', categoria_pagamento_id: categoria, format: 'csv' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});


test('stampa conteggio su mobile: totale indipendente dal filtro, categoria esplicita e PDF nativo', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/admin/pagamenti?vista=riepilogo');
  await expect(page.getByTestId('cassa-report-totali')).toContainText('140,00', { timeout: 15_000 });
  await page.getByLabel('Dal', { exact: true }).fill('2026-09-01');
  await page.getByLabel('Al', { exact: true }).fill('2026-09-30');
  await page.getByLabel('Categoria di pagamento', { exact: true }).selectOption(categoria);
  const stampa = page.getByRole('button', { name: 'Stampa conteggio', exact: true });
  await stampa.click();
  const dialogo = page.getByRole('dialog', { name: 'Stampa conteggio' });
  await expect(dialogo.getByRole('radio', { name: 'Totale', exact: true })).toBeChecked();
  await expect(dialogo.getByText('01/09/2026 — 30/09/2026', { exact: true })).toBeVisible();
  const apri = dialogo.getByRole('link', { name: 'Apri PDF', exact: true });
  let q = new URL((await apri.getAttribute('href'))!, 'http://localhost').searchParams;
  expect(Object.fromEntries(q)).toMatchObject({ format: 'pdf', raggruppamento: 'totale', da: '2026-09-01', a: '2026-09-30' });
  expect(q.has('categoria_pagamento_id')).toBe(false);
  await dialogo.getByRole('radio', { name: 'Per categoria', exact: true }).check();
  q = new URL((await apri.getAttribute('href'))!, 'http://localhost').searchParams;
  expect(q.get('raggruppamento')).toBe('categoria');
  expect(q.has('categoria_pagamento_id')).toBe(false);
  await dialogo.getByLabel('Categoria di incasso', { exact: true }).selectOption(categoria);
  const scarica = dialogo.getByRole('link', { name: 'Scarica PDF', exact: true });
  q = new URL((await scarica.getAttribute('href'))!, 'http://localhost').searchParams;
  expect(q.get('categoria_pagamento_id')).toBe(categoria);
  expect(q.get('scarica')).toBe('1');
  await expect(dialogo.getByText(/escluso fondo iniziale/)).toBeVisible();
  const bounds = await dialogo.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  await page.keyboard.press('Escape');
  await expect(dialogo).not.toBeVisible();
  await expect(stampa).toBeFocused();
});
