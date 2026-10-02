import { test, expect } from '@playwright/test';
import type { SupabaseClient } from '@supabase/supabase-js';
import { IDS, STORAGE } from './fixtures';
import { clienteDatabaseCi, richiediPipelineVideo } from './helpers/database-ci';
import {
  AURORA,
  BRUNO,
  FRASI,
  apriGalleriaPronta,
  bottonePubblica,
  osservaTus,
  pubblicaEAttendiApertura,
  scegliVideo,
  schedaVideo,
} from './helpers/galleria-docente';
import {
  attendiStatoJob,
  dimensioneOggetto,
  leggiApertura,
  leggiIntento,
  leggiJob,
  contaIntentiDi,
  nomeVideoUnico,
  ritiraIntentoVideo,
  videoFinto,
} from './helpers/video-ci';

/**
 * «I BAMBINI PRIMA» — dal passo dei bambini all'arrivo in coda, sul Supabase vero della CI (PR 2 dei video,
 * 2026-10-02, spec §17).
 *
 * ─── COSA PROVA ───────────────────────────────────────────────────────────────────────────────
 * Dalla PR 2 i bambini di un video si scelgono UNA volta, prima dell'invio, e il server li conosce subito:
 * «Pubblica» manda l'apertura (`POST /api/video-uploads` con i destinatari) e SOLO dopo il sì del server
 * partono i byte. Quindi un rifiuto — il 422 del Privacy Lock, con i nomi dei bambini senza liberatoria —
 * deve restare NEL PASSO DEI BAMBINI, con i file ancora nell'elenco e i nomi a schermo, e prima che parta
 * UN SOLO byte verso lo Storage. Lo spec lo prova in due metà, sullo stesso file:
 *
 *  1. Aurora e Bruno nello stesso video, ma a Bruno è appena stata tolta la liberatoria → 422 che nomina
 *     SOLO Bruno; la pagina resta al passo 2 col suo nome nell'avviso; ZERO richieste a
 *     `/storage/v1/upload/resumable` (contate con `page.on('request')`) e nessun intento nuovo in tabella;
 *  2. si toglie Bruno → l'apertura riesce (201), parte il TUS vero verso lo Storage della CI, e la scheda
 *     del video arriva a «In attesa di essere preparato», col job `queued`, l'originale lungo quanto il file e
 *     l'elenco del server che dice `in-coda` — chiave d'idempotenza e nome diversi a ogni giro.
 *
 * ─── PERCHÉ LA LIBERATORIA SI TOGLIE A PAGINA APERTA (e non è una scorciatoia) ────────────────────
 * Il tagger della pagina (`StudentTagger`) NON lascia mettere nello stesso gruppo un bambino senza
 * liberatoria insieme ad altri: se si sceglie lui, deseleziona gli altri e disabilita il resto. Dalla
 * pagina il 422 si raggiunge quindi in un caso solo — il dato cambia sotto i piedi della persona: la
 * pagina ha letto i bambini quando tutti avevano la liberatoria, qualcuno in segreteria la revoca, e
 * l'insegnante preme «Pubblica» con la lista vecchia. È il caso vero (e quello per cui il server rifà il
 * controllo a ogni apertura), e lo spec lo riproduce così: il seed ha i due bambini della Girasoli SENZA
 * liberatoria (il valore di default), lo spec accende quella di entrambi PRIMA di aprire la pagina, e
 * spegne quella di Bruno DOPO aver scelto i due bambini e PRIMA di premere «Pubblica».
 * Il valore si rimette com'era in `afterEach` (anche se il test muore a metà), e il seed lo riscrive a ogni
 * run (`consenso_privacy: false` per A1 e A2): un test caduto non lascia la liberatoria accesa a nessuno.
 *
 * Perché Aurora e Bruno e non un bambino «apposta» (la scelta che il compito chiedeva di spiegare): la
 * pagina offre alla docente E2E soltanto la sua sezione, e la sezione Girasoli ha un conteggio ESATTO
 * che altri spec pretendono (`teacher-attendance` vuole «Completo» a 2/2, `isolamento-sedi` l'insieme
 * `[A1, A2]` carattere per carattere): un terzo bambino li farebbe diventare rossi. Una sezione e una
 * docente dedicate avrebbero aggiunto un nono account `*.e2e@kidville.test` alla sede 1 — e con lui elenchi
 * di docenti, conteggi e la rubrica della chat che altri spec leggono. Una liberatoria che cambia per
 * qualche secondo, sullo stesso DB e con spec seriali (`workers: 1`), non tocca niente di tutto questo.
 *
 * ─── ISOLAMENTO ───────────────────────────────────────────────────────────────────────────────
 * Alla fine: l'intento è annullato (non resta nell'elenco della docente), l'originale è tolto dallo Storage, e
 * le due liberatorie tornano al valore di partenza. Resta una riga `video_intents`/`video_jobs` in stato
 * `cancelled`, che nessuna pagina mostra e che il seed toglie al run successivo. Su WebKit lo spec gira dopo
 * che `chromium` ha finito, sullo stesso database: il nome del file è diverso a ogni giro, e la chiave
 * d'idempotenza del web ne dipende (`gv2-<byte>-<data>-<impronta del nome>-<impronta dei bambini>`).
 *
 * ─── PERCHÉ `retries: 0` ──────────────────────────────────────────────────────────────────────
 * Come `gallery-caricamento`: un invio che scrive su un database condiviso non si ripesca. Con i
 * ripescaggi un rosso su tre passerebbe per verde, e il secondo giro partirebbe da uno stato che il primo ha
 * sporcato (un intento aperto, una liberatoria spenta).
 *
 * ─── COSA LO RENDE ROSSO (le mutazioni vedute, a mente: lo spec non si lancia in locale) ───────────
 *  · il 422 che non nomina Bruno, o che nomina anche Aurora → `corpo.nomi` / `ids`;
 *  · un invio che apre l'intento DOPO i byte (il vecchio ordine) → richieste TUS > 0 al passo 1;
 *  · un rifiuto che porta fuori dal passo dei bambini → l'intestazione «Configura Tag e Privacy» sparisce;
 *  · un server che crea l'intento prima dei cancelli → il conteggio degli intenti sale.
 */
test.describe.configure({ retries: 0 });
test.use({ storageState: STORAGE.docente, serviceWorkers: 'block' });

/** I due bambini della Girasoli: gli unici che la pagina offre alla docente E2E. */
const ALUNNI_GIRASOLI = [IDS.A1, IDS.A2];

type Consensi = Record<string, boolean | null>;

async function leggiConsensi(db: SupabaseClient, ids: string[]): Promise<Consensi> {
  const { data, error } = await db.from('alunni').select('id, consenso_privacy').in('id', ids);
  if (error) throw new Error(`lettura dei consensi fallita: ${error.code ?? ''} ${error.message}`);
  return Object.fromEntries(
    (data ?? []).map((riga: { id: string; consenso_privacy: boolean | null }) => [riga.id, riga.consenso_privacy]),
  );
}

async function scriviConsenso(db: SupabaseClient, id: string, valore: boolean | null): Promise<void> {
  const { error } = await db.from('alunni').update({ consenso_privacy: valore }).eq('id', id);
  if (error) throw new Error(`scrittura del consenso fallita: ${error.code ?? ''} ${error.message}`);
}

/** Ciò che `afterEach` deve rimettere a posto, scritto man mano che il test lo sporca. */
const daRimettere: {
  consensi: Consensi | null;
  intento: { intentId: string; jobId: string } | null;
} = { consensi: null, intento: null };

test.afterEach(async ({ page }) => {
  const db = clienteDatabaseCi();
  try {
    if (daRimettere.consensi) {
      for (const [id, valore] of Object.entries(daRimettere.consensi)) await scriviConsenso(db, id, valore);
    }
  } finally {
    if (daRimettere.intento) await ritiraIntentoVideo(page.request, db, daRimettere.intento);
    daRimettere.consensi = null;
    daRimettere.intento = null;
  }
});

test('video: i bambini si scelgono prima — il 422 resta nel passo dei bambini e non parte un byte; tolto il bambino, il TUS arriva in coda', async ({ page }) => {
  test.setTimeout(240_000);
  const db = clienteDatabaseCi();
  await richiediPipelineVideo(db);

  const nome = nomeVideoUnico('bambini-prima');
  const buffer = videoFinto(64 * 1024);
  const tus = osservaTus(page);

  // ── LA CLASSE HA TUTTE LE LIBERATORIE, per la pagina. ────────────────────────────────────────
  daRimettere.consensi = await leggiConsensi(db, ALUNNI_GIRASOLI);
  for (const id of ALUNNI_GIRASOLI) await scriviConsenso(db, id, true);

  await apriGalleriaPronta(page);
  await scegliVideo(page, { nome, buffer });

  // ── IL PASSO DEI BAMBINI: la pagina crede che entrambi abbiano la liberatoria ─────────────────
  const aurora = page.getByRole('button', { name: AURORA });
  const bruno = page.getByRole('button', { name: BRUNO });
  await expect(aurora).toBeEnabled({ timeout: 30_000 });
  await expect(bruno).toBeEnabled();
  // La premessa dello scenario, a schermo: nessun bambino porta l'etichetta «Solo genitori» (il testo della
  // frase informativa la contiene fra virgolette, per questo `exact`). Se comparisse, la pagina avrebbe già
  // letto che Bruno non ha la liberatoria e non lo lascerebbe scegliere con Aurora: lo spec non misurerebbe
  // il 422 ma un tagger che si difende da solo.
  await expect(page.getByText(FRASI.soloGenitori, { exact: true })).toHaveCount(0);
  await aurora.click();
  await bruno.click();

  // ── LA LIBERATORIA DI BRUNO VIENE TOLTA mentre l'insegnante sceglie. ──────────────────────────
  await scriviConsenso(db, IDS.A2, false);
  const intentiPrima = await contaIntentiDi(db, IDS.DOCENTE);

  // ── PRIMA METÀ: «Pubblica» con Aurora e Bruno → 422, e non parte niente. ──────────────────────
  const rifiuto = await pubblicaEAttendiApertura(page);
  if (rifiuto.status() === 201) {
    // Il server ha aperto l'intento che doveva rifiutare: il test sta per fallire, ma l'intento (e il TUS che sta per
    // partire) vanno ritirati comunque — `afterEach` lo fa, se sa che esiste.
    const sfuggito = await leggiApertura(rifiuto);
    daRimettere.intento = { intentId: sfuggito.intentId, jobId: sfuggito.jobId };
  }
  expect(rifiuto.status(), 'il Privacy Lock deve rifiutare l\'apertura con 422').toBe(422);

  const corpo422 = (await rifiuto.json()) as { error?: string; nomi?: string[]; ids?: string[] };
  expect(corpo422.nomi, 'il 422 nomina SOLO il bambino senza liberatoria').toEqual(['Bruno Baleno-E2E']);
  expect(corpo422.ids).toEqual([IDS.A2]);

  // Ciò che la pagina ha mandato: i DUE bambini, nella forma dell'apertura con i destinatari (nessun byte).
  const inviato = rifiuto.request().postDataJSON() as {
    canale: string;
    azione: string;
    scuolaId: string;
    trasporto: string;
    destinatari: { tagAlunni: string[]; broadcast: boolean };
    file: Array<{ byte: number; mime: string }>;
  };
  expect(inviato.canale).toBe('gallery');
  expect(inviato.azione).toBe('publish');
  expect(inviato.scuolaId).toBe(IDS.SCUOLA);
  expect(inviato.trasporto).toBe('tus');
  expect(inviato.destinatari.broadcast).toBe(false);
  expect([...inviato.destinatari.tagAlunni].sort()).toEqual([...ALUNNI_GIRASOLI].sort());
  expect(inviato.file).toHaveLength(1);
  expect(inviato.file[0].byte).toBe(buffer.length);
  expect(inviato.file[0].mime).toBe('video/mp4');

  // Il rifiuto sta DOVE lo vede chi ha sbagliato: nell'avviso della pagina, col nome di Bruno e senza quello
  // di Aurora, e la schermata è ancora il passo dei bambini con il tasto «Pubblica» di nuovo premibile.
  const avvisi = page.getByTestId('avvisi-invio');
  await expect(avvisi).toContainText('Bruno Baleno-E2E', { timeout: 30_000 });
  await expect(avvisi).toContainText(FRASI.liberatoria);
  await expect(avvisi).not.toContainText('Aurora');
  await expect(page.getByRole('heading', { name: /Configura Tag e Privacy/ })).toBeVisible();
  await expect(bottonePubblica(page)).toBeEnabled();

  // ZERO richieste verso lo Storage, e il server non ha scritto niente: i cancelli stanno PRIMA dell'intento.
  // (Il contatore è quello di `page.on('request')`: una richiesta partita e poi fallita si conterebbe.)
  expect(tus, 'nessuna richiesta a /storage/v1/upload/resumable prima del sì del server').toHaveLength(0);
  expect(await contaIntentiDi(db, IDS.DOCENTE), 'un 422 non può aver aperto un intento').toBe(intentiPrima);

  // ── SECONDA METÀ: si toglie Bruno → Aurora sola, «foto privata» → l'apertura riesce, parte il TUS. ───
  await bruno.click();
  const apertura = await pubblicaEAttendiApertura(page);
  const aperto = await leggiApertura(apertura);
  daRimettere.intento = { intentId: aperto.intentId, jobId: aperto.jobId };

  const secondoInvio = apertura.request().postDataJSON() as { destinatari: { tagAlunni: string[] } };
  expect(secondoInvio.destinatari.tagAlunni, 'solo Aurora, dopo aver tolto Bruno').toEqual([IDS.A1]);
  expect(aperto.job.caricamento.protocollo).toBe('tus');
  expect(aperto.job.needs_upload).toBe(true);
  expect(aperto.job.firma.length, 'la firma TUS è nella risposta (mai nell\'indirizzo)').toBeGreaterThan(0);

  // Il TUS parte davvero. Qui si aspetta soltanto la PRIMA richiesta, perché un invio che non parte mai deve cadere
  // in 60 secondi e con la sua frase, non dopo i 120 della scheda. Non si pretende altro: la creazione della sessione
  // è una POST, e la PATCH con i byte parte solo DOPO la risposta di quella POST — un giro di rete fino allo Storage
  // della CI. Cercarla qui, subito, sarebbe una corsa persa quasi ogni volta (su chromium e su webkit).
  await expect
    .poll(() => tus.length, { timeout: 60_000, message: 'dopo il sì del server non è partita nessuna richiesta verso lo Storage' })
    .toBeGreaterThan(0);

  // La scheda dice «in coda» soltanto quando i byte sono arrivati (il job entra in coda per il trigger d'arrivo sullo
  // Storage): a quel punto la POST e le PATCH sono tutte partite, e si contano.
  const scheda = schedaVideo(page, nome);
  await expect(scheda).toContainText(FRASI.schedaInCoda, { timeout: 120_000 });

  // Si aspetta la PRESENZA (con un tetto breve: ormai dovrebbero esserci già) invece di leggere l'array in modo
  // sincrono: non si dà per scontato che l'evento `request` di Playwright sia stato consegnato prima che lo schermo
  // cambiasse, e un'asserzione che lo dà per scontato è la stessa corsa, spostata di qualche secondo.
  await expect
    .poll(() => tus.some((r) => r.metodo === 'POST'), { timeout: 10_000, message: 'la sessione TUS si crea con una POST' })
    .toBe(true);
  await expect
    .poll(() => tus.some((r) => r.metodo === 'PATCH'), { timeout: 10_000, message: 'i byte viaggiano con le PATCH dei blocchi' })
    .toBe(true);

  // ── LA PROVA DALL'ALTRA PARTE: il database e lo Storage dicono lo stesso. ─────────────────────────────
  await attendiStatoJob(db, aperto.jobId, 'queued', 'il job non è entrato in coda dopo il caricamento (trigger d\'arrivo o PATCH caricato)');
  const job = await leggiJob(db, aperto.jobId);
  expect(job?.byte_dichiarati).toBe(buffer.length);
  expect(job?.mime_dichiarato).toBe('video/mp4');
  expect(job?.source_size, 'la dimensione che il server ha visto arrivare').toBe(buffer.length);
  expect(
    await dimensioneOggetto(db, 'video_originals', job?.original_path ?? ''),
    'l\'originale nello Storage è lungo quanto il file scelto: il TUS ha consegnato tutti i byte',
  ).toBe(buffer.length);

  const intento = await leggiIntento(db, aperto.intentId);
  expect(intento?.pubblicazione_automatica).toBe(true);
  expect(intento?.status).toBe('confirmed');
  expect(intento?.n_tag).toBe(1);
  expect(intento?.tag_alunni).toEqual([IDS.A1]);
  expect(intento?.trasporto).toBe('tus');

  // E l'elenco che la pagina interroga — `GET /api/video-uploads`, con il filtro `.or()` di PostgREST che in
  // CI girava per la prima volta (secondario #100) — dice la stessa cosa, senza un solo identificativo di bambino.
  const elenco = await page.request.get(`/api/video-uploads?canale=gallery&scuolaId=${IDS.SCUOLA}`, { timeout: 60_000 });
  expect(elenco.status()).toBe(200);
  const voci = ((await elenco.json()) as { voci: Array<Record<string, unknown>> }).voci;
  const voce = voci.find((v) => v.intentId === aperto.intentId);
  expect(voce, 'l\'intento appena aperto è nell\'elenco del server').toBeDefined();
  expect(voce).toMatchObject({
    jobId: aperto.jobId,
    fase: 'in-coda',
    codice: null,
    trasporto: 'tus',
    byte: buffer.length,
    nBambini: 1,
    broadcast: false,
    mediaId: null,
    pubblicazioneAutomatica: true,
    riprovaPossibile: false,
  });
  expect(JSON.stringify(voce), 'l\'elenco non porta mai gli identificativi dei bambini').not.toContain(IDS.A1);
});
