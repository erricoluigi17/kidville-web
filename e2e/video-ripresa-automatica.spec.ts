import { test, expect } from '@playwright/test';
import { IDS, STORAGE } from './fixtures';
import { clienteDatabaseCi, richiediPipelineVideo } from './helpers/database-ci';
import {
  AURORA,
  FRASI,
  apriGalleriaPronta,
  pubblicaEAttendiApertura,
  scegliVideo,
  schedaVideo,
} from './helpers/galleria-docente';
import {
  BLOCCO_TUS_BYTE,
  attendiStatoJob,
  dimensioneOggetto,
  leggiApertura,
  leggiJob,
  nomeVideoUnico,
  ritiraIntentoVideo,
  videoFinto,
} from './helpers/video-ci';

/**
 * LA RIPRESA AUTOMATICA — la rete cade a metà del TUS e il caricamento finisce da solo, SENZA UN CLIC
 * (PR 2 dei video, 2026-10-02, spec §11 e §17).
 *
 * ─── IL DIFETTO CHE CHIUDE ──────────────────────────────────────────────────────────────────────
 * Fino alla PR 2 un caricamento interrotto dalla rete restava «interrotto» finché una persona non premeva
 * «Riprendi»: una scheda che dice «riprende da dove si era fermato» e poi aspetta un dito. Per un video da un
 * gigabyte su una rete mobile quell'attesa è la regola, non l'eccezione. Adesso la pagina riprende da sola
 * (`useRipresaAutomatica`: ritorno in primo piano, evento `online`, attese di 5, 15, 30, 60 secondi), e il
 * pulsante resta come acceleratore per chi non vuole aspettare.
 *
 * ─── COME SI TAGLIA LA RETE, E CHE COSA SI VEDE ──────────────────────────────────────────────────────
 * Un file di 13 MiB fa TRE blocchi TUS (6 + 6 + poco più di 1 MiB: il blocco è l'unico che lo Storage
 * accetta). Si lascia passare il PRIMO, e quando parte il SECONDO si spegne la rete del browser
 * (`context.setOffline(true)`, che mette anche `navigator.onLine` a falso) e si abortisce la richiesta in
 * volo. `tus-js-client` non ritenta con la rete assente (`isOnline()` è nel suo `onShouldRetry`), quindi il
 * caricamento si ferma SUBITO come `interrotto`: è esattamente lo stato di un telefono nella galleria della
 * metropolitana. La scheda lo dice («Caricamento interrotto: riprende da solo…») e offre «Riprendi»: lo
 * spec ne verifica la presenza e NON LO PREME MAI. Poi `setOffline(false)` — l'evento `online` — e basta.
 *
 * Ciò che deve succedere da solo:
 *  · la scheda arriva a «In attesa di essere preparato», cioè tutti i byte sono nello Storage;
 *  · NESSUNA seconda sessione: una sola POST di creazione verso `/upload/resumable` (la ripresa manda una
 *    `HEAD` all'indirizzo della sessione salvato e riparte dall'offset che il SERVER ha contato);
 *  · NESSUN riavvio da zero: una sola PATCH con `Upload-Offset: 0`; quella tagliata e quella ripresa partono
 *    dal secondo blocco (`6 MiB`), e l'ultima dal terzo (`12 MiB`);
 *  · il database e lo Storage concordano: job `queued`, originale lungo quanto il file.
 *
 * ⚠️ È UN SOLO PROGETTO, `chromium`: l'emulazione di rete (`setOffline`) è del protocollo di Chromium, e lo
 * spec non è nell'elenco dei critici su WebKit (`SPEC_CRITICI_WEBKIT`). Il TUS di WebKit lo prova
 * `video-invio-bambini-prima`, che gira su entrambi.
 *
 * ─── ISOLAMENTO ─────────────────────────────────────────────────────────────────────────────────────
 * L'originale pesa 13 MiB: a fine test l'intento si annulla e l'oggetto si toglie dallo Storage (la quota del
 * progetto Supabase della CI non è infinita, e questo è l'unico spec che carica byte veri in quantità). Il seed
 * ripulisce comunque i resti di un test morto a metà. Un bambino solo (Aurora): niente liberatoria da toccare.
 * `retries: 0`: un caricamento non si ripesca, e un secondo giro partirebbe da un intento già aperto.
 *
 * ─── COSA LO RENDE ROSSO ─────────────────────────────────────────────────────────────────────────
 *  · una ripresa che apre una sessione nuova o riparte da zero → `creazioni` > 1, o due PATCH a offset 0;
 *  · una ripresa che aspetta un clic → la scheda resta «interrotto» e l'attesa scade;
 *  · un trasferimento che non segnala il `caricato` o un server che non vede l'arrivo → il job non è `queued`.
 */
test.describe.configure({ retries: 0 });
test.use({ storageState: STORAGE.docente, serviceWorkers: 'block' });

const daRimettere: { intento: { intentId: string; jobId: string } | null } = { intento: null };

test.afterEach(async ({ page, context }) => {
  // Il test può essere morto con la rete spenta: si riaccende PRIMA di toccare il server.
  await context.setOffline(false);
  const db = clienteDatabaseCi();
  if (daRimettere.intento) await ritiraIntentoVideo(page.request, db, daRimettere.intento);
  daRimettere.intento = null;
});

test('video: la rete cade a metà del TUS e il caricamento riprende da solo, dallo stesso punto, senza un clic', async ({ page, context }) => {
  test.setTimeout(300_000);
  const db = clienteDatabaseCi();
  await richiediPipelineVideo(db);

  const nome = nomeVideoUnico('ripresa');
  // Tre blocchi: [0, 6 MiB) · [6 MiB, 12 MiB) · [12 MiB, 13 MiB + 123 byte).
  const buffer = videoFinto(2 * BLOCCO_TUS_BYTE + 1_048_576 + 123);

  // ── LA RETE CADE AL SECONDO BLOCCO ────────────────────────────────────────────────────────────
  // `page.route` vede ogni richiesta verso il TUS; ne registra gli offset (l'intestazione `Upload-Offset` dice da
  // dove parte il blocco) e taglia la PRIMA PATCH oltre l'inizio. Prima si spegne la rete, poi si abortisce: così
  // `navigator.onLine` è già falso quando `tus` guarda l'errore, e non ritenta da sé.
  const offsetPatch: number[] = [];
  let creazioni = 0;
  let tagliata = false;
  await page.route(/\/storage\/v1\/upload\/resumable\//, async (route) => {
    const richiesta = route.request();
    if (richiesta.method() === 'POST') creazioni += 1;
    if (richiesta.method() === 'PATCH') {
      const intestazioni = await richiesta.allHeaders();
      const offset = Number(intestazioni['upload-offset']);
      offsetPatch.push(offset);
      // Per offset quando l'intestazione si legge, per posizione (la seconda PATCH) se per un caso non si legge.
      const eOltreIlPrimoBlocco = Number.isFinite(offset) ? offset > 0 : offsetPatch.length === 2;
      if (!tagliata && eOltreIlPrimoBlocco) {
        tagliata = true;
        await context.setOffline(true);
        await route.abort('internetdisconnected');
        return;
      }
    }
    await route.continue();
  });

  await apriGalleriaPronta(page);
  await scegliVideo(page, { nome, buffer });
  await page.getByRole('button', { name: AURORA }).click();
  const aperto = await leggiApertura(await pubblicaEAttendiApertura(page));
  daRimettere.intento = { intentId: aperto.intentId, jobId: aperto.jobId };

  // ── LA SCHEDA DICE «INTERROTTO» E OFFRE «RIPRENDI»: lo spec non lo preme. ─────────────────────
  const scheda = schedaVideo(page, nome);
  await expect(scheda, 'la rete è caduta al secondo blocco e la scheda deve dirlo').toContainText(FRASI.schedaInterrotta, {
    timeout: 90_000,
  });
  expect(tagliata, 'la rete è stata tagliata davvero (il secondo blocco è partito)').toBe(true);
  await expect(scheda.getByRole('button', { name: FRASI.riprendi, exact: true })).toBeVisible();

  // ── LA RETE TORNA, E BASTA: nessun gesto sulla pagina da qui alla fine. ───────────────────────────
  await context.setOffline(false);
  await expect(scheda, 'senza un clic, il caricamento deve riprendere e arrivare in coda').toContainText(
    FRASI.schedaInCoda,
    { timeout: 180_000 },
  );

  // ── DALLO STESSO PUNTO, NELLA STESSA SESSIONE ─────────────────────────────────────────────────
  expect(creazioni, 'una sola sessione TUS: la ripresa riparte dalla sessione salvata (HEAD), non ne apre un\'altra').toBe(1);
  expect(
    offsetPatch.filter((o) => o === 0),
    `una sola PATCH dall'inizio (offset visti: ${offsetPatch.join(', ')})`,
  ).toHaveLength(1);
  expect(offsetPatch[1], 'la PATCH tagliata era il secondo blocco').toBe(BLOCCO_TUS_BYTE);
  expect(
    offsetPatch[offsetPatch.length - 1],
    `l'ultima PATCH è il terzo blocco: la ripresa è ripartita dal secondo (offset visti: ${offsetPatch.join(', ')})`,
  ).toBe(2 * BLOCCO_TUS_BYTE);

  // ── IL SERVER E LO STORAGE CONCORDANO ────────────────────────────────────────────────────────
  await attendiStatoJob(db, aperto.jobId, 'queued', 'il job non è entrato in coda dopo la ripresa');
  const job = await leggiJob(db, aperto.jobId);
  expect(job?.owner_id).toBe(IDS.DOCENTE);
  expect(job?.source_size).toBe(buffer.length);
  expect(
    await dimensioneOggetto(db, 'video_originals', job?.original_path ?? ''),
    'l\'originale nello Storage è lungo quanto il file: nessun blocco perso o ripetuto',
  ).toBe(buffer.length);
});
