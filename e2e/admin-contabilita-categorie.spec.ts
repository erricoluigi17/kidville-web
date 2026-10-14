import { test, expect } from '@playwright/test';
import { STORAGE } from './fixtures';

// Dati fittizi: il dettaglio SQL è verificato in PGlite; qui si prova il percorso UI
// anche sul DB CI non migrato. Il service worker non deve aggirare page.route.
test.use({ storageState: STORAGE.admin, serviceWorkers: 'block' });
const categoria = '11111111-1111-4111-8111-111111111111';
const spesa = '22222222-2222-4222-8222-222222222222';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/admin/settings/categorie?*', (r) => r.fulfill({ json: { success: true, data: [{ id: categoria, nome: 'Retta', slug: 'retta', scuola_id: null }] } }));
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
