import { test, expect } from '@playwright/test';
import { IDS, NOMI_SEDI, STORAGE } from './fixtures';

/**
 * IL PRIMO SCHERMO DELL'ADMIN MULTI-SEDE — quello che nessuno collaudava.
 *
 * ─── PERCHÉ ESISTE, E PERCHÉ SOLO DA OGGI ───────────────────────────────────
 *
 * In produzione non esiste un admin mono-sede: i due admin veri hanno TRE sedi
 * ciascuno (Giugliano, Aversa, Cesa). Ogni volta che il cookie `sedi_attive`
 * manca — browser nuovo, cookie puliti, app reinstallata, un anno passato —
 * `sedeCorrente` è `null` e le pagine sotto `SedeRequired` (contabilità, news,
 * mensa, modulistica, primaria, impostazioni, SIDI: almeno sette) mostrano
 * l'avviso «Seleziona una sede» al posto dei propri pannelli. È letteralmente
 * la prima cosa che vedono, ed era l'unico schermo del cockpit che nessuno spec
 * aveva mai aperto: l'admin del seed E2E era mono-sede, quindi quel ramo non si
 * raggiungeva nemmeno per sbaglio.
 *
 * Con il ponte `utenti_scuole` verso il «Plesso di Collaudo» l'admin di collaudo
 * ha due sedi, e il caso è finalmente riproducibile.
 *
 * ─── LA FORMA DI PARTENZA, e perché è questa ────────────────────────────────
 *
 * Si riusa `STORAGE.admin` e si CANCELLA il solo cookie `sedi_attive`. Non è un
 * espediente: è esattamente ciò che distingue i due stati nella realtà — la
 * sessione resta valida (l'admin è connesso da mesi), la preferenza di sede no.
 * Un login da zero dentro lo spec darebbe lo stesso risultato pagando un giro di
 * autenticazione in più; un contesto senza `storageState` darebbe una pagina di
 * login, cioè un altro test.
 *
 * `auth.setup.ts` quel cookie lo scrive apposta, con la misura scritta lì: è lo
 * stato in cui l'admin vero lavora quasi sempre. Questo spec collauda l'altra
 * metà, quella che gli capita quando il cookie non c'è.
 */

test.use({ storageState: STORAGE.admin });

test.beforeEach(async ({ context }) => {
  // Il browser nuovo: sessione sì, sede scelta no.
  await context.clearCookies({ name: 'sedi_attive' });
});

test('senza sede dichiarata la contabilità chiede di sceglierne una, e la scelta apre i KPI', async ({
  page,
  context,
}) => {
  const erroriPagina: string[] = [];
  page.on('pageerror', (err) => erroriPagina.push(err.message));

  await page.goto('/admin/pagamenti');

  // La testata della pagina c'è: la guardia ferma i pannelli, non la pagina.
  await expect(page.getByRole('heading', { name: 'Contabilità' })).toBeVisible();

  // L'avviso, e — la parte che conta — i BOTTONI per uscirne. Senza di loro
  // l'avviso chiederebbe una cosa che sul telefono non è possibile fare.
  await expect(page.getByText('Seleziona una sede').first()).toBeVisible({ timeout: 15_000 });
  const scelta = page.getByRole('group', { name: 'Seleziona una sede' });
  await expect(scelta.getByRole('button', { name: NOMI_SEDI.scuola })).toBeVisible();
  await expect(scelta.getByRole('button', { name: NOMI_SEDI.collaudo })).toBeVisible();

  // Finché la sede è ambigua i pannelli NON si montano: è il contratto di
  // `SedeRequired`, e questa è la sua unica verifica in un browser vero.
  await expect(page.getByText('Incassato', { exact: true })).toHaveCount(0);

  await scelta.getByRole('button', { name: NOMI_SEDI.scuola }).click();

  // Scelta la sede, la contabilità si apre: gli stessi KPI che
  // `admin-contabilita.spec.ts` dà per scontati partendo dal cookie già scritto.
  for (const kpi of ['Incassato', 'Da incassare', 'Da fatturare']) {
    await expect(page.getByText(kpi, { exact: true }).first()).toBeVisible({ timeout: 15_000 });
  }
  await expect(page.getByText('Seleziona una sede')).toHaveCount(0);

  // Il giro si chiude sul cookie: è quello, e non lo stato React, ciò che il
  // server ri-valida per decidere in quale plesso leggere e scrivere.
  const cookie = (await context.cookies()).find((c) => c.name === 'sedi_attive');
  expect(cookie?.value).toBe(IDS.SCUOLA);

  expect(erroriPagina).toEqual([]);
});

test('lo stesso avviso azionabile compare anche sulle News (non è un caso di una pagina sola)', async ({
  page,
}) => {
  await page.goto('/admin/news');
  await expect(page.getByRole('heading', { name: 'News' }).first()).toBeVisible({ timeout: 15_000 });

  await expect(page.getByText('Seleziona una sede').first()).toBeVisible({ timeout: 15_000 });
  const scelta = page.getByRole('group', { name: 'Seleziona una sede' });
  await expect(scelta.getByRole('button')).toHaveCount(2);

  await scelta.getByRole('button', { name: NOMI_SEDI.scuola }).click();
  await expect(page.getByText('Seleziona una sede')).toHaveCount(0);
});
