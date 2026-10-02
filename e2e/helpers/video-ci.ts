import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { expect, type APIRequestContext, type APIResponse } from '@playwright/test';
import type { SupabaseClient } from '@supabase/supabase-js';
import { IDS } from '../fixtures';

/**
 * GLI STRUMENTI COMUNI DEGLI SPEC VIDEO DELLA PR 2 (2026-10-02): `video-invio-bambini-prima`,
 * `video-ripresa-automatica`, `video-rinnovo-token`, `video-destinatari`.
 *
 * Qui sta tutto ciò che più di uno spec deve fare ALLO STESSO MODO — aprire un intento, leggere ciò che il
 * database dice di un job, simulare la conversione che in CI non può girare, ripulire — perché sono
 * le operazioni su cui le due metà di uno stesso fatto (la risposta HTTP e la riga in tabella) si
 * confrontano, e due copie divergono alla prima modifica. Gli spec tengono per sé solo ciò che dicono:
 * le asserzioni e il perché.
 *
 * ⚠️ Niente di ciò che è qui legge o scrive dati veri: gli account sono quelli del seed E2E, i bambini
 * sono Aurora e Bruno «-E2E», i byte dei video sono casuali. Le funzioni che usano il client di servizio
 * lo ricevono per argomento (lo costruisce `clienteDatabaseCi`, che ha la guardia sull'host).
 */

/**
 * L'unica dimensione di blocco che il TUS di Supabase accetta: 6 MiB («it must be set to 6MB (for now)
 * do not change it»). ⚠️ RICOPIATA da `DIMENSIONE_BLOCCO_TUS_BYTE` di `src/lib/media/video/contratto.ts`:
 * lo spec è eseguito da Playwright e non importa moduli applicativi, che trascinerebbero con sé mezzo
 * server. Se il servizio cambiasse numero, cambierebbe il contratto e questo spec diventerebbe rosso nel
 * punto giusto: l'offset di ripresa che si aspetta non sarebbe più quello.
 */
export const BLOCCO_TUS_BYTE = 6 * 1024 * 1024;

/** Il tipo con cui si dichiarano tutti i video di questi spec. */
export const MIME_VIDEO = 'video/mp4';

/**
 * L'identità con cui `video-destinatari` SIMULA la conversione (la presa e il `ready` del job).
 *
 * ⚠️ DEVE essere diversa da `VIDEO_RUNNER_OWNER_ID` di `playwright.config.ts` (`…f001`): quella è
 * l'identità del runner vero che lo spec fa girare subito dopo, e con la stessa il giro del runner
 * riprenderebbe come «suo» il job che lo spec sta ancora costruendo. Un uuid finto, senza segreti.
 */
export const LAVORATORE_SIMULATO = 'e2e00000-0000-4000-8000-00000000f002';

/** Il primo pezzo di un MP4 vero: il box `ftyp` (24 byte, brand `isom`). Il resto, in `videoFinto`, è rumore. */
const INIZIO_MP4 = Buffer.from('000000186674797069736f6d0000020069736f6d6d703431', 'hex');

/**
 * Un «video» di `byte` byte: la testata di un MP4 e poi byte casuali.
 *
 * Non è un filmato e non deve esserlo: in CI nessuno lo decodifica (il Sandbox che converte non c'è) e ciò
 * che gli spec provano è il TRASPORTO, l'arrivo e lo stato — mai l'immagine. I byte sono casuali per due
 * ragioni: l'impronta SHA-256 cambia a ogni giro (quella dichiarata dal trasporto nativo non può
 * coincidere con quella di un giro precedente) e nessun livello della catena può «riconoscere» un file già
 * visto. La testata è vera perché `classificaFileGalleria` e lo Storage guardano il tipo dichiarato, ma un
 * file che si presenta come MP4 e comincia come un MP4 evita a un lettore futuro di domandarsi se il banco
 * di prova sia rotto.
 */
export function videoFinto(byte: number): Buffer {
  if (byte < INIZIO_MP4.length) throw new RangeError('un video finto pesa almeno quanto la sua testata');
  return Buffer.concat([INIZIO_MP4, randomBytes(byte - INIZIO_MP4.length)]);
}

/** L'impronta SHA-256 di un file, in esadecimale minuscolo (64 caratteri): ciò che il trasporto nativo dichiara. */
export function improntaSha256(contenuto: Buffer): string {
  return createHash('sha256').update(contenuto).digest('hex');
}

/** Un nome di file diverso a ogni giro, senza nomi di persone: la chiave d'idempotenza del web ne dipende. */
export function nomeVideoUnico(prefisso: string): string {
  return `${prefisso}-${randomUUID()}.mp4`;
}

/** Una chiave d'idempotenza diversa a ogni giro (al massimo 128 caratteri: `e2e-` + prefisso + uuid). */
export function chiaveUnica(prefisso: string): string {
  return `e2e-${prefisso}-${randomUUID()}`;
}

/** Un token di rinnovo ben FORMATO ma che nessuno ha mai coniato: `kvr_` + 32 byte casuali in base64url (43 caratteri). */
export function tokenRinnovoFalso(): string {
  return `kvr_${randomBytes(32).toString('base64url')}`;
}

/** La prima riga di un errore, per i messaggi di chi ripulisce: mai l'oggetto intero (può portare indirizzi firmati). */
export function messaggioDi(errore: unknown): string {
  return errore instanceof Error ? errore.message.split('\n')[0] : String(errore);
}

/* ────────────────────────────────────────────────────────────────────────────
 * L'APERTURA DI UN INTENTO — la stessa richiesta che la pagina della galleria manda
 * ──────────────────────────────────────────────────────────────────────────── */

/** Un job come l'apertura lo restituisce: le coordinate TUS (`firma`) oppure l'URL di PUT (`rinnovo`). */
export interface JobAperto {
  jobId: string;
  chiaveIdempotenza: string;
  firma: string;
  status: string;
  needs_upload: boolean;
  expires_at: string | null;
  caricamento: {
    protocollo: string;
    endpoint?: string;
    bucket?: string;
    percorso?: string;
    contentType?: string;
    dimensioneBloccoByte?: number;
    url?: string;
    metodo?: string;
    intestazioni?: Record<string, string>;
  };
  rinnovo?: { token: string; scadeIl: string };
}

export interface IntentoAperto {
  intentId: string;
  revisione: number;
  statoIntent: string;
  jobId: string;
  job: JobAperto;
}

/** Ciò che serve di una risposta per leggerla: lo soddisfano sia `APIResponse` sia la `Response` di una pagina. */
export interface RispostaLeggibile {
  status(): number;
  text(): Promise<string>;
}

/**
 * Legge una risposta di APERTURA riuscita (201) e ne ricava intento e job.
 *
 * Un'apertura non riuscita fa fallire con lo stato e l'INIZIO del corpo: sono risposte d'errore del
 * server (un codice e una frase), che non portano né firme né token. Una riuscita non si stampa mai: porta
 * un URL firmato o un token di rinnovo, cioè credenziali.
 */
export async function leggiApertura(risposta: RispostaLeggibile): Promise<IntentoAperto> {
  const testo = await risposta.text();
  const stato = risposta.status();
  expect(stato, `POST /api/video-uploads: atteso 201, risposta ${stato}${stato === 201 ? '' : ` — ${testo.slice(0, 300)}`}`).toBe(201);

  const corpo = JSON.parse(testo) as {
    intentId?: string;
    revisione?: number;
    intent?: { status?: string };
    job?: JobAperto[];
  };
  const job = corpo.job?.[0];
  if (!corpo.intentId || typeof corpo.revisione !== 'number' || !job?.jobId) {
    throw new Error('POST /api/video-uploads ha risposto 201 senza intentId, revisione o job: risposta fuori contratto.');
  }
  return {
    intentId: corpo.intentId,
    revisione: corpo.revisione,
    statoIntent: corpo.intent?.status ?? 'sconosciuto',
    jobId: job.jobId,
    job,
  };
}

/**
 * Apre un intento di galleria CON I BAMBINI, come farebbe la pagina (o l'app 1.2 col trasporto nativo).
 *
 * Restituisce la risposta intera e non l'esito: gli spec che provano i rifiuti (400, 409, 422) la leggono
 * da sé, quelli che vogliono un intento aperto la passano a `leggiApertura`. La sede è sempre quella del
 * seed (`IDS.SCUOLA`): ogni scrittura dichiara la sua, e la docente E2E ne ha una sola.
 */
export function apriIntentoVideo(
  request: APIRequestContext,
  opzioni: {
    file: Buffer;
    nome: string;
    /** I bambini ritratti. Un bambino solo non richiede nessuna liberatoria («foto privata»). */
    tag: string[];
    trasporto?: 'tus' | 'put-nativo';
    mime?: string;
    durataSecondi?: number | null;
    chiave?: string;
    /** Per provare i rifiuti dello schema: sovrascrive l'impronta (o la omette con `null`). */
    sha256?: string | null;
  },
): Promise<APIResponse> {
  const trasporto = opzioni.trasporto ?? 'tus';
  const sha256 = opzioni.sha256 === undefined
    ? (trasporto === 'put-nativo' ? improntaSha256(opzioni.file) : null)
    : opzioni.sha256;
  return request.post('/api/video-uploads', {
    data: {
      canale: 'gallery',
      azione: 'publish',
      scuolaId: IDS.SCUOLA,
      ambitoGlobale: false,
      targetId: null,
      versioneTargetAttesa: null,
      destinatari: { tagAlunni: opzioni.tag, broadcast: false, classi: [] },
      trasporto,
      file: [
        {
          chiaveIdempotenza: opzioni.chiave ?? chiaveUnica('video'),
          nome: opzioni.nome,
          byte: opzioni.file.length,
          mime: opzioni.mime ?? MIME_VIDEO,
          durataSecondi: opzioni.durataSecondi ?? null,
          ...(sha256 === null ? {} : { sha256 }),
        },
      ],
    },
    // La prima richiesta a una route compila la route (next dev): il tetto dei 30 secondi di default non basta.
    timeout: 90_000,
  });
}

/* ────────────────────────────────────────────────────────────────────────────
 * LE RIGHE, DAL DATABASE — la metà di un fatto che l'HTTP non dice
 * ──────────────────────────────────────────────────────────────────────────── */

export interface RigaJobVideo {
  id: string;
  intent_id: string;
  owner_id: string;
  scuola_id: string | null;
  status: string;
  attempt: number;
  fence_epoch: number;
  original_bucket: string;
  original_path: string;
  output_bucket: string | null;
  output_path: string | null;
  source_size: number | null;
  source_mime: string | null;
  byte_dichiarati: number | null;
  mime_dichiarato: string | null;
  arrivato_il: string | null;
  rinnovo_token_revocato_il: string | null;
  error_code: string | null;
}

export interface RigaIntentoVideo {
  id: string;
  owner_id: string;
  scuola_id: string | null;
  channel: string;
  status: string;
  revision: number;
  pubblicazione_automatica: boolean;
  /** ⚠️ Identificativi di (finti) bambini: si confrontano, non si stampano. */
  tag_alunni: string[] | null;
  broadcast: boolean;
  n_tag: number;
  trasporto: string;
  esito_notificato: string | null;
  pubblicazione_errore: string | null;
}

export async function leggiJob(db: SupabaseClient, jobId: string): Promise<RigaJobVideo | null> {
  const { data, error } = await db.from('video_jobs').select('*').eq('id', jobId).maybeSingle();
  if (error) throw new Error(`lettura di video_jobs fallita: ${error.code ?? ''} ${error.message}`);
  return (data ?? null) as RigaJobVideo | null;
}

export async function leggiIntento(db: SupabaseClient, intentId: string): Promise<RigaIntentoVideo | null> {
  const { data, error } = await db.from('video_intents').select('*').eq('id', intentId).maybeSingle();
  if (error) throw new Error(`lettura di video_intents fallita: ${error.code ?? ''} ${error.message}`);
  return (data ?? null) as RigaIntentoVideo | null;
}

/** Quanti intenti ha un proprietario, in qualunque stato: serve a provare che un rifiuto non ne ha creato nessuno. */
export async function contaIntentiDi(db: SupabaseClient, ownerId: string): Promise<number> {
  const { count, error } = await db
    .from('video_intents')
    .select('id', { count: 'exact', head: true })
    .eq('owner_id', ownerId);
  if (error) throw new Error(`conteggio di video_intents fallito: ${error.code ?? ''} ${error.message}`);
  return count ?? 0;
}

/** La dimensione di un oggetto nello Storage, o `null` se non c'è. */
export async function dimensioneOggetto(db: SupabaseClient, bucket: string, percorso: string): Promise<number | null> {
  const { data, error } = await db.storage.from(bucket).info(percorso);
  if (error || !data) return null;
  return typeof data.size === 'number' ? data.size : null;
}

/** Attende che un job arrivi in uno stato, con un messaggio che dice cosa NON è successo. */
export async function attendiStatoJob(
  db: SupabaseClient,
  jobId: string,
  atteso: string,
  motivo: string,
  timeout = 60_000,
): Promise<void> {
  await expect
    .poll(async () => (await leggiJob(db, jobId))?.status ?? 'assente', {
      message: motivo,
      timeout,
      intervals: [500, 1_000, 2_000],
    })
    .toBe(atteso);
}

/* ────────────────────────────────────────────────────────────────────────────
 * LA PULIZIA — ciascuno spec toglie ciò che sa di aver fatto
 * ──────────────────────────────────────────────────────────────────────────── */

const STATI_INTENTO_CONCLUSI = ['published', 'cancelled', 'superseded'];

/** Toglie degli oggetti da un bucket; un errore si dice e non ferma la pulizia (non c'è niente da ritentare). */
async function togliOggetti(db: SupabaseClient, bucket: string, percorsi: Array<string | null | undefined>): Promise<void> {
  const validi = percorsi.filter((p): p is string => typeof p === 'string' && p.length > 0);
  if (validi.length === 0) return;
  const { error } = await db.storage.from(bucket).remove(validi);
  if (error) console.warn(`[e2e video] oggetti non rimossi da ${bucket}: ${error.message}`);
}

/**
 * IL RITIRO DI UN VIDEO APERTO DA UNO SPEC: l'intento si annulla e i byte si tolgono.
 *
 * Fa due cose, e nessuna le fa fallire il test: (1) se l'intento non è già concluso lo annulla con la
 * stessa azione del pulsante «Rimuovi» (`PATCH … annulla`, con la revisione di adesso: cambia a ogni
 * passo del ciclo); (2) toglie dallo Storage l'originale e l'eventuale uscita. Resta la riga di galleria
 * di un video pubblicato: la toglie lo spec che l'ha prodotta (`video-destinatari`), perché sa se il suo
 * `DELETE` è riuscito. Ogni passo che non riesce lascia una riga sul terminale e va avanti: una pulizia
 * che si ferma al primo errore lascia più sporco di una che non c'è — e `scripts/seed-e2e.mjs` rimette a
 * posto tutto al run successivo (`ripulisciVideoE2E`).
 *
 * Perché serve davvero, e non basta il seed: un intento rimasto vivo comparirebbe come scheda nella
 * galleria della docente dei test che girano DOPO (l'elenco mostra per sempre gli intenti non terminali),
 * e il giro del runner di `video-destinatari` lo pescherebbe dalla coda.
 */
export async function ritiraIntentoVideo(
  request: APIRequestContext,
  db: SupabaseClient,
  intento: { intentId: string; jobId: string },
): Promise<void> {
  try {
    const stato = await request.get(`/api/video-uploads/${intento.intentId}`, { timeout: 60_000 });
    if (stato.ok()) {
      const corpo = (await stato.json()) as { statoIntent?: string; revisione?: number };
      if (!STATI_INTENTO_CONCLUSI.includes(corpo.statoIntent ?? '') && typeof corpo.revisione === 'number') {
        const annullo = await request.patch(`/api/video-uploads/${intento.intentId}`, {
          data: { azione: 'annulla', revisione: corpo.revisione },
          timeout: 60_000,
        });
        if (!annullo.ok()) console.warn(`[e2e video] intento non annullato: HTTP ${annullo.status()}`);
      }
    } else {
      console.warn(`[e2e video] stato dell'intento non letto: HTTP ${stato.status()}`);
    }
  } catch (errore) {
    console.warn(`[e2e video] annullo dell'intento non riuscito: ${messaggioDi(errore)}`);
  }

  try {
    const job = await leggiJob(db, intento.jobId);
    if (job) {
      await togliOggetti(db, job.original_bucket, [job.original_path]);
      await togliOggetti(db, job.output_bucket ?? 'video_processing', [job.output_path]);
    }
  } catch (errore) {
    console.warn(`[e2e video] oggetti del job non rimossi: ${messaggioDi(errore)}`);
  }
}

/** La copia in `gallery` di un video pubblicato: percorso deterministico `uploads/<proprietario>/v-<intento>.mp4`. */
export async function togliCopiaInGalleria(
  db: SupabaseClient,
  intento: { intentId: string; proprietario: string },
): Promise<void> {
  await togliOggetti(db, 'gallery', [`uploads/${intento.proprietario}/v-${intento.intentId}.mp4`]);
}

/* ────────────────────────────────────────────────────────────────────────────
 * LA CONVERSIONE SIMULATA e il giro del runner — ciò che in CI non può girare da solo
 * ──────────────────────────────────────────────────────────────────────────── */

export interface UscitaSimulata {
  percorso: string;
  byte: number;
  fence: number;
}

/**
 * LA CONVERSIONE CHE IN CI NON PUÒ GIRARE, fatta a mano come la farebbe il runner.
 *
 * Il runner vero apre una MicroVM del Vercel Sandbox, scarica l'originale, lo converte con FFmpeg e
 * scrive il `ready`: in CI non ci sono né le credenziali né il tempo. Ciò che interessa di questo passo
 * è il suo ESITO — un job `ready` con un'uscita nel bucket di lavorazione e l'evento
 * `gallery.auto_publish` accodato nella stessa transazione — e quell'esito si produce con le STESSE due
 * RPC che userebbe il runner (`video_job_claim`, `video_job_ready`), con gli stessi argomenti:
 *
 *  1. la presa del job (`attempt`, `fence_epoch`, lease): il `fence_epoch` è ciò che dà il nome all'uscita;
 *  2. l'uscita nel bucket di lavorazione, al percorso che il runner userebbe
 *     (`<proprietario>/<job>/<fence>.mp4`: ⚠️ è `percorsoUscitaVideo` di
 *     `src/lib/media/video/runner/preparazione.ts`, ricopiata per la ragione di `BLOCCO_TUS_BYTE`);
 *  3. il `ready`, che rivela il file come uscita e — per un intento con pubblicazione automatica — accoda
 *     la pubblicazione.
 *
 * Il job deve essere `queued`. Un rifiuto di una RPC ferma il test con il suo CODICE: la risposta intera
 * porta le colonne del job, e fra quelle l'impronta e l'hash del token (non si stampano).
 */
export async function simulaConversione(db: SupabaseClient, jobId: string): Promise<UscitaSimulata> {
  const riga = await leggiJob(db, jobId);
  if (!riga) throw new Error('simulaConversione: il job non esiste');

  const presa = await db.rpc('video_job_claim', {
    p_job_id: jobId,
    p_lease_owner: LAVORATORE_SIMULATO,
    p_lease_seconds: 900,
  });
  const esitoPresa = presa.data as { ok?: boolean; code?: string; job?: { fence_epoch?: number } } | null;
  if (presa.error || esitoPresa?.ok !== true || typeof esitoPresa.job?.fence_epoch !== 'number') {
    throw new Error(
      `video_job_claim rifiutata: ${presa.error ? `${presa.error.code ?? ''} ${presa.error.message}` : esitoPresa?.code ?? 'esito fuori forma'}`,
    );
  }
  const fence = esitoPresa.job.fence_epoch;

  const percorso = `${riga.owner_id}/${jobId}/${fence}.mp4`;
  const contenuto = videoFinto(4096);
  const caricata = await db.storage.from('video_processing').upload(percorso, contenuto, {
    contentType: MIME_VIDEO,
    upsert: true,
  });
  if (caricata.error) throw new Error(`uscita simulata non caricata: ${caricata.error.message}`);

  const pronto = await db.rpc('video_job_ready', {
    p_job_id: jobId,
    p_fence_epoch: fence,
    p_lease_owner: LAVORATORE_SIMULATO,
    p_output_path: percorso,
    p_output_size: contenuto.length,
    p_probe_json: { durationSeconds: 1, width: 16, height: 16 },
  });
  const esitoReady = pronto.data as { ok?: boolean; code?: string } | null;
  if (pronto.error || esitoReady?.ok !== true) {
    throw new Error(
      `video_job_ready rifiutata: ${pronto.error ? `${pronto.error.code ?? ''} ${pronto.error.message}` : esitoReady?.code ?? 'esito fuori forma'}`,
    );
  }
  return { percorso, byte: contenuto.length, fence };
}

export interface EsitoGiroRunner {
  stato: number;
  /** L'`esito` del runner (`coda-vuota`, `pronto`, …) o, per un 503, il `codice` della configurazione assente. */
  esito: string | null;
}

/**
 * UN GIRO DEL RUNNER, chiesto come lo chiederebbe lo staff: `POST /api/video/runner` a corpo vuoto.
 *
 * Il corpo vuoto è quello del cron: il giro intero (recupero degli arrivi, ventaglio, PUBBLICAZIONI, esiti,
 * un job nuovo). In CI il pezzo che interessa è uno solo — il consumo dell'outbox, cioè la pubblicazione
 * automatica — e gli altri non possono avere effetto: `pg_net` non c'è (il ventaglio non calcia nessuno) e il
 * Sandbox non ha credenziali (un job in coda, se ce ne fosse uno, prenderebbe un guasto nostro e un
 * ritentativo: innocuo, ed è il motivo per cui il seed toglie i video dei run precedenti).
 *
 * Il tempo è generoso (170 s): la prima chiamata compila la route e il suo albero di moduli (`next dev`),
 * e il giro in sé non ha un tetto più corto di quello della piattaforma.
 */
export async function giraRunner(staff: APIRequestContext): Promise<EsitoGiroRunner> {
  const risposta = await staff.post('/api/video/runner', { timeout: 170_000 });
  let esito: string | null = null;
  try {
    const corpo = (await risposta.json()) as { esito?: unknown; codice?: unknown };
    if (typeof corpo.esito === 'string') esito = corpo.esito;
    else if (typeof corpo.codice === 'string') esito = corpo.codice;
  } catch {
    // Un corpo che non è JSON (un 500 di Next in HTML): resta `null`, e lo stato HTTP dice già il resto.
    esito = null;
  }
  return { stato: risposta.status(), esito };
}
