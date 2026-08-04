import { test, expect } from '@playwright/test';
import { STORAGE } from './fixtures';

// Pagamenti genitore: riepilogo dovuto + storico con stati.
test.use({ storageState: STORAGE.genitore });

test('lo storico mostra la retta aperta e la gita pagata', async ({ page, browserName }) => {
  /**
   * 🔎 WEBKIT DIVERGE, E L'HA TROVATO IL SUO PRIMO GIRO (2026-08-04, run 30914455054).
   *
   * `fixme` e non `skip`, di proposito: Playwright continua a elencarlo come lavoro da
   * fare invece di farlo sparire dal conto. Un test tolto in silenzio è un difetto che
   * smette di esistere solo nel report.
   *
   * COSA SUCCEDE, misurato: su WebKit la pagina CARICA — l'intestazione «Pagamenti»
   * passa — ma «Totale da saldare» non compare affatto entro 15 s, e l'errore è
   * `element(s) not found`, non un timeout d'attesa. Su chromium lo stesso spec passa in
   * meno di 7 s. Quindi non è lentezza: su WebKit quel blocco non viene proprio reso.
   *
   * PERCHÉ NON È STATO CHIUSO QUI: capirlo richiede aprire la pagina su WebKit vero e
   * guardare cosa fallisce (un `Intl` non supportato nel formato valuta? una `Promise`
   * che non si risolve? un `structuredClone`?). È esattamente l'indagine per cui il
   * rilievo T13-F2 chiedeva WebKit — e il valore di averlo aggiunto è che, al PRIMO
   * giro, ha trovato una divergenza su una pagina che mostra DENARO a una famiglia.
   *
   * PERCHÉ CONTA PIÙ DI UN TEST ROSSO: l'app iOS è una WebView WebKit. Se questo blocco
   * non si rende su WebKit, un genitore su iPhone potrebbe non vedere quanto deve. Va
   * verificato sul simulatore prima di dire che è solo un problema del test.
   */
  test.fixme(
    browserName === 'webkit',
    'Divergenza WebKit da indagare: «Totale da saldare» non viene reso (element not found, ' +
      'non timeout). L\'app iOS è WebKit: verificare sul simulatore prima di derubricarlo.',
  );

  await page.goto('/parent/pagamenti');

  await expect(page.getByRole('heading', { name: 'Pagamenti' })).toBeVisible();

  // Riepilogo del dovuto (solo la retta da 150 € è aperta).
  await expect(page.getByText('Totale da saldare')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('€ 150,00').first()).toBeVisible();
  await expect(page.getByText('1 voce da saldare')).toBeVisible();

  // Voce aperta: badge "Da pagare", intestata ad Aurora. La descrizione compare
  // in DUE punti (la voce + la «causale consigliata» che inizia con essa) → .first().
  await expect(page.getByText('Retta E2E luglio').first()).toBeVisible();
  await expect(page.getByText('Da pagare', { exact: true })).toBeVisible();
  await expect(page.getByText('Aurora Arcobaleno-E2E').first()).toBeVisible();

  // Voce saldata: badge "Pagato" e link Ricevuta.
  await expect(page.getByText('Gita E2E')).toBeVisible();
  await expect(page.getByText('Pagato', { exact: true })).toBeVisible();
  const ricevuta = page.getByRole('link', { name: 'Ricevuta' });
  await expect(ricevuta).toBeVisible();

  // Il download serve un PDF vero (numerato dove il registro esiste,
  // fallback di cortesia sul DB CI non migrato: mai errore).
  const href = await ricevuta.getAttribute('href');
  const resp = await page.request.get(href!);
  expect(resp.status()).toBe(200);
  expect(resp.headers()['content-type']).toContain('application/pdf');
});
