import { test, expect } from '@playwright/test';
import type { SupabaseClient } from '@supabase/supabase-js';
import { DOPPIO_PROFILO_E2E, IDS, STORAGE } from './fixtures';
import { clienteDatabaseCi, richiediPipelineVideo } from './helpers/database-ci';
import {
  apriIntentoVideo,
  attendiStatoJob,
  dimensioneOggetto,
  giraRunner,
  leggiApertura,
  leggiIntento,
  leggiJob,
  messaggioDi,
  nomeVideoUnico,
  ritiraIntentoVideo,
  simulaConversione,
  togliCopiaInGalleria,
  videoFinto,
} from './helpers/video-ci';

/**
 * I DESTINATARI — il server pubblica da solo il video convertito, e SOLO i genitori del bambino scelto lo vedono
 * e ricevono l'avviso (PR 2 dei video, 2026-10-02, spec §7, §8 e §17).
 *
 * ─── COSA PROVA ───────────────────────────────────────────────────────────────────────────────────
 * Fino alla PR 2 la pubblicazione di un video la faceva il BROWSER, quando il job era `ready`: con la pagina
 * chiusa il video restava convertito e mai pubblicato (11 casi misurati il 01/10). Adesso i bambini stanno
 * sull'intento (li ha scelti l'insegnante all'invio), `video_job_ready` accoda nella STESSA transazione l'evento
 * `gallery.auto_publish`, e il runner lo consuma: copia l'uscita in galleria, scrive la riga e CHIUDE l'intento
 * (`video_galleria_pubblica`, atomica), poi — una volta sola, con la marca `esito_notificato` — avvisa le famiglie
 * e l'insegnante. Questo spec percorre l'intera catena sul database e sullo Storage veri della CI:
 *
 *   docente apre l'intento con [Aurora] → «caricato» → [conversione SIMULATA: presa + uscita + ready] →
 *   un giro del runner chiesto dallo STAFF → il video è in galleria → chi lo vede e chi lo sa.
 *
 * ─── CHE COSA È SIMULATO, E PERCHÉ SOLO QUELLO ──────────────────────────────────────────────────────
 * La conversione. Il runner vero apre una MicroVM del Vercel Sandbox e converte con FFmpeg: in CI non ci sono
 * né le credenziali né il tempo, e in CI non c'è nemmeno `pg_net` (il runner non parte da solo, né dal trigger
 * né dal cron). Il passo si fa col client di servizio con le STESSE due RPC che userebbe il runner
 * (`video_job_claim`, `video_job_ready`: vedi `simulaConversione`), quindi ciò che segue — l'evento
 * nell'outbox, il consumo, la copia, la riga di galleria, la marca, le notifiche — non è finto: è il codice
 * di produzione. Il giro del runner si chiede come lo chiederebbe lo staff: `POST /api/video/runner` con la
 * sessione dell'admin E2E e il corpo vuoto (il corpo del cron). Richiede `VIDEO_RUNNER_OWNER_ID` nel server di
 * sviluppo della CI (la mette `playwright.config.ts`): senza, il runner risponde 503 e non pubblica niente.
 * Il giro tocca anche altro (arrivi, ventaglio, esiti, un job nuovo): in CI non può avere effetto, e il seed toglie
 * i video dei run precedenti proprio perché la coda sia vuota — se ce ne fosse uno, il runner proverebbe ad aprire un
 * Sandbox senza credenziali e gli darebbe un guasto nostro: innocuo, e non riguarda questo video.
 *
 * ─── I DUE VERSI, E L'ANCORA DEL NEGATIVO ───────────────────────────────────────────────────────────
 *  · POSITIVO — il genitore di Aurora (`genitore.e2e`): la galleria di Aurora contiene il video; ha la notifica
 *    «Nuovi contenuti in galleria» (tipo `galleria`, in coda col suo buffer); la pagina `/parent/gallery` disegna la
 *    scheda «Video» (nome accessibile esatto: un contenuto nuovo non ha didascalia);
 *  · NEGATIVO — il genitore-docente (`doppio.e2e`, in veste di genitore) è un genitore della STESSA sede di un
 *    bambino NON taggato (Fiore, `A5`): la sua galleria NON contiene il video e nessuna notifica `galleria` è
 *    arrivata a lui. Il seed ha già questo genitore: non serve un bambino in più, e la sezione Girasoli
 *    (conteggio ESATTO per altri spec) non si tocca. La prova negativa ha la sua ANCORA, sulla stessa vista: la
 *    galleria di Fiore contiene la foto seminata per lui — senza, «non contiene il video» sarebbe vero anche per
 *    una pagina che non ha caricato niente. Per le notifiche l'ancora è la FORMA dell'insieme: i destinatari
 *    dell'avviso nato in questo giro sono esattamente `{genitore.e2e}`.
 *  · L'INSEGNANTE — riceve `video_esito` («Il tuo video è stato pubblicato in galleria.», link `/teacher/gallery`),
 *    e NON riceve l'avviso di liberatoria (un bambino solo: «foto privata», nessuno ha perso niente).
 *
 * ─── ISOLAMENTO (gli spec girano su un DB condiviso: cosa resta, e a chi dà fastidio) ───────────────────
 * Un video pubblicato in galleria è visibile a chiunque apra la galleria di Aurora o della Girasoli: gli altri spec che
 * le misurano (`impaginazione-media` su WebKit, che gira DOPO questo; `gallery-caricamento`; il crawler di contrasto)
 * non devono trovarlo. Per questo il test, a fine corsa, mette la riga nel cestino con lo stesso `DELETE /api/gallery`
 * che l'insegnante preme dal visore (la riga non si elenca più, a nessuno), poi toglie la copia dallo Storage e l'uscita
 * di lavorazione. Resta una riga `video_intents`/`video_jobs` in stato `published`, che nessuna pagina mostra, e le
 * righe di `notifiche` degli account E2E, che il seed azzera a ogni run. Un test morto a metà: il seed riscrive tutto
 * (`ripulisciVideoE2E`). Le misure di `impaginazione-media` sono comunque PAVIMENTI (`>=`): un contenuto in più non le
 * rende rosse.
 * Si parte da una coda pulita (il seed) e si arriva a una coda pulita: l'unico job che il giro del runner può
 * trovare è questo, e lo trova già `ready`.
 *
 * ─── PERCHÉ `retries: 0` E UN SOLO TEST ─────────────────────────────────────────────────────────────
 * La catena è una sola, e ogni passo dipende dal precedente: spezzarla in test indipendenti vorrebbe dire rifare la
 * conversione simulata per ciascuno. `retries: 0` come gli altri spec che scrivono sul database condiviso: un
 * secondo giro partirebbe da un intento già pubblicato.
 *
 * ─── COSA LO RENDE ROSSO ───────────────────────────────────────────────────────────────────────────
 *  · il runner che non consuma `gallery.auto_publish` (o risponde 503) → l'intento non diventa `published`;
 *  · una pubblicazione che dimentica il filtro dei destinatari → la galleria del genitore non taggato contiene il video,
 *    o la notifica arriva anche a lui;
 *  · un contenuto nuovo con una didascalia (il nome del file) → la scheda non si chiama esattamente «Video»;
 *  · una notifica doppia, o un avviso di liberatoria senza motivo → il conteggio dei destinatari/delle righe non torna.
 */
test.describe.configure({ retries: 0 });
test.use({ storageState: STORAGE.docente, serviceWorkers: 'block' });

const attesa = (ms: number): Promise<void> => new Promise((risolvi) => setTimeout(risolvi, ms));

interface RigaNotifica {
  id: string;
  utente_id: string;
  tipo: string;
  titolo: string;
  corpo: string | null;
  link: string | null;
  entita_tipo: string | null;
  entita_id: string | null;
}

/** Le notifiche di un tipo (e, se si dà, di un'entità) come stanno adesso nel database. */
async function notificheDi(db: SupabaseClient, tipo: string, entitaId?: string): Promise<RigaNotifica[]> {
  let richiesta = db
    .from('notifiche')
    .select('id, utente_id, tipo, titolo, corpo, link, entita_tipo, entita_id')
    .eq('tipo', tipo);
  if (entitaId !== undefined) richiesta = richiesta.eq('entita_id', entitaId);
  const { data, error } = await richiesta;
  if (error) throw new Error(`lettura di notifiche (${tipo}) fallita: ${error.code ?? ''} ${error.message}`);
  return (data ?? []) as RigaNotifica[];
}

/** Lo stato della pubblicazione in una riga di testo: solo stati, contatori e codici (mai nomi né identificativi di bambini). */
async function diagnosiPubblicazione(db: SupabaseClient, intentId: string): Promise<string> {
  try {
    const intento = await leggiIntento(db, intentId);
    const outbox = await db.from('video_outbox').select('event_type, attempts, sent_at').eq('intent_id', intentId);
    return `intento=${intento?.status} esito=${intento?.esito_notificato ?? '-'} errore=${intento?.pubblicazione_errore ?? '-'}; outbox=${JSON.stringify(outbox.data ?? outbox.error?.code)}`;
  } catch (errore) {
    return `diagnosi non leggibile: ${messaggioDi(errore)}`;
  }
}

test('destinatari: il server pubblica da solo il video convertito; solo i genitori del bambino taggato lo vedono e ricevono l\'avviso', async ({ request, playwright, browser, baseURL }) => {
  test.setTimeout(420_000);
  const db = clienteDatabaseCi();
  await richiediPipelineVideo(db);

  // Tre contesti SENZA la sessione della docente: lo staff che fa girare il runner, la famiglia di Aurora e il
  // genitore (della stessa sede) di un bambino che nel video non c'è.
  const staff = await playwright.request.newContext({ baseURL, storageState: STORAGE.admin });
  const famigliaDiAurora = await playwright.request.newContext({ baseURL, storageState: STORAGE.genitore });
  const altraFamiglia = await playwright.request.newContext({ baseURL, storageState: STORAGE.doppioGenitore });

  let intento: { intentId: string; jobId: string } | null = null;
  let mediaId: string | null = null;
  try {
    // ── LE NOTIFICHE CHE ESISTONO GIÀ (altri spec dello stesso run): ciò che nasce da qui in poi è nuovo ───────
    const galleriaPrima = new Set((await notificheDi(db, 'galleria', IDS.DOCENTE)).map((n) => n.id));
    const liberatoriaPrima = new Set((await notificheDi(db, 'video_liberatoria_revocata')).map((n) => n.id));

    // ── 1. L'INSEGNANTE APRE L'INTENTO CON UN BAMBINO SOLO (Aurora) e dice «caricato» ────────────────────
    const file = videoFinto(48 * 1024);
    const aperto = await leggiApertura(
      await apriIntentoVideo(request, { file, nome: nomeVideoUnico('destinatari'), tag: [IDS.A1] }),
    );
    intento = { intentId: aperto.intentId, jobId: aperto.jobId };

    const caricato = await request.patch(`/api/video-uploads/${aperto.intentId}`, {
      data: { azione: 'caricato', jobId: aperto.jobId, byte: file.length, mime: 'video/mp4' },
      timeout: 60_000,
    });
    expect(caricato.status(), `PATCH caricato → ${caricato.status()}`).toBe(200);
    await attendiStatoJob(db, aperto.jobId, 'queued', 'il job non è entrato in coda dopo il «caricato»');

    // ── 2. LA CONVERSIONE, SIMULATA con le RPC del runner: presa, uscita, ready ────────────────────────
    const uscita = await simulaConversione(db, aperto.jobId);
    await attendiStatoJob(db, aperto.jobId, 'ready', 'il job non è `ready` dopo video_job_ready');

    // Prima del runner: l'evento di pubblicazione è nell'outbox, non consegnato, e in galleria non c'è niente.
    const outbox = await db.from('video_outbox').select('event_type, sent_at').eq('intent_id', aperto.intentId);
    expect(outbox.error).toBeNull();
    expect(outbox.data, 'video_job_ready accoda gallery.auto_publish nella stessa transazione').toEqual([
      { event_type: 'gallery.auto_publish', sent_at: null },
    ]);
    const primaDelRunner = await db.from('galleria_media_v2').select('id').eq('upload_id', aperto.intentId);
    expect(primaDelRunner.data ?? [], 'in galleria non c\'è ancora niente: la pubblicazione è del server, e non è ancora partita').toHaveLength(0);

    // ── 3. UN GIRO DEL RUNNER, come lo chiede lo staff ─────────────────────────────────────────────
    // «Innocuo, riprova»: il giro fa anche altro (vedi la testata) e può lasciare una riga di log; la pubblicazione, se
    // il database è quello giusto, riesce al primo. Si riprova al più due volte, e si dice cosa è successo a ogni giro.
    const giri: string[] = [];
    let pubblicato = false;
    for (let giro = 1; giro <= 3 && !pubblicato; giro += 1) {
      const esito = await giraRunner(staff);
      giri.push(`${esito.stato}/${esito.esito ?? '-'}`);
      // Si ferma subito sui rifiuti che un secondo giro non cambia: la sessione dello staff che non vale (401/403), la
      // route che non c'è (404) e il runner senza identità (503 `CONFIGURAZIONE_ASSENTE`). Un 500 invece si ripete.
      expect(
        [401, 403, 404, 503],
        `il giro del runner ha risposto ${esito.stato} (${esito.esito ?? '-'}): 503 = manca VIDEO_RUNNER_OWNER_ID nel server di sviluppo della CI (playwright.config.ts); 401/403 = la sessione dello staff non vale`,
      ).not.toContain(esito.stato);
      const fine = Date.now() + 20_000;
      while (!pubblicato && Date.now() < fine) {
        const letto = await leggiIntento(db, aperto.intentId);
        pubblicato = letto?.status === 'published' && letto.esito_notificato === 'pubblicato';
        if (!pubblicato) await attesa(1_000);
      }
    }
    expect(
      pubblicato,
      `il runner non ha pubblicato il video (giri: ${giri.join(' · ')}) — ${await diagnosiPubblicazione(db, aperto.intentId)}`,
    ).toBe(true);

    // ── 4. IN GALLERIA: una riga, per il bambino giusto, senza didascalia, con la copia nello Storage ───────
    const righe = await db.from('galleria_media_v2').select('*').eq('upload_id', aperto.intentId);
    expect(righe.error).toBeNull();
    expect(righe.data, 'esattamente UNA riga di galleria per questo intento (un solo vincitore)').toHaveLength(1);
    const media = (righe.data ?? [])[0] as {
      id: string;
      uploaded_by: string;
      scuola_id: string | null;
      file_type: string;
      file_url: string;
      caption: string | null;
      tag_students: string[];
      is_broadcast: boolean;
    };
    mediaId = media.id;
    expect(media.file_type).toBe('video');
    expect(media.caption, 'nessuna didascalia per i contenuti nuovi (decisione del titolare, 02/10)').toBeNull();
    expect(media.tag_students).toEqual([IDS.A1]);
    expect(media.is_broadcast).toBe(false);
    expect(media.uploaded_by).toBe(IDS.DOCENTE);
    if (media.scuola_id !== null) expect(media.scuola_id).toBe(IDS.SCUOLA);
    expect(media.file_url, 'percorso deterministico della copia').toBe(`uploads/${IDS.DOCENTE}/v-${aperto.intentId}.mp4`);
    expect(
      await dimensioneOggetto(db, 'gallery', media.file_url),
      'la copia nel bucket della galleria è lunga quanto l\'uscita convertita',
    ).toBe(uscita.byte);

    const intentoDopo = await leggiIntento(db, aperto.intentId);
    expect(intentoDopo?.status).toBe('published');
    expect(intentoDopo?.esito_notificato).toBe('pubblicato');
    expect(intentoDopo?.n_tag, 'il numero dei bambini scelti sopravvive').toBe(1);

    // L'elenco dell'insegnante lo dice «pubblicato» e lo lega alla riga di galleria.
    const elenco = await request.get(`/api/video-uploads?canale=gallery&scuolaId=${IDS.SCUOLA}`, { timeout: 60_000 });
    expect(elenco.status()).toBe(200);
    const voce = ((await elenco.json()) as { voci: Array<Record<string, unknown>> }).voci.find((v) => v.intentId === aperto.intentId);
    expect(voce).toMatchObject({ fase: 'pubblicato', mediaId: media.id, nBambini: 1, pubblicazioneAutomatica: true, codice: null });

    // ── 5. POSITIVO: la famiglia di Aurora lo vede e ha la notifica ─────────────────────────────────
    const galleriaDiAurora = await famigliaDiAurora.get(`/api/gallery?studentId=${IDS.A1}&limit=50&offset=0`, { timeout: 60_000 });
    expect(galleriaDiAurora.status()).toBe(200);
    const mediaDiAurora = ((await galleriaDiAurora.json()) as { media: Array<{ id: string; file_type: string; caption: string | null }> }).media;
    const suo = mediaDiAurora.find((m) => m.id === media.id);
    expect(suo, 'la galleria di Aurora contiene il video appena pubblicato').toBeDefined();
    expect(suo?.file_type).toBe('video');
    expect(suo?.caption).toBeNull();

    const famiglia = await browser.newContext({ storageState: STORAGE.genitore, serviceWorkers: 'block' });
    try {
      const pagina = await famiglia.newPage();
      const lettura = pagina.waitForResponse(
        (r) => new URL(r.url()).pathname === '/api/gallery' && r.request().method() === 'GET',
        { timeout: 120_000 },
      );
      await pagina.goto(`/parent/gallery?id=${IDS.A1}`);
      expect((await lettura).ok()).toBe(true);
      // La scheda di un contenuto nuovo si chiama soltanto «Video» (con una didascalia sarebbe «Video: <didascalia>»).
      await expect(
        pagina.locator('[data-testid="griglia-media"] [role="button"][aria-label="Video"]'),
        'la pagina della famiglia disegna la scheda del video nuovo',
      ).toHaveCount(1, { timeout: 60_000 });
    } finally {
      await famiglia.close();
    }

    const nuoveGalleria = (await notificheDi(db, 'galleria', IDS.DOCENTE)).filter((n) => !galleriaPrima.has(n.id));
    expect(
      [...new Set(nuoveGalleria.map((n) => n.utente_id))],
      'l\'avviso «Nuovi contenuti in galleria» è nato per i soli genitori del bambino taggato',
    ).toEqual([IDS.GENITORE]);
    expect(nuoveGalleria, 'una notifica sola per famiglia: il debounce collassa le raffiche').toHaveLength(1);
    expect(nuoveGalleria[0]).toMatchObject({
      titolo: 'Nuovi contenuti in galleria',
      corpo: 'Ci sono nuovi contenuti nella galleria.',
      link: '/parent/gallery',
      entita_tipo: 'galleria',
      entita_id: IDS.DOCENTE,
    });

    const notificheFamiglia = await famigliaDiAurora.get('/api/notifiche', { timeout: 60_000 });
    expect(notificheFamiglia.status()).toBe(200);
    const elencoFamiglia = ((await notificheFamiglia.json()) as { data: Array<{ tipo: string; titolo: string }> }).data;
    expect(
      elencoFamiglia.some((n) => n.tipo === 'galleria' && n.titolo === 'Nuovi contenuti in galleria'),
      'la campanella della famiglia mostra l\'avviso',
    ).toBe(true);

    // ── 6. NEGATIVO: il genitore di un bambino NON taggato, della stessa sede, non lo vede e non lo sa ──────
    const galleriaDiFiore = await altraFamiglia.get(`/api/gallery?studentId=${IDS.A5}&limit=50&offset=0`, { timeout: 60_000 });
    expect(galleriaDiFiore.status()).toBe(200);
    const mediaDiFiore = ((await galleriaDiFiore.json()) as { media: Array<{ id: string; caption: string | null }> }).media;
    // L'ANCORA: la vista di Fiore ha caricato, e contiene la foto seminata per lui.
    expect(
      mediaDiFiore.map((m) => m.caption),
      'la galleria di Fiore ha caricato (ancora del negativo: la sua foto seminata)',
    ).toContain(DOPPIO_PROFILO_E2E.fotoSede1);
    expect(mediaDiFiore.map((m) => m.id), 'il video di Aurora non è nella galleria di un bambino che non c\'è').not.toContain(media.id);

    const notificheAltra = await altraFamiglia.get('/api/notifiche', { timeout: 60_000 });
    expect(notificheAltra.status()).toBe(200);
    const elencoAltra = ((await notificheAltra.json()) as { data: Array<{ tipo: string }> }).data;
    expect(elencoAltra.some((n) => n.tipo === 'galleria'), 'nessun avviso «galleria» per chi non è fra i destinatari').toBe(false);

    // ── 7. L'INSEGNANTE: l'esito «pubblicato», e nessun avviso di liberatoria ─────────────────────────
    const esiti = await notificheDi(db, 'video_esito', aperto.intentId);
    expect(esiti, 'una sola notifica d\'esito per intento (la marca «una volta sola»)').toHaveLength(1);
    expect(esiti[0]).toMatchObject({
      utente_id: IDS.DOCENTE,
      corpo: 'Il tuo video è stato pubblicato in galleria.',
      link: '/teacher/gallery',
      entita_tipo: 'video',
    });
    const liberatoriaDopo = (await notificheDi(db, 'video_liberatoria_revocata')).filter((n) => !liberatoriaPrima.has(n.id));
    expect(liberatoriaDopo, 'un bambino solo: nessuno ha perso la liberatoria, nessun avviso di sicurezza').toHaveLength(0);

    // E dello stesso video, per lo stato del job: il giro non lo ha toccato di nuovo.
    expect((await leggiJob(db, aperto.jobId))?.status).toBe('ready');
  } finally {
    // ── LA PULIZIA, nell'ordine che non lascia un file senza riga né una riga senza file ──────────────────
    if (mediaId) {
      const cestino = await request.delete(`/api/gallery?id=${mediaId}&userId=${IDS.DOCENTE}`, { timeout: 60_000 });
      if (cestino.ok() && intento) await togliCopiaInGalleria(db, { intentId: intento.intentId, proprietario: IDS.DOCENTE });
      else if (!cestino.ok()) console.warn(`[e2e video] video non messo nel cestino: HTTP ${cestino.status()}`);
    }
    if (intento) await ritiraIntentoVideo(request, db, intento);
    await staff.dispose();
    await famigliaDiAurora.dispose();
    await altraFamiglia.dispose();
  }
});
