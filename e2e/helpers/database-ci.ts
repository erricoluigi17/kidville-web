import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * IL DATABASE SU CUI GLI SPEC VIDEO SCRIVONO CON LA CHIAVE DI SERVIZIO — e l'unico.
 *
 * ─── PERCHÉ ESISTE ──────────────────────────────────────────────────────────────
 * Fino alla PR 2 dei video (2026-10-02) nessuno spec apriva da sé un client con la chiave di servizio:
 * scriveva solo il seed (`scripts/seed-e2e.mjs`), che davanti a ogni operazione ha una guardia sull'host.
 * Gli spec video ne hanno bisogno — simulare la conversione che in CI non può girare (il Sandbox di
 * Vercel non c'è), rileggere lo stato di un job, togliere i byte che hanno caricato, accendere e spegnere
 * una liberatoria — e la stessa guardia viaggia con loro. Il motivo è quello del seed: `.env.local`
 * punta al database di PRODUZIONE, la chiave di servizio scavalca ogni RLS, e un client aperto sul
 * progetto sbagliato per un `NEXT_PUBLIC_SUPABASE_URL` rimasto in una shell sarebbe l'incidente peggiore
 * di tutta la suite — su una tabella di intenti che porta gli identificativi di bambini veri.
 *
 * ─── LE DUE GUARDIE, E PERCHÉ SONO DUE ──────────────────────────────────────────
 *  1. `CI` deve essere impostata: gli spec che scrivono con questo client girano solo nel job E2E (è la
 *     stessa frase di `gallery-caricamento`: «questo collaudo scrive solo nel database E2E della CI»);
 *  2. l'URL deve essere ESATTAMENTE quello del progetto Supabase della CI, lo stesso che il seed accetta.
 *     ⚠️ RICOPIATO da `scripts/seed-e2e.mjs` (`databaseIsolato`): gli spec Playwright non importano
 *     moduli `.mjs` dello stesso repo, e il seed esegue `main()` appena lo si importa. Se cambia il
 *     progetto della CI si cambia in entrambi i posti. L'`globalSetup` lancia comunque il seed PRIMA di
 *     ogni test, e il seed esce con errore su un URL diverso: questa è la seconda cintura, nel punto in
 *     cui la chiave viene davvero usata.
 *
 * Nessun messaggio d'errore di questo file ripete l'URL o la chiave ricevuti: potrebbero essere quelli
 * sbagliati, ed è già il caso in cui non devono finire in un log.
 */
const URL_DATABASE_CI = 'https://azhssawihitkphgnlukl.supabase.co/';

export function clienteDatabaseCi(): SupabaseClient {
  if (!process.env.CI) {
    throw new Error(
      'Questo spec scrive sul database con la chiave di servizio e gira solo nel job E2E della CI ' +
        '(variabile CI assente). In locale `.env.local` punta al database di PRODUZIONE: ' +
        '`npx playwright test` e `npm run e2e` restano vietati.',
    );
  }

  const url = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').trim();
  const chiave = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim();
  let normalizzato = '';
  try {
    normalizzato = new URL(url).href;
  } catch {
    // Un URL che non si legge non è quello della CI: lo dice il controllo qui sotto, senza ripeterlo.
    normalizzato = '';
  }
  if (normalizzato !== URL_DATABASE_CI) {
    throw new Error(
      'NEXT_PUBLIC_SUPABASE_URL non è il progetto Supabase della CI: nessuna operazione eseguita ' +
        '(l\'indirizzo ricevuto non si stampa).',
    );
  }
  if (!chiave) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY assente: lo spec non può leggere né simulare lo stato dei video.');
  }

  return createClient(url, chiave, { auth: { persistSession: false, autoRefreshToken: false } });
}

/** Le colonne che la PR 2 aggiunge a `video_intents` (file A): se ne manca una, il database non è migrato. */
const COLONNE_INTENTI =
  'pubblicazione_automatica, tag_alunni, broadcast, classi_destinatarie, n_tag, trasporto, esito_notificato, pubblicazione_errore';

/** Le colonne che le due PR aggiungono a `video_jobs` (ritentativi di PR 1, file A di PR 2). */
const COLONNE_JOB =
  'byte_dichiarati, mime_dichiarato, durata_dichiarata_s, sha256_dichiarato, arrivato_il, sorgente_etag, ' +
  'rinnovo_token_hash, rinnovo_token_scade_il, rinnovo_token_revocato_il, output_delete_after, next_attempt_at, last_error_code';

/** I tre bucket che la pipeline usa: i due di lavorazione (migrazione del 18/09) e la galleria (seed). */
const BUCKET_NECESSARI = ['video_originals', 'video_processing', 'gallery'] as const;

/**
 * PRIMA DI OGNI SPEC VIDEO: il database ha lo schema della PR 2?
 *
 * ─── PERCHÉ UNA PRECONDIZIONE, E NON UN ROSSO QUALUNQUE ─────────────────────────────────────
 * Il database della CI è un progetto separato che NON viene migrato da solo (vedi `docs/e2e.md` e il
 * workflow `migrate-ci.yml`, a mano). Senza le migrazioni della PR 2 le route video non rispondono con un
 * errore leggibile: leggono una colonna che non c'è e rispondono 500 (`42703`) — è il secondario #93
 * della PR, annotato apposta per questo punto. Un E2E rosso su un 500 senza spiegazione manda a cercare un
 * difetto del codice in un punto dove c'è solo uno schema vecchio. Qui il test si ferma PRIMA, con una
 * frase che dice cosa applicare. Costa quattro richieste e nessuna scrittura.
 *
 * Non controlla il trigger sullo Storage (file B) né le RPC della conservazione (file C): nessuno dei due
 * si può interrogare senza scrivere, e lo spec che ne dipende lo prova da sé con un messaggio suo
 * (`video-rinnovo-token`: «il trigger d'arrivo non ha portato il job in coda»).
 */
export async function richiediPipelineVideo(db: SupabaseClient): Promise<void> {
  const mancanze: string[] = [];

  for (const [tabella, colonne] of [
    ['video_intents', COLONNE_INTENTI],
    ['video_jobs', COLONNE_JOB],
  ] as const) {
    const { error } = await db.from(tabella).select(colonne).limit(1);
    if (error) mancanze.push(`${tabella}: ${error.code ?? 'SENZA_CODICE'} ${error.message}`);
  }
  for (const bucket of BUCKET_NECESSARI) {
    const { error } = await db.storage.getBucket(bucket);
    if (error) mancanze.push(`bucket ${bucket}: ${error.message}`);
  }

  if (mancanze.length > 0) {
    throw new Error(
      'Il database della CI non ha ancora la pipeline video della PR 2 — non è un difetto del codice. ' +
        'Vanno applicate con il workflow «DB migrate (CI)» (`migrate-ci.yml`, a mano) le due migrazioni ' +
        'della PR 1 (`*_video_build_bucket.sql`, `*_video_job_ritentativi.sql`) e le tre della PR 2 ' +
        '(`*_video_pubblicazione_automatica.sql`, `*_video_arrivo_originale.sql`, ' +
        '`*_video_conservazione_uscite.sql`). Mancanze rilevate: ' +
        mancanze.join(' | '),
    );
  }
}
