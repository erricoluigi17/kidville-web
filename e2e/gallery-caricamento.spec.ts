import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { EMAILS, IDS, STORAGE, login } from './fixtures';

// Scrive soltanto nel progetto isolato della CI, con gli account del seed E2E.
// Il percorso usa davvero UI, API, Storage e lettura del genitore: nessuna API
// viene sostituita con una risposta finta. I replay successivi verificano il caso
// in cui il salvataggio sia riuscito ma il telefono non abbia ricevuto la risposta.
//
// LA SCHEDA SI RICONOSCE DAL FILE, NON DAL NOME. Decisione del titolare del 02/10/2026:
// nessun contenuto NUOVO ha una didascalia, quindi la POST archivia sempre NULL qualunque
// cosa mandi il client, e la scheda della galleria si chiama soltanto «Foto» — non più
// «Foto: <nome del file>». Il nome del file non arriva più al server, quindi nella galleria
// non compare più: cercare per nome una scheda non la troverebbe mai, e cercare per nome
// l'ASSENZA di una scheda passerebbe sempre. Ciò che identifica la foto di QUESTA
// esecuzione è il percorso nel bucket (`uploads/<utente>/<file>`, diverso a ogni
// caricamento): lo si legge dal corpo della POST intercettata e lo si cerca nell'`src`
// della miniatura, che è l'indirizzo firmato di quello stesso percorso. Per lo stesso
// motivo il replay con una didascalia diversa NON è più un conflitto (la didascalia si
// ignora, l'impronta non cambia): il conflitto vero si prova su un campo che l'impronta
// copre davvero.
test.describe.configure({ retries: 0 });
test.use({ storageState: STORAGE.docente, serviceWorkers: 'block' });

for (const interruzione of ['nessuna', 'risposta PUT', 'risposta pubblicazione'] as const) {
test(`foto docente → genitore e ripresa: ${interruzione}`, async ({ page, browser }) => {
  test.setTimeout(120_000);
  expect(process.env.CI, 'Questo collaudo scrive solo nel database E2E della CI').toBeTruthy();
  const nome = `caricamento-e2e-${randomUUID()}.png`;
  let pubblicazione: Record<string, unknown> | null = null;
  let mediaId: string | null = null;
  let trasferimenti = 0;
  let rispostaPersa = false;
  const esitiPubblicazione: number[] = [];

  try {
  await page.route('**/storage/v1/object/upload/sign/gallery/**', async route => {
    if (route.request().method() !== 'PUT' || interruzione !== 'risposta PUT' || rispostaPersa) {
      await route.continue();
      return;
    }
    // Il servizio riceve davvero tutti i byte; si perde soltanto la risposta.
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    rispostaPersa = true;
    await route.abort('connectionfailed');
  });
  await page.route('**/api/gallery', async route => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    pubblicazione = route.request().postDataJSON() as Record<string, unknown>;
    const response = await route.fetch();
    // L'id prima dell'esito: chi vede l'esito deve trovare anche l'id.
    if (response.ok()) mediaId = (await response.json()).id as string;
    esitiPubblicazione.push(response.status());
    if (interruzione === 'risposta pubblicazione' && !rispostaPersa) {
      expect(response.status()).toBe(201);
      rispostaPersa = true;
      await route.abort('connectionfailed');
      return;
    }
    await route.fulfill({ response });
  });

  page.on('dialog', async dialog => { await dialog.accept(); });
  page.on('request', request => {
    if (request.method() === 'PUT' && new URL(request.url()).pathname.includes('/storage/v1/object/upload/sign/gallery/')) {
      trasferimenti += 1;
    }
  });
  await page.goto('/teacher/gallery');
  await page.getByRole('button', { name: 'Carica', exact: true }).click();
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 480;
    canvas.height = 360;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas non disponibile');
    for (let y = 0; y < 360; y += 8) {
      for (let x = 0; x < 480; x += 8) {
        ctx.fillStyle = `rgb(${(x * 7 + y) % 256},${(y * 11) % 256},${(x + y * 3) % 256})`;
        ctx.fillRect(x, y, 8, 8);
      }
    }
    return canvas.toDataURL('image/png').split(',')[1];
  });
  await page.locator('input[type="file"]').setInputFiles({ name: nome, mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  await page.getByRole('button', { name: /Modifica Tag.*1 file/i }).click();
  await page.getByRole('button', { name: /Aurora Arcobaleno-E2E/ }).click();
  await page.getByRole('button', { name: 'Pubblica 1 file', exact: true }).click();
  if (interruzione !== 'nessuna') {
    await expect.poll(() => rispostaPersa).toBe(true);
    await expect(page.getByRole('button', { name: 'Riprova caricamenti', exact: true })).toBeVisible();
    // Ricrea React e legge IndexedDB: la ripresa non può dipendere dalla memoria.
    await page.reload();
  }
  // PRIMA l'esito della POST, POI la scheda: la scheda si riconosce dal percorso del file
  // (vedi la testata), e il percorso sta nel corpo della POST. I 60 s sono quelli che
  // prima spettavano all'attesa della scheda: da qui passano il caricamento, l'eventuale
  // ripresa dopo il reload e la pubblicazione. Inoltre la scheda può arrivare dalla GET
  // della griglia dopo il reload mentre la POST è ancora nel server: la riga è già
  // scritta, ma il 201 parte solo dopo l'accodamento delle notifiche. Si aspetta
  // l'esito, poi si legge l'id.
  await expect.poll(() => esitiPubblicazione, { timeout: 60_000 }).toEqual(interruzione === 'risposta pubblicazione' ? [201, 200] : [201]);
  const payload = pubblicazione as Record<string, unknown> | null;
  const percorso = String(payload?.file_url ?? '');
  expect(percorso).toMatch(/^uploads\//);
  // Il percorso si ritrova nell'`src` della miniatura, che è l'indirizzo firmato di quel
  // file: è così che la scheda di questa esecuzione si distingue da tutte le altre.
  const miniatura = page.locator(`[data-testid="griglia-media"] img[src*="${percorso}"]`);
  await expect(miniatura).toHaveCount(1, { timeout: 60_000 });
  // Prova a schermo che la didascalia è nulla: con una didascalia il nome della scheda
  // sarebbe «Foto: <didascalia>» (`etichettaCard`), con la didascalia nulla è «Foto».
  await expect(
    page.locator('[data-testid="griglia-media"] [role="button"]', { has: page.locator(`img[src*="${percorso}"]`) }),
  ).toHaveAccessibleName('Foto');
  expect(payload?.upload_id).toMatch(/^[0-9a-f-]{36}$/i);
  expect(payload?.scuola_id).toBe(IDS.SCUOLA);
  expect(mediaId).toMatch(/^[0-9a-f-]{36}$/i);
  await expect(page.getByRole('button', { name: 'Riprova caricamenti', exact: true })).toHaveCount(0);
  expect(trasferimenti).toBe(1);

  const replay = await Promise.all(Array.from({ length: 3 }, () => page.request.post('/api/gallery', { data: payload })));
  for (const response of replay) {
    expect(response.status()).toBe(200);
    const data = await response.json();
    expect(data.id).toBe(mediaId);
    expect(data.replayed).toBe(true);
  }
  // La didascalia NON è un campo che conta: il server la ignora (nessun contenuto nuovo ne
  // ha una) e non la manda alla RPC, quindi l'impronta non cambia. Un replay con una
  // didascalia diversa è lo STESSO caricamento — 200, stesso id, didascalia ancora nulla —
  // e non più un conflitto.
  const didascaliaDiversa = await page.request.post('/api/gallery', { data: { ...payload, caption: `${nome}-diversa` } });
  expect(didascaliaDiversa.status()).toBe(200);
  const ignorata = await didascaliaDiversa.json();
  expect(ignorata.id).toBe(mediaId);
  expect(ignorata.replayed).toBe(true);
  expect(ignorata.caption).toBeNull();
  // Il conflitto vero si prova su un campo che l'impronta copre e che supera i cancelli: i
  // bambini taggati. Nessun tag e nessun broadcast vuol dire «tutta la sede», e non c'è
  // niente da verificare, quindi la richiesta arriva fino alla RPC, che la rifiuta perché
  // lo stesso `upload_id` era stato usato per un'altra foto.
  const conflitto = await page.request.post('/api/gallery', { data: { ...payload, tag_students: [] } });
  expect(conflitto.status()).toBe(409);
  expect((await conflitto.json()).codice).toBe('CARICAMENTO_IN_CONFLITTO');

  const genitore = await browser.newContext({ storageState: STORAGE.genitore, serviceWorkers: 'block' });
  const famiglia = await genitore.newPage();
  try {
    // Attende la lettura reale della galleria: il DOM iniziale non significa
    // che autenticazione, API e decodifica siano già concluse (soprattutto WebKit).
    const lettura = famiglia.waitForResponse(response =>
      response.request().method() === 'GET' && new URL(response.url()).pathname === '/api/gallery',
    );
    await famiglia.goto(`/parent/gallery?id=${IDS.A1}`);
    const response = await lettura;
    expect(response.ok()).toBe(true);
    const data = await response.json() as { media: Array<{ id: string }> };
    expect(data.media.filter(media => media.id === mediaId)).toHaveLength(1);
    // La scheda si riconosce dal file (vedi la testata): la miniatura col percorso pubblicato.
    const miniaturaFamiglia = famiglia.locator(`[data-testid="griglia-media"] img[src*="${percorso}"]`);
    await expect(miniaturaFamiglia).toHaveCount(1, { timeout: 30_000 });
    await expect(miniaturaFamiglia).toBeVisible();
    await expect.poll(() => miniaturaFamiglia.evaluate(image => (image as HTMLImageElement).naturalWidth), { timeout: 30_000 }).toBeGreaterThan(0);
  } finally {
    await genitore.close();
  }

  const estraneo = await browser.newContext({ storageState: { cookies: [], origins: [] }, serviceWorkers: 'block' });
  try {
    const altraFamiglia = await estraneo.newPage();
    await login(altraFamiglia, EMAILS.genitore2);
    await altraFamiglia.waitForURL('**/parent');
    const lettura = altraFamiglia.waitForResponse(response => new URL(response.url()).pathname === '/api/gallery');
    await altraFamiglia.goto(`/parent/gallery?id=${IDS.B1}`);
    const response = await lettura;
    expect(response.ok()).toBe(true);
    const data = await response.json() as { media: Array<{ id: string }> };
    expect(data.media.some(media => media.id === mediaId)).toBe(false);
    await expect(altraFamiglia.getByText('Caricamento foto…', { exact: true })).toHaveCount(0);
    // Per file e non per nome: nessuna scheda può più chiamarsi «Foto: <nome del file>»,
    // quindi quel controllo sarebbe sempre verde. Il percorso, invece, esiste in questa pagina
    // solo se la foto è stata consegnata a chi non doveva vederla.
    await expect(altraFamiglia.locator(`[data-testid="griglia-media"] img[src*="${percorso}"]`)).toHaveCount(0);
  } finally {
    await estraneo.close();
  }

  } finally {
    if (mediaId) {
      const rimozione = await page.request.delete(`/api/gallery?id=${mediaId}&userId=${IDS.DOCENTE}`);
      expect(rimozione.ok()).toBe(true);
    }
  }
});
}
