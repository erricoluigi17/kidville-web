// @vitest-environment node

/**
 * LA PUBBLICAZIONE AUTOMATICA DEI VIDEO — il file A della PR 2, provato sul file di migrazione VERO.
 *
 * Stesso impianto di `video-intents.test.ts` e `video-job-ritentativi.test.ts`: PGlite, i ruoli di
 * Supabase ricostruiti a mano, e le migrazioni lette **dal disco**, nell'ordine in cui la produzione
 * le ha applicate. Un test che ripete l'SQL dentro di sé prova la propria copia, e resta verde il
 * giorno in cui le due divergono.
 *
 * ─── COME SI TROVA LA MIGRAZIONE DI QUESTA PR ────────────────────────────────────────────
 *
 * Per SUFFISSO del nome, non per nome intero: il file nasce con un timestamp provvisorio e T16 lo
 * rinomina con l'istante vero dell'applicazione. Un test che ne conoscesse il nome intero si
 * romperebbe proprio in quel momento, e chi lo ripara a mano rischia di aggiustare il test invece
 * del file.
 *
 * ─── COME È FATTO, per essere veloce ─────────────────────────────────────────────────────
 *
 * Un solo database per i gruppi che non cambiano lo schema (si costruisce una volta e si svuotano
 * le tabelle prima di ogni prova); un database NUOVO per le prove che lo cambiano (la spia al posto
 * di `video_job_claim`, il finto `pg_net`, la riapplicazione, i dati della produzione già presenti).
 *
 * ─── COSA QUESTO FILE **NON** DIMOSTRA, detto qui e non in fondo ─────────────────────────
 *
 * PGlite è a CONNESSIONE SINGOLA: due transazioni davvero simultanee qui non si possono avere. Che
 * due `video_galleria_pubblica` insieme producano UNA riga, o che due `video_job_prendi` non
 * superino il tetto, richiede due transazioni in volo. Si prova invece ciò che da una connessione
 * sola si vede — la seconda chiamata DOPO la prima trova lo stato nuovo, e la disciplina che regge
 * il resto (il lock dell'intento preso per primo, il lock di capacità preso prima del conteggio) si
 * verifica sul TESTO della migrazione, con mutazioni viste rosse.
 *
 * L'OROLOGIO si muove con degli UPDATE sulle colonne, mai con uno `sleep`.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'

const CARTELLA_MIGRAZIONI = join(process.cwd(), 'supabase/migrations')
const leggi = (file: string): string => readFileSync(join(CARTELLA_MIGRAZIONI, file), 'utf8')

/** Il file che finisce con quel suffisso, e uno solo: altrimenti il test non sa quale leggere. */
function trovaPerSuffisso(suffisso: string): string {
  const trovati = readdirSync(CARTELLA_MIGRAZIONI).filter((f) => f.endsWith(suffisso))
  if (trovati.length !== 1) {
    throw new Error(
      `Cerco in supabase/migrations/ UN file che finisce con «${suffisso}» e ne trovo ` +
        `${trovati.length} (${trovati.join(', ') || 'nessuno'}). Se la migrazione è stata rinominata ` +
        `con la version registrata, il suffisso deve restare lo stesso.`,
    )
  }
  return trovati[0]
}

/**
 * Il testo senza le righe di solo commento. Un test che legge un file come TESTO legge anche i
 * commenti: ogni controllo sul testo della migrazione passa da qui.
 */
const soloCodice = (sql: string): string =>
  sql
    .split('\n')
    .filter((r) => !/^\s*--/.test(r))
    .join('\n')

const FILE_A = trovaPerSuffisso('_video_pubblicazione_automatica.sql')

// Le migrazioni già in produzione, nell'ordine di applicazione.
const SCHEMA = leggi('20260916190000_video_jobs.sql')
const TRANSIZIONI = leggi('20260916190100_video_job_transitions.sql')
const INTENTI = leggi('20260916190200_video_intent_lifecycle.sql')
const NEXT = leggi('20260917210000_video_job_next.sql')
const RETENTION = leggi('20260918110000_video_retention_riconciliazione.sql')
const BUCKET = leggi(trovaPerSuffisso('_video_build_bucket.sql'))
const RITENTATIVI = leggi(trovaPerSuffisso('_video_job_ritentativi.sql'))
// E quella di questa PR.
const MIGRAZIONE_A = leggi(FILE_A)

const SEDE = '10000000-0000-4000-8000-000000000001'
const ALTRA_SEDE = '11000000-0000-4000-8000-000000000001'
const OWNER = '20000000-0000-4000-8000-000000000002'
const ALTRO_OWNER = '21000000-0000-4000-8000-000000000002'
const A1 = 'a1000000-0000-4000-8000-0000000000a1'
const A2 = 'a2000000-0000-4000-8000-0000000000a2'
const A3 = 'a3000000-0000-4000-8000-0000000000a3'
const LEASE_A = '50000000-0000-4000-8000-000000000005'
const LEASE_B = '51000000-0000-4000-8000-000000000005'
const INV_1 = '60000000-0000-4000-8000-000000000006'
const INV_2 = '61000000-0000-4000-8000-000000000006'
const INESISTENTE = '99999999-9999-4999-8999-999999999999'

/** Le tredici funzioni nuove, ciascuna con la firma dei suoi argomenti (per i privilegi e le intestazioni). */
const FUNZIONI_NUOVE: ReadonlyArray<{ nome: string; firma: string }> = [
  { nome: 'video_galleria_intent_apri', firma: 'uuid, uuid, text, text, bigint, text, numeric, uuid[], boolean, text[], text, bytea, bytea, timestamptz' },
  { nome: 'video_rinnovo_usa', firma: 'bytea' },
  { nome: 'video_galleria_pubblica', firma: 'uuid, integer, uuid, uuid, text, uuid[]' },
  { nome: 'video_intent_esito_segna', firma: 'uuid, text' },
  { nome: 'video_intent_pubblicazione_fallita', firma: 'uuid, text' },
  { nome: 'video_intent_pubblicazione_riprova', firma: 'uuid, uuid' },
  { nome: 'video_job_sorveglianza_prendi', firma: 'uuid, uuid, integer' },
  { nome: 'video_job_sorveglianza_rilascia', firma: 'uuid, uuid' },
  { nome: 'video_job_prendi', firma: 'uuid, uuid, integer, integer' },
  { nome: 'video_job_prossimo', firma: 'uuid, integer, integer' },
  { nome: 'video_job_diagnosi', firma: 'uuid, bigint, uuid, jsonb' },
  { nome: 'video_runner_kick', firma: 'uuid' },
  { nome: 'video_runner_ventaglio', firma: 'integer, uuid' },
]

/** L'ACL che le funzioni video hanno in produzione: solo il proprietario e il service role. */
const ACL_FUNZIONI_VIDEO = '{postgres=X/postgres,service_role=X/postgres}'

type Riga = Record<string, unknown>
type Risposta = {
  ok: boolean
  code?: string
  motivo?: string
  [chiave: string]: unknown
}
/** La risposta di `video_galleria_intent_apri`, con le due righe che restituisce. */
type RispostaApri = Risposta & {
  intent?: { id: string; status: string; revision: number; [k: string]: unknown }
  job?: { id: string; status: string; original_path: string; [k: string]: unknown }
  ripetuta?: boolean
  token_ruotato?: boolean
}

let db: PGlite

async function rpc<T = Risposta>(sql: string, conn: PGlite = db): Promise<T> {
  const { rows } = await conn.query<{ risultato: T }>(`SELECT ${sql} AS risultato`)
  return rows[0].risultato
}

async function righe<T = Riga>(sql: string, conn: PGlite = db): Promise<T[]> {
  const { rows } = await conn.query<T>(sql)
  return rows
}

async function unaRiga<T = Riga>(sql: string, conn: PGlite = db): Promise<T> {
  return (await righe<T>(sql, conn))[0]
}

async function conta(tabella: string, conn: PGlite = db): Promise<number> {
  return (await unaRiga<{ n: number }>(`SELECT count(*)::int AS n FROM ${tabella}`, conn)).n
}

/** Un array di uuid come espressione SQL. */
const uuids = (xs: string[]): string => `ARRAY[${xs.map((x) => `'${x}'`).join(', ')}]::uuid[]`

/** 32 byte deterministici come espressione SQL: lo SHA-256 di un seme. */
const impronta = (seme: string): string => `sha256(convert_to('${seme}', 'UTF8'))`

/** Il database senza nessuna migrazione: ruoli, Storage, tabelle d'appoggio, galleria e log. */
async function preparaStub(conn: PGlite) {
  await conn.exec(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

    CREATE SCHEMA auth;
    CREATE TABLE auth.users (id uuid PRIMARY KEY);

    CREATE SCHEMA storage;
    CREATE TABLE storage.buckets (
      id text PRIMARY KEY,
      name text NOT NULL,
      public boolean NOT NULL DEFAULT false,
      file_size_limit bigint,
      allowed_mime_types text[],
      updated_at timestamptz DEFAULT now()
    );

    CREATE TABLE public.schools (id uuid PRIMARY KEY);
    CREATE TABLE public.utenti (
      id uuid PRIMARY KEY REFERENCES auth.users(id),
      scuola_id uuid NOT NULL REFERENCES public.schools(id)
    );

    CREATE TABLE public.log_migrazioni (payload jsonb NOT NULL);
    CREATE FUNCTION public.app_log_registra(righe jsonb)
    RETURNS int
    LANGUAGE plpgsql
    AS $$
    BEGIN
      INSERT INTO public.log_migrazioni(payload) VALUES (righe);
      RETURN 1;
    END $$;

    -- La galleria com'è in produzione: la tabella di base (20260704120000), la sede
    -- (20260714103000), il cestino (20260911214752) e l'idempotenza (20260925180000) con il suo
    -- indice UNIVOCO NON parziale: è l'arbitro dell'ON CONFLICT della pubblicazione.
    CREATE TABLE public.galleria_media_v2 (
      id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
      uploaded_by uuid NOT NULL REFERENCES public.utenti(id) ON DELETE CASCADE,
      file_url text NOT NULL,
      file_type character varying(20) DEFAULT 'foto' NOT NULL,
      caption text,
      tag_students uuid[] DEFAULT '{}' NOT NULL,
      is_broadcast boolean DEFAULT false,
      target_classes text[],
      created_at timestamptz DEFAULT CURRENT_TIMESTAMP,
      scuola_id uuid REFERENCES public.schools(id),
      eliminato_il timestamptz,
      eliminato_da uuid,
      file_rimosso_il timestamptz,
      upload_id uuid,
      upload_payload_hash text
    );
    CREATE UNIQUE INDEX galleria_media_upload_unico_idx
      ON public.galleria_media_v2 (uploaded_by, scuola_id, upload_id);

    INSERT INTO public.schools(id) VALUES ('${SEDE}'), ('${ALTRA_SEDE}');
    INSERT INTO auth.users(id) VALUES ('${OWNER}'), ('${ALTRO_OWNER}');
    INSERT INTO public.utenti(id, scuola_id) VALUES ('${OWNER}', '${SEDE}'), ('${ALTRO_OWNER}', '${SEDE}');
  `)
}

/** Le migrazioni video già in produzione (PR 1 compresa), nell'ordine in cui sono state applicate. */
async function applicaProduzione(conn: PGlite) {
  await conn.exec(SCHEMA)
  await conn.exec(TRANSIZIONI)
  await conn.exec(INTENTI)
  await conn.exec(NEXT)
  await conn.exec(RETENTION)
  await conn.exec(BUCKET)
  await conn.exec(RITENTATIVI)
}

/** Un database completo: lo stub, la produzione, e (di default) il file A. */
async function costruisci(opzioni: { conA?: boolean } = {}): Promise<PGlite> {
  const conn = new PGlite()
  await preparaStub(conn)
  await applicaProduzione(conn)
  if (opzioni.conA ?? true) await conn.exec(MIGRAZIONE_A)
  return conn
}

/** Lo svuotamento fra una prova e l'altra: tabelle del dominio e log, nello stesso comando (le FK). */
async function svuota(conn: PGlite = db) {
  await conn.exec(`
    TRUNCATE public.video_outbox, public.video_jobs, public.video_intents,
             public.galleria_media_v2, public.log_migrazioni
  `)
}

// ─────────────────────────────────────────────────────────────────────────────
// I MATTONI DEI TEST
// ─────────────────────────────────────────────────────────────────────────────

type ArgomentiApri = {
  owner: string | null
  scuola: string | null
  chiave: string | null
  percorso: string | null
  byte: number | null
  mime: string | null
  durata: number | null
  tag: string[] | null
  broadcast: boolean | null
  classi: string[] | null
  trasporto: string | null
  /** Espressioni SQL, perché sono `bytea`/`timestamptz`. */
  sha: string | null
  token: string | null
  scade: string | null
}

const lit = (v: string | number | boolean | null): string =>
  v === null ? 'NULL' : typeof v === 'string' ? `'${v}'` : String(v)

/**
 * `video_galleria_intent_apri` con gli argomenti che la route passerebbe per un video tus di due
 * bambini. Ogni prova cambia solo ciò che sta provando.
 */
function apri(parziali: Partial<ArgomentiApri> = {}, conn: PGlite = db): Promise<RispostaApri> {
  const chiave = parziali.chiave === undefined ? 'k1' : parziali.chiave
  const a: ArgomentiApri = {
    owner: OWNER,
    scuola: SEDE,
    chiave,
    percorso: chiave === null ? null : `${OWNER}/${chiave}.mp4`,
    byte: 5000,
    mime: 'video/mp4',
    durata: 20,
    tag: [A1, A2],
    broadcast: false,
    classi: null,
    trasporto: 'tus',
    sha: null,
    token: null,
    scade: null,
    ...parziali,
  }
  return rpc<RispostaApri>(
    `public.video_galleria_intent_apri(
      ${lit(a.owner)}, ${lit(a.scuola)}, ${lit(a.chiave)}, ${lit(a.percorso)},
      ${lit(a.byte)}, ${lit(a.mime)}, ${lit(a.durata)},
      ${a.tag === null ? 'NULL::uuid[]' : uuids(a.tag)}, ${lit(a.broadcast)},
      ${a.classi === null ? 'NULL::text[]' : `ARRAY[${a.classi.map((c) => `'${c}'`).join(', ')}]::text[]`},
      ${lit(a.trasporto)}, ${a.sha ?? 'NULL::bytea'}, ${a.token ?? 'NULL::bytea'},
      ${a.scade ?? 'NULL::timestamptz'}
    )`,
    conn,
  )
}

/** Gli argomenti di un caricamento NATIVO: sha256, token e scadenza fra 48 ore. */
const nativo = (seme = 't1'): Partial<ArgomentiApri> => ({
  trasporto: 'put-nativo',
  sha: impronta('contenuto'),
  token: impronta(seme),
  scade: `clock_timestamp() + interval '48 hours'`,
})

/** Apre l'intento e restituisce gli id, fallendo forte se l'apertura non riesce. */
async function aperto(
  parziali: Partial<ArgomentiApri> = {},
  conn: PGlite = db,
): Promise<{ intentId: string; jobId: string; risposta: RispostaApri }> {
  const risposta = await apri(parziali, conn)
  expect(risposta.ok, `l'apertura doveva riuscire: ${JSON.stringify(risposta)}`).toBe(true)
  return { intentId: risposta.intent!.id, jobId: risposta.job!.id, risposta }
}

/** upload → presa → `ready`, come farebbe il runner. Il job esce `ready` con fence 1. */
async function portaAPronto(
  jobId: string,
  opzioni: { durata?: number; lease?: string; conn?: PGlite } = {},
): Promise<Risposta> {
  const conn = opzioni.conn ?? db
  const lease = opzioni.lease ?? LEASE_A
  const su = await rpc(`public.video_job_uploaded('${jobId}', '${OWNER}', 5000, 'video/mp4')`, conn)
  expect(su.ok, 'upload').toBe(true)
  const preso = await rpc(`public.video_job_claim('${jobId}', '${lease}', 300)`, conn)
  expect(preso.ok, 'claim').toBe(true)
  const pronto = await rpc(
    `public.video_job_ready('${jobId}', 1, '${lease}', 'outputs/${jobId}/final.mp4', 900,
      '{"durationSeconds":${opzioni.durata ?? 20}}'::jsonb)`,
    conn,
  )
  expect(pronto.ok, `ready: ${JSON.stringify(pronto)}`).toBe(true)
  return pronto
}

/** Apre e porta a `ready`: l'intento di una galleria pronto da pubblicare. */
async function intentoPronto(
  parziali: Partial<ArgomentiApri> = {},
  conn: PGlite = db,
): Promise<{ intentId: string; jobId: string }> {
  const { intentId, jobId } = await aperto(parziali, conn)
  await portaAPronto(jobId, { conn })
  return { intentId, jobId }
}

const percorsoGalleria = (intentId: string, owner = OWNER): string => `uploads/${owner}/v-${intentId}.mp4`

function pubblica(
  intentId: string,
  tagEffettivi: string[],
  parziali: { revisione?: number; owner?: string; scuola?: string; url?: string } = {},
  conn: PGlite = db,
): Promise<Risposta> {
  const owner = parziali.owner ?? OWNER
  return rpc(
    `public.video_galleria_pubblica('${intentId}', ${parziali.revisione ?? 1}, '${owner}',
      '${parziali.scuola ?? SEDE}', '${parziali.url ?? percorsoGalleria(intentId, owner)}', ${uuids(tagEffettivi)})`,
    conn,
  )
}

/** Un job News in `awaiting_upload`, aperto dalla RPC vecchia: serve per i casi che NON sono di galleria. */
async function apriNews(chiave = 'news-1', conn: PGlite = db): Promise<{ intentId: string; jobId: string }> {
  const r = await rpc<RispostaApri>(
    `public.video_intent_open('${OWNER}', '${SEDE}', 'news', 'publish', '{"scope":"sede"}'::jsonb,
      '${chiave}', '${OWNER}/${chiave}.mp4', NULL, NULL)`,
    conn,
  )
  expect(r.ok).toBe(true)
  return { intentId: r.intent!.id, jobId: r.job!.id }
}

/** I contesti loggati dall'evento indicato, nell'ordine in cui sono stati scritti. */
async function contestiLoggati(evento: string, conn: PGlite = db): Promise<Record<string, unknown>[]> {
  const { rows } = await conn.query<{ contesto: Record<string, unknown> }>(`
    SELECT payload -> 0 -> 'contesto' AS contesto
    FROM public.log_migrazioni
    WHERE payload -> 0 ->> 'evento' = '${evento}'
    ORDER BY ctid
  `)
  return rows.map((r) => r.contesto)
}

/** Tutto ciò che è stato loggato, come un testo solo: per cercarci dentro ciò che NON deve esserci. */
async function tuttoIlLog(conn: PGlite = db): Promise<string> {
  const { rows } = await conn.query<{ t: string }>(
    `SELECT coalesce(string_agg(payload::text, ' '), '') AS t FROM public.log_migrazioni`,
  )
  return rows[0].t
}

/** Secondi fra due colonne, per non dipendere dal fuso né dal giorno in cui gira il test. */
const secondi = async (da: string, a: string, dove: string, conn: PGlite = db): Promise<number> =>
  (await unaRiga<{ s: number }>(`SELECT EXTRACT(EPOCH FROM (${a} - ${da}))::int AS s FROM ${dove}`, conn)).s

/** Sette giorni in secondi, con un'ora di tolleranza: un `interval '7 days'` sono giorni di calendario. */
const SETTE_GIORNI = 7 * 86400

// ─────────────────────────────────────────────────────────────────────────────
// 1 · LO SCHEMA E LA MIGRAZIONE
// ─────────────────────────────────────────────────────────────────────────────

// Il database condiviso: si costruisce UNA volta per tutto il file e si svuota prima di ogni prova. Le
// prove che cambiano lo schema o che vogliono ripartire da un database senza il file A ne costruiscono
// uno loro con `costruisci()`.
beforeAll(async () => {
  db = await costruisci()
}, 60_000)

afterAll(async () => {
  await db.close()
})

beforeEach(async () => {
  await svuota()
})

describe('il file A · schema', () => {
  it('aggiunge le dieci colonne di video_intents e le quattordici di video_jobs, col tipo giusto', async () => {
    const colonne = async (tabella: string, nomi: string[]) =>
      righe<{ colonna: string; tipo: string; nullo: string; default_: string | null }>(`
        SELECT column_name AS colonna, data_type AS tipo, is_nullable AS nullo, column_default AS default_
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = '${tabella}'
          AND column_name IN (${nomi.map((n) => `'${n}'`).join(', ')})
        ORDER BY column_name
      `)

    const intenti = await colonne('video_intents', [
      'pubblicazione_automatica', 'tag_alunni', 'broadcast', 'classi_destinatarie', 'n_tag', 'trasporto',
      'esito_notificato', 'esito_notificato_il', 'pubblicazione_errore', 'minimizzato_il',
    ])
    expect(intenti.map((c) => [c.colonna, c.tipo, c.nullo])).toEqual([
      ['broadcast', 'boolean', 'NO'],
      ['classi_destinatarie', 'ARRAY', 'YES'],
      ['esito_notificato', 'text', 'YES'],
      ['esito_notificato_il', 'timestamp with time zone', 'YES'],
      ['minimizzato_il', 'timestamp with time zone', 'YES'],
      ['n_tag', 'integer', 'NO'],
      ['pubblicazione_automatica', 'boolean', 'NO'],
      ['pubblicazione_errore', 'text', 'YES'],
      ['tag_alunni', 'ARRAY', 'NO'],
      ['trasporto', 'text', 'NO'],
    ])
    // I default sono quelli che lasciano il flusso vecchio com'è: non automatico, nessun tag, tus.
    const def = Object.fromEntries(intenti.map((c) => [c.colonna, c.default_]))
    expect(def.pubblicazione_automatica).toBe('false')
    expect(def.broadcast).toBe('false')
    expect(def.n_tag).toBe('0')
    expect(def.trasporto).toMatch(/'tus'/)

    const job = await colonne('video_jobs', [
      'byte_dichiarati', 'mime_dichiarato', 'durata_dichiarata_s', 'sha256_dichiarato', 'arrivato_il',
      'sorgente_etag', 'rinnovo_token_hash', 'rinnovo_token_scade_il', 'rinnovo_token_revocato_il',
      'output_delete_after', 'output_deleted_at', 'sorvegliato_da', 'sorvegliato_fino_a', 'diagnosi_verifica',
    ])
    expect(job.map((c) => [c.colonna, c.tipo, c.nullo])).toEqual([
      ['arrivato_il', 'timestamp with time zone', 'YES'],
      ['byte_dichiarati', 'bigint', 'YES'],
      ['diagnosi_verifica', 'jsonb', 'YES'],
      ['durata_dichiarata_s', 'numeric', 'YES'],
      ['mime_dichiarato', 'text', 'YES'],
      ['output_delete_after', 'timestamp with time zone', 'YES'],
      ['output_deleted_at', 'timestamp with time zone', 'YES'],
      ['rinnovo_token_hash', 'bytea', 'YES'],
      ['rinnovo_token_revocato_il', 'timestamp with time zone', 'YES'],
      ['rinnovo_token_scade_il', 'timestamp with time zone', 'YES'],
      ['sha256_dichiarato', 'bytea', 'YES'],
      ['sorgente_etag', 'text', 'YES'],
      ['sorvegliato_da', 'uuid', 'YES'],
      ['sorvegliato_fino_a', 'timestamp with time zone', 'YES'],
    ])
  })

  it('NON introduce una colonna didascalia né una tabella dei destinatari legacy (decisioni del titolare)', async () => {
    const intrusi = await righe<{ colonna: string }>(`
      SELECT column_name AS colonna FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name IN ('video_intents', 'video_jobs')
        AND (column_name ILIKE '%didascalia%' OR column_name ILIKE '%caption%')
    `)
    expect(nomiColonne(intrusi)).toEqual([])
    expect(
      await righe(`SELECT proname FROM pg_proc WHERE proname = 'video_intent_destinatari_legacy'`),
      'il titolare ha deciso: niente video_intent_destinatari_legacy',
    ).toEqual([])
    // E nemmeno nel TESTO della migrazione: una colonna dichiarata e poi tolta lascerebbe comunque
    // traccia nel codice. La parola può comparire nel testo di un COMMENT (la didascalia di galleria
    // resta NULL), ma non come colonna aggiunta.
    expect(soloCodice(MIGRAZIONE_A)).not.toMatch(/ADD\s+COLUMN\s+(IF\s+NOT\s+EXISTS\s+)?\w*(didascalia|caption)/i)
    expect(soloCodice(MIGRAZIONE_A)).not.toMatch(/video_intent_destinatari_legacy/i)
  })

  /** I vincoli: ogni coppia è (istruzione che LO VIOLA, il nome che il database deve nominare). */
  const VIOLAZIONI_INTENTI: ReadonlyArray<[string, string]> = [
    [`tag_alunni = ARRAY(SELECT gen_random_uuid() FROM generate_series(1, 201))`, 'video_intents_tag_alunni_chk'],
    [`broadcast = true, tag_alunni = ${uuids([A1])}`, 'video_intents_broadcast_chk'],
    [`classi_destinatarie = ARRAY(SELECT 'c' || g FROM generate_series(1, 21) AS g)`, 'video_intents_classi_chk'],
    ['n_tag = -1', 'video_intents_n_tag_chk'],
    ['n_tag = 201', 'video_intents_n_tag_chk'],
    [`trasporto = 'ftp'`, 'video_intents_trasporto_chk'],
    [`esito_notificato = 'boh', esito_notificato_il = now()`, 'video_intents_esito_notificato_chk'],
    [`esito_notificato = 'pubblicato'`, 'video_intents_esito_coppia_chk'],
    [`esito_notificato_il = now()`, 'video_intents_esito_coppia_chk'],
    [`pubblicazione_errore = ''`, 'video_intents_pubblicazione_errore_chk'],
    [`pubblicazione_errore = '${'X'.repeat(81)}'`, 'video_intents_pubblicazione_errore_chk'],
  ]

  it.each(VIOLAZIONI_INTENTI)('video_intents rifiuta «%s» (%s)', async (modifica, vincolo) => {
    // Un intento di galleria «publish»: l'unico su cui `pubblicazione_automatica` sarebbe lecita, così
    // il rifiuto è quello del vincolo che si sta provando e non di un altro.
    const { intentId } = await aperto()
    await expect(
      db.exec(`UPDATE public.video_intents SET ${modifica} WHERE id = '${intentId}'`),
    ).rejects.toThrow(new RegExp(vincolo))
  })

  it('video_intents rifiuta «automatico» su una News e su un intento che non è «publish»', async () => {
    const news = await apriNews('news-vincolo')
    await expect(
      db.exec(`UPDATE public.video_intents SET pubblicazione_automatica = true WHERE id = '${news.intentId}'`),
    ).rejects.toThrow(/video_intents_pubblicazione_automatica_chk/)

    const privato = await rpc<RispostaApri>(
      `public.video_intent_open('${OWNER}', '${SEDE}', 'gallery', 'attach_private', '{"scope":"sede"}'::jsonb,
        'privato-1', '${OWNER}/privato-1.mp4', NULL, NULL)`,
    )
    expect(privato.ok).toBe(true)
    await expect(
      db.exec(`UPDATE public.video_intents SET pubblicazione_automatica = true WHERE id = '${privato.intent!.id}'`),
    ).rejects.toThrow(/video_intents_pubblicazione_automatica_chk/)
  })

  it('video_intents accetta i valori limite (200 tag, 20 classi, esito e coppia coerenti, errore di 80 caratteri)', async () => {
    const { intentId } = await aperto()
    await db.exec(`
      UPDATE public.video_intents
      SET tag_alunni = ARRAY(SELECT gen_random_uuid() FROM generate_series(1, 200)),
          n_tag = 200,
          classi_destinatarie = ARRAY(SELECT 'c' || g FROM generate_series(1, 20) AS g),
          esito_notificato = 'fallito', esito_notificato_il = now(),
          pubblicazione_errore = '${'X'.repeat(80)}'
      WHERE id = '${intentId}'
    `)
    expect(
      (await unaRiga<{ n: number }>(`SELECT cardinality(tag_alunni) AS n FROM public.video_intents WHERE id = '${intentId}'`)).n,
    ).toBe(200)
  })

  const VIOLAZIONI_JOB: ReadonlyArray<[string, string]> = [
    [`byte_dichiarati = 0`, 'video_jobs_byte_dichiarati_chk'],
    [`byte_dichiarati = 2000000001`, 'video_jobs_byte_dichiarati_chk'],
    [`mime_dichiarato = ''`, 'video_jobs_mime_dichiarato_chk'],
    [`mime_dichiarato = '${'v'.repeat(256)}'`, 'video_jobs_mime_dichiarato_chk'],
    [`durata_dichiarata_s = 0`, 'video_jobs_durata_dichiarata_chk'],
    [`durata_dichiarata_s = 300.001`, 'video_jobs_durata_dichiarata_chk'],
    [`sha256_dichiarato = decode('abcd', 'hex')`, 'video_jobs_sha256_dichiarato_chk'],
    [`rinnovo_token_hash = decode('abcd', 'hex'), rinnovo_token_scade_il = now()`, 'video_jobs_rinnovo_hash_chk'],
    [`rinnovo_token_hash = ${impronta('x')}`, 'video_jobs_rinnovo_coppia_chk'],
    [`rinnovo_token_scade_il = now()`, 'video_jobs_rinnovo_coppia_chk'],
    [`output_deleted_at = now()`, 'video_jobs_output_scadenza_chk'],
    [`sorvegliato_da = '${INV_1}'`, 'video_jobs_sorveglianza_chk'],
    [`sorvegliato_fino_a = now()`, 'video_jobs_sorveglianza_chk'],
    [`diagnosi_verifica = '[1, 2]'::jsonb`, 'video_jobs_diagnosi_chk'],
    [`diagnosi_verifica = '"testo"'::jsonb`, 'video_jobs_diagnosi_chk'],
    [`diagnosi_verifica = jsonb_build_object('k', repeat('x', 2100))`, 'video_jobs_diagnosi_chk'],
  ]

  it.each(VIOLAZIONI_JOB)('video_jobs rifiuta «%s» (%s)', async (modifica, vincolo) => {
    const { jobId } = await aperto()
    await expect(db.exec(`UPDATE public.video_jobs SET ${modifica} WHERE id = '${jobId}'`)).rejects.toThrow(
      new RegExp(vincolo),
    )
  })

  it('video_jobs accetta i valori limite e i NULL (la durata a 300, i byte a 2 GB, l\'hash di 32 byte)', async () => {
    const { jobId } = await aperto()
    await db.exec(`
      UPDATE public.video_jobs
      SET byte_dichiarati = 2000000000, mime_dichiarato = '${'v'.repeat(255)}', durata_dichiarata_s = 300,
          sha256_dichiarato = ${impronta('a')},
          rinnovo_token_hash = ${impronta('b')}, rinnovo_token_scade_il = now() + interval '1 day',
          output_delete_after = now(), output_deleted_at = now() + interval '1 second',
          sorvegliato_da = '${INV_1}', sorvegliato_fino_a = now(),
          diagnosi_verifica = '{"frame": 264, "esito": "TERMINAL_COVERAGE_MISMATCH"}'
      WHERE id = '${jobId}'
    `)
    await db.exec(`
      UPDATE public.video_jobs
      SET byte_dichiarati = NULL, durata_dichiarata_s = NULL, sha256_dichiarato = NULL,
          rinnovo_token_hash = NULL, rinnovo_token_scade_il = NULL, sorvegliato_da = NULL,
          sorvegliato_fino_a = NULL, diagnosi_verifica = NULL
      WHERE id = '${jobId}'
    `)
  })

  it('gli indici esistono (UNIQUE parziale compreso) e si verificano su pg_indexes, non su pg_constraint', async () => {
    const indici = await righe<{ indexname: string; indexdef: string }>(`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname IN (
          'video_intents_owner_canale_aggiornato_idx', 'video_intents_esiti_da_notificare_idx',
          'video_jobs_rinnovo_token_unico_idx', 'video_jobs_uscite_da_togliere_idx', 'video_jobs_esiti_definitivi_idx'
        )
      ORDER BY indexname
    `)
    const perNome = Object.fromEntries(indici.map((i) => [i.indexname, i.indexdef]))
    expect(Object.keys(perNome)).toEqual([
      'video_intents_esiti_da_notificare_idx',
      'video_intents_owner_canale_aggiornato_idx',
      'video_jobs_esiti_definitivi_idx',
      'video_jobs_rinnovo_token_unico_idx',
      'video_jobs_uscite_da_togliere_idx',
    ])
    expect(perNome.video_jobs_rinnovo_token_unico_idx).toMatch(/CREATE UNIQUE INDEX/)
    expect(perNome.video_jobs_rinnovo_token_unico_idx).toMatch(/\(rinnovo_token_hash\)/)
    expect(perNome.video_jobs_rinnovo_token_unico_idx).toMatch(/WHERE \(?rinnovo_token_hash IS NOT NULL\)?/)
    expect(perNome.video_jobs_uscite_da_togliere_idx).toMatch(/output_deleted_at IS NULL/)
    expect(perNome.video_jobs_uscite_da_togliere_idx).toMatch(/output_delete_after IS NOT NULL/)
    expect(perNome.video_jobs_esiti_definitivi_idx).toMatch(/failed/)
    expect(perNome.video_jobs_esiti_definitivi_idx).toMatch(/rejected/)
    expect(perNome.video_intents_esiti_da_notificare_idx).toMatch(/pubblicazione_automatica/)
    expect(perNome.video_intents_esiti_da_notificare_idx).toMatch(/esito_notificato IS NULL/)
    expect(perNome.video_intents_owner_canale_aggiornato_idx).toMatch(/updated_at DESC/)

    // La trappola che il repo ha già pagato: un indice parziale NON è un vincolo, e cercarlo in
    // `pg_constraint` direbbe «non esiste». Si fissa qui perché chi verifica la migrazione guardi
    // il catalogo giusto.
    expect(
      await righe(`SELECT conname FROM pg_constraint WHERE conname = 'video_jobs_rinnovo_token_unico_idx'`),
    ).toEqual([])
  })

  it('l\'hash del token è univoco fra i job, e i NULL non confliggono', async () => {
    const a = await aperto({ chiave: 'ka' })
    const b = await aperto({ chiave: 'kb' })
    const c = await aperto({ chiave: 'kc' })
    await db.exec(`
      UPDATE public.video_jobs SET rinnovo_token_hash = ${impronta('uno')},
        rinnovo_token_scade_il = now() + interval '1 day' WHERE id = '${a.jobId}'
    `)
    await expect(
      db.exec(`
        UPDATE public.video_jobs SET rinnovo_token_hash = ${impronta('uno')},
          rinnovo_token_scade_il = now() + interval '1 day' WHERE id = '${b.jobId}'
      `),
    ).rejects.toThrow(/video_jobs_rinnovo_token_unico_idx|duplicate key/i)
    // Due job senza token convivono (b e c): l'unicità vale solo dove l'hash c'è.
    expect(await conta(`public.video_jobs WHERE rinnovo_token_hash IS NULL AND id IN ('${b.jobId}', '${c.jobId}')`)).toBe(2)
  })

  it('video_jobs_probe_chk è a 300 secondi: 180,001 passa, 300 passa, 300,001 no', async () => {
    const { jobId } = await aperto()
    const imposta = (d: string) =>
      db.exec(`UPDATE public.video_jobs SET probe_json = '{"durationSeconds":${d}}' WHERE id = '${jobId}'`)
    await imposta('180.001')
    await imposta('300')
    await expect(imposta('300.001')).rejects.toThrow(/video_jobs_probe_chk/)
    await expect(imposta('0')).rejects.toThrow(/video_jobs_probe_chk/)
    await expect(
      db.exec(`UPDATE public.video_jobs SET probe_json = '{"durationSeconds":"20"}' WHERE id = '${jobId}'`),
    ).rejects.toThrow(/video_jobs_probe_chk/)
    const def = await unaRiga<{ def: string }>(`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = 'public.video_jobs'::regclass AND conname = 'video_jobs_probe_chk'
    `)
    expect(def.def).toMatch(/300/)
    expect(def.def).not.toMatch(/180/)
  })

  it('tutte e tredici le funzioni nuove sono SECURITY DEFINER, a search_path chiuso, del solo service_role', async () => {
    const catalogo = await righe<{ nome: string; definer: boolean; config: string[] }>(`
      SELECT p.proname AS nome, p.prosecdef AS definer, p.proconfig AS config
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname = ANY(ARRAY[${FUNZIONI_NUOVE.map((f) => `'${f.nome}'`).join(', ')}])
      ORDER BY p.proname
    `)
    expect(catalogo.map((c) => c.nome)).toEqual(FUNZIONI_NUOVE.map((f) => f.nome).sort())

    for (const { nome, firma } of FUNZIONI_NUOVE) {
      const f = catalogo.find((c) => c.nome === nome)!
      expect(f.definer, `${nome} non è SECURITY DEFINER`).toBe(true)
      expect(f.config, `${nome} non chiude il search_path`).toContain('search_path=pg_catalog')
      const permessi = await unaRiga<{ servizio: boolean; anonimo: boolean; autenticato: boolean }>(`
        SELECT has_function_privilege('service_role', 'public.${nome}(${firma})', 'EXECUTE') AS servizio,
               has_function_privilege('anon', 'public.${nome}(${firma})', 'EXECUTE') AS anonimo,
               has_function_privilege('authenticated', 'public.${nome}(${firma})', 'EXECUTE') AS autenticato
      `)
      expect(permessi.servizio, `${nome} non è eseguibile dal service role`).toBe(true)
      expect(permessi.anonimo, `${nome} è eseguibile da anon`).toBe(false)
      expect(permessi.autenticato, `${nome} è eseguibile da authenticated`).toBe(false)
      // L'ACL ESATTA, che è quella delle funzioni video già in produzione (misurata il 02/10 su
      // `video_job_ready`, `video_runner_tick_http`, `cron_config`): il proprietario e il service role, e
      // nessun altro. Un `GRANT` a un ruolo che qui non si prova (PUBLIC, un ruolo di servizio nuovo) la
      // cambierebbe, e `has_function_privilege` per tre ruoli non lo vedrebbe.
      const { acl } = await unaRiga<{ acl: string }>(`
        SELECT p.proacl::text AS acl FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = '${nome}'
      `)
      expect(acl, `${nome} ha un'ACL diversa da quella delle altre funzioni video`).toBe(ACL_FUNZIONI_VIDEO)
    }
    // E `video_job_ready`, sostituita, non ha perso i privilegi.
    const ready = await unaRiga<{ servizio: boolean; anonimo: boolean; autenticato: boolean }>(`
      SELECT has_function_privilege('service_role', 'public.video_job_ready(uuid, bigint, uuid, text, bigint, jsonb)', 'EXECUTE') AS servizio,
             has_function_privilege('anon', 'public.video_job_ready(uuid, bigint, uuid, text, bigint, jsonb)', 'EXECUTE') AS anonimo,
             has_function_privilege('authenticated', 'public.video_job_ready(uuid, bigint, uuid, text, bigint, jsonb)', 'EXECUTE') AS autenticato
    `)
    expect(ready).toEqual({ servizio: true, anonimo: false, autenticato: false })
    expect(
      (await unaRiga<{ acl: string }>(`SELECT proacl::text AS acl FROM pg_proc WHERE proname = 'video_job_ready'`)).acl,
    ).toBe(ACL_FUNZIONI_VIDEO)
  })

  it('un client anonimo o autenticato che PROVA a chiamarle prende «permission denied», funzione per funzione', async () => {
    // Il privilegio misurato sul catalogo è una cosa; la chiamata vera è la prova che chiude la porta
    // `/rest/v1/rpc/<fn>` aperta con la sola chiave pubblica (la regressione delle RPC mensa del 2026-07-18).
    const chiamate: Record<string, string> = {
      video_galleria_intent_apri: `NULL::uuid, NULL::uuid, NULL::text, NULL::text, NULL::bigint, NULL::text, NULL::numeric, NULL::uuid[], NULL::boolean, NULL::text[], NULL::text, NULL::bytea, NULL::bytea, NULL::timestamptz`,
      video_rinnovo_usa: `NULL::bytea`,
      video_galleria_pubblica: `NULL::uuid, NULL::integer, NULL::uuid, NULL::uuid, NULL::text, NULL::uuid[]`,
      video_intent_esito_segna: `NULL::uuid, NULL::text`,
      video_intent_pubblicazione_fallita: `NULL::uuid, NULL::text`,
      video_intent_pubblicazione_riprova: `NULL::uuid, NULL::uuid`,
      video_job_sorveglianza_prendi: `NULL::uuid, NULL::uuid, NULL::integer`,
      video_job_sorveglianza_rilascia: `NULL::uuid, NULL::uuid`,
      video_job_prendi: `NULL::uuid, NULL::uuid, NULL::integer, NULL::integer`,
      video_job_prossimo: `NULL::uuid, NULL::integer, NULL::integer`,
      video_job_diagnosi: `NULL::uuid, NULL::bigint, NULL::uuid, NULL::jsonb`,
      video_runner_kick: `NULL::uuid`,
      video_runner_ventaglio: `NULL::integer, NULL::uuid`,
    }
    for (const ruolo of ['anon', 'authenticated']) {
      for (const { nome } of FUNZIONI_NUOVE) {
        await db.exec(`SET ROLE ${ruolo}`)
        try {
          await expect(
            db.query(`SELECT public.${nome}(${chiamate[nome]})`),
            `${ruolo} ha potuto chiamare ${nome}`,
          ).rejects.toThrow(/permission denied/i)
        } finally {
          await db.exec('RESET ROLE')
        }
      }
    }
  })
})

/** Un elenco di colonne trovate, come nomi: il messaggio di un `toEqual([])` fallito li mostra. */
function nomiColonne(trovate: Array<{ colonna: string }>): string[] {
  return trovate.map((t) => t.colonna)
}

// ─────────────────────────────────────────────────────────────────────────────
// 2 · video_job_ready (sostituita): il tetto a 300, la scadenza delle News, l'evento
// ─────────────────────────────────────────────────────────────────────────────

describe('video_job_ready · le tre modifiche', () => {
  /** Un job in lavorazione (preso da LEASE_A, fence 1) di un intento di galleria automatico. */
  async function inLavorazione(chiave = 'k1'): Promise<{ intentId: string; jobId: string }> {
    const { intentId, jobId } = await aperto({ chiave })
    await rpc(`public.video_job_uploaded('${jobId}', '${OWNER}', 5000, 'video/mp4')`)
    await rpc(`public.video_job_claim('${jobId}', '${LEASE_A}', 300)`)
    return { intentId, jobId }
  }

  const ready = (jobId: string, durata: string, percorso = `outputs/${jobId}/final.mp4`) =>
    rpc(
      `public.video_job_ready('${jobId}', 1, '${LEASE_A}', '${percorso}', 900,
        '{"durationSeconds":${durata}}'::jsonb)`,
    )

  it('il tetto di durata è 300 secondi (era 180): 300 passa, 300,001 no, una stringa resta rifiutata', async () => {
    const { jobId } = await inLavorazione()
    expect(await ready(jobId, '300.001')).toEqual({ ok: false, code: 'BAD_INPUT' })
    expect(await ready(jobId, '"300"')).toEqual({ ok: false, code: 'BAD_INPUT' })
    expect(await ready(jobId, '0')).toEqual({ ok: false, code: 'BAD_INPUT' })
    expect(await ready(jobId, '300')).toMatchObject({ ok: true, job: { status: 'ready' } })
    expect(
      (await unaRiga<{ d: string }>(`SELECT probe_json ->> 'durationSeconds' AS d FROM public.video_jobs WHERE id = '${jobId}'`)).d,
    ).toBe('300')
  })

  it('una durata fra 180 e 300 secondi, che prima veniva rifiutata, ora passa', async () => {
    const { jobId } = await inLavorazione()
    expect(await ready(jobId, '180.001')).toMatchObject({ ok: true, job: { status: 'ready' } })
  })

  it('è idempotente con lo stesso output e rifiuta un output diverso (OUTPUT_CONFLICT), come prima', async () => {
    const { jobId } = await inLavorazione()
    const prima = await ready(jobId, '20')
    const seconda = await ready(jobId, '20')
    expect(prima).toMatchObject({ ok: true, job: { status: 'ready' } })
    expect(seconda).toMatchObject({ ok: true, job: { status: 'ready' } })
    expect(await ready(jobId, '20', `outputs/${jobId}/altro.mp4`)).toEqual({ ok: false, code: 'OUTPUT_CONFLICT' })
    // E la fence resta quella del tentativo: un worker scaduto non scrive.
    expect(
      await rpc(`public.video_job_ready('${jobId}', 9, '${LEASE_A}', 'outputs/${jobId}/x.mp4', 900, '{"durationSeconds":20}'::jsonb)`),
    ).toEqual({ ok: false, code: 'FENCE_MISMATCH' })
  })

  it('accoda gallery.auto_publish NELLA STESSA transazione del ready, con il payload minimo', async () => {
    const { intentId, jobId } = await inLavorazione()
    expect(await conta('public.video_outbox')).toBe(0)
    await ready(jobId, '20')

    const eventi = await righe<{ intent_id: string; revision: number; event_type: string; payload: Record<string, unknown>; attempts: number; sent_at: string | null }>(
      `SELECT intent_id, revision, event_type, payload, attempts, sent_at FROM public.video_outbox`,
    )
    expect(eventi).toHaveLength(1)
    expect(eventi[0]).toMatchObject({
      intent_id: intentId,
      revision: 1,
      event_type: 'gallery.auto_publish',
      payload: { intent_id: intentId, job_id: jobId },
      attempts: 0,
      sent_at: null,
    })
    // Solo identificatori: nessun nome, nessun percorso, nessun tag.
    expect(Object.keys(eventi[0].payload).sort()).toEqual(['intent_id', 'job_id'])

    // Un ready ripetuto (idempotente) non ne accoda un secondo.
    await ready(jobId, '20')
    expect(await conta('public.video_outbox')).toBe(1)
  })

  // L'evento nasce SOLO per un intento automatico E confermato. Ogni riga è una forma in cui la regola
  // potrebbe sbagliare: per tutte, il `ready` riesce e l'outbox resta vuota.
  const SENZA_EVENTO: ReadonlyArray<[string, (intentId: string, jobId: string) => Promise<void>]> = [
    [
      'un intento di galleria NON automatico (il flusso vecchio)',
      async (intentId) => {
        await db.exec(`UPDATE public.video_intents SET pubblicazione_automatica = false WHERE id = '${intentId}'`)
      },
    ],
    [
      'un intento automatico ma in action_required',
      async (intentId) => {
        await db.exec(`UPDATE public.video_intents SET status = 'action_required' WHERE id = '${intentId}'`)
      },
    ],
    [
      'un intento automatico ma ancora pending',
      async (intentId) => {
        await db.exec(
          `UPDATE public.video_intents SET status = 'pending', confirmed_at = NULL WHERE id = '${intentId}'`,
        )
      },
    ],
  ]

  it.each(SENZA_EVENTO)('NON accoda niente per %s', async (_descrizione, prepara) => {
    const { intentId, jobId } = await inLavorazione()
    await prepara(intentId, jobId)
    expect(await ready(jobId, '20')).toMatchObject({ ok: true, job: { status: 'ready' } })
    expect(await conta('public.video_outbox')).toBe(0)
  })

  it('NON accoda niente per una News (nessuna pubblicazione automatica)', async () => {
    const { jobId } = await apriNews('news-niente-evento')
    await rpc(`public.video_job_uploaded('${jobId}', '${OWNER}', 5000, 'video/mp4')`)
    await rpc(`public.video_job_claim('${jobId}', '${LEASE_A}', 300)`)
    expect(await ready(jobId, '20')).toMatchObject({ ok: true })
    expect(await conta('public.video_outbox')).toBe(0)
  })

  it('un evento già accodato non fa fallire il ready: l’unicità vale «già accodato»', async () => {
    const { intentId, jobId } = await inLavorazione()
    await db.exec(`
      INSERT INTO public.video_outbox(intent_id, revision, event_type, payload)
      VALUES ('${intentId}', 1, 'gallery.auto_publish', '{}')
    `)
    expect(await ready(jobId, '20')).toMatchObject({ ok: true, job: { status: 'ready' } })
    expect(await conta('public.video_outbox')).toBe(1)
    expect((await contestiLoggati('video-job-ready')).map((c) => c.code)).toContain('OUTBOX_ALREADY_QUEUED')
  })

  it('per una News l’uscita riceve la scadenza verified_at + 7 giorni; per una Galleria resta NULL', async () => {
    const news = await apriNews('news-scadenza')
    await rpc(`public.video_job_uploaded('${news.jobId}', '${OWNER}', 5000, 'video/mp4')`)
    await rpc(`public.video_job_claim('${news.jobId}', '${LEASE_A}', 300)`)
    await ready(news.jobId, '20')

    const galleria = await inLavorazione('k-galleria')
    await ready(galleria.jobId, '20')

    const scadenze = await righe<{ id: string; uscita: boolean; originale: boolean }>(`
      SELECT id, output_delete_after IS NOT NULL AS uscita, original_delete_after IS NOT NULL AS originale
      FROM public.video_jobs WHERE id IN ('${news.jobId}', '${galleria.jobId}')
    `)
    const perId = Object.fromEntries(scadenze.map((r) => [r.id, r]))
    expect(perId[news.jobId]).toMatchObject({ uscita: true, originale: true })
    // La Galleria tiene l'uscita finché non è pubblicata: la scadenza la scrive la pubblicazione.
    expect(perId[galleria.jobId]).toMatchObject({ uscita: false, originale: true })

    const s = await secondi('verified_at', 'output_delete_after', `public.video_jobs WHERE id = '${news.jobId}'`)
    expect(s).toBeGreaterThanOrEqual(SETTE_GIORNI - 3600)
    expect(s).toBeLessThanOrEqual(SETTE_GIORNI + 3600)
    // E la scadenza dell'ORIGINALE resta quella di sempre: verified_at + 7 giorni esatti (il vincolo la impone).
    expect(
      (await unaRiga<{ esatto: boolean }>(
        `SELECT original_delete_after = verified_at + interval '7 days' AS esatto FROM public.video_jobs WHERE id = '${news.jobId}'`,
      )).esatto,
    ).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3 · video_galleria_intent_apri
// ─────────────────────────────────────────────────────────────────────────────

describe('video_galleria_intent_apri', () => {
  it('apre e CONFERMA: destinatari normalizzati, dichiarati sul job, risposta senza tag né hash', async () => {
    const r = await apri({ tag: [A2, A1, A1], classi: null })
    expect(r).toMatchObject({ ok: true, ripetuta: false, token_ruotato: false })
    expect(r.intent).toMatchObject({ status: 'confirmed', revision: 1, channel: 'gallery', requested_action: 'publish' })
    expect(r.job).toMatchObject({ status: 'awaiting_upload', original_path: `${OWNER}/k1.mp4` })

    const intento = await unaRiga<{
      pubblicazione_automatica: boolean; tag_alunni: string[]; broadcast: boolean; classi_destinatarie: string[] | null
      n_tag: number; trasporto: string; confermato: boolean; scope: string; scuola_id: string; owner_id: string
      esito_notificato: string | null; minimizzato_il: string | null
    }>(`
      SELECT pubblicazione_automatica, tag_alunni, broadcast, classi_destinatarie, n_tag, trasporto,
             confirmed_at IS NOT NULL AS confermato, payload ->> 'scope' AS scope, scuola_id, owner_id,
             esito_notificato, minimizzato_il
      FROM public.video_intents WHERE id = '${r.intent!.id}'
    `)
    expect(intento).toMatchObject({
      pubblicazione_automatica: true,
      // I tag si normalizzano: distinti e ordinati. {A2, A1, A1} → {A1, A2}.
      tag_alunni: [A1, A2],
      broadcast: false,
      classi_destinatarie: null,
      n_tag: 2,
      trasporto: 'tus',
      confermato: true,
      scope: 'sede',
      scuola_id: SEDE,
      owner_id: OWNER,
      esito_notificato: null,
      minimizzato_il: null,
    })

    const job = await unaRiga<Riga>(`
      SELECT byte_dichiarati, mime_dichiarato, durata_dichiarata_s::float AS durata, sha256_dichiarato IS NULL AS senza_sha,
             rinnovo_token_hash IS NULL AS senza_token, rinnovo_token_scade_il IS NULL AS senza_scadenza, status
      FROM public.video_jobs WHERE id = '${r.job!.id}'
    `)
    expect(job).toMatchObject({
      byte_dichiarati: 5000, mime_dichiarato: 'video/mp4', durata: 20,
      senza_sha: true, senza_token: true, senza_scadenza: true, status: 'awaiting_upload',
    })

    // La risposta è per il SERVER ma non porta fuori ciò che non serve: né i tag (identificativi di
    // minori) né l'hash del token né lo SHA-256 dichiarato.
    expect(r.intent).not.toHaveProperty('tag_alunni')
    expect(r.job).not.toHaveProperty('rinnovo_token_hash')
    expect(r.job).not.toHaveProperty('sha256_dichiarato')
    // Un'apertura non accoda niente: l'evento nasce con il ready, non prima.
    expect(await conta('public.video_outbox')).toBe(0)
  })

  it('una consegna a tutti (broadcast): nessun bambino, classi normalizzate, n_tag a zero', async () => {
    const r = await apri({ tag: [], broadcast: true, classi: ['Girasoli', 'Api', 'Api'] })
    expect(r).toMatchObject({ ok: true })
    expect(
      await unaRiga(`
        SELECT broadcast, tag_alunni, n_tag, classi_destinatarie FROM public.video_intents WHERE id = '${r.intent!.id}'
      `),
    ).toEqual({ broadcast: true, tag_alunni: [], n_tag: 0, classi_destinatarie: ['Api', 'Girasoli'] })
  })

  it('il caricamento NATIVO scrive sul job lo SHA-256 e il token (solo l’hash), e non li restituisce', async () => {
    const r = await aperto(nativo('t1'))
    const job = await unaRiga<{ sha_ok: boolean; hash_ok: boolean; scade_ore: number; revocato: boolean }>(`
      SELECT sha256_dichiarato = ${impronta('contenuto')} AS sha_ok,
             rinnovo_token_hash = ${impronta('t1')} AS hash_ok,
             round(EXTRACT(EPOCH FROM (rinnovo_token_scade_il - clock_timestamp())) / 3600)::int AS scade_ore,
             rinnovo_token_revocato_il IS NOT NULL AS revocato
      FROM public.video_jobs WHERE id = '${r.jobId}'
    `)
    expect(job).toEqual({ sha_ok: true, hash_ok: true, scade_ore: 48, revocato: false })
    expect((await unaRiga<{ t: string }>(`SELECT trasporto AS t FROM public.video_intents WHERE id = '${r.intentId}'`)).t).toBe('put-nativo')
    expect(JSON.stringify(r.risposta)).not.toMatch(/\\x[0-9a-f]{16}/i)
  })

  it('la ripetizione IDENTICA è lo stesso intento: nessuna riga nuova, ripetuta a vero', async () => {
    const prima = await aperto({ tag: [A1, A2] })
    // Stessi destinatari, con ordine e doppioni diversi: sono INSIEMI.
    const seconda = await apri({ tag: [A2, A1, A2] })
    expect(seconda).toMatchObject({ ok: true, ripetuta: true, token_ruotato: false })
    expect(seconda.intent!.id).toBe(prima.intentId)
    expect(seconda.job!.id).toBe(prima.jobId)
    expect(await conta('public.video_intents')).toBe(1)
    expect(await conta('public.video_jobs')).toBe(1)
    expect(await conta('public.video_outbox')).toBe(0)
  })

  it('il nativo ripetuto con il job ancora in awaiting_upload RUOTA il token: il vecchio sparisce, il nuovo vale', async () => {
    const prima = await aperto(nativo('vecchio'))
    const scadenzaPrima = (await unaRiga<{ s: string }>(`SELECT rinnovo_token_scade_il::text AS s FROM public.video_jobs WHERE id = '${prima.jobId}'`)).s

    const seconda = await apri({ ...nativo('nuovo'), scade: `clock_timestamp() + interval '48 hours 1 minute'` })
    expect(seconda).toMatchObject({ ok: true, ripetuta: true, token_ruotato: true })
    expect(seconda.intent!.id).toBe(prima.intentId)

    const job = await unaRiga<{ nuovo: boolean; vecchio: boolean; nuova_scadenza: boolean; revocato: boolean }>(`
      SELECT rinnovo_token_hash = ${impronta('nuovo')} AS nuovo,
             rinnovo_token_hash = ${impronta('vecchio')} AS vecchio,
             rinnovo_token_scade_il::text <> '${scadenzaPrima}' AS nuova_scadenza,
             rinnovo_token_revocato_il IS NOT NULL AS revocato
      FROM public.video_jobs WHERE id = '${prima.jobId}'
    `)
    expect(job).toEqual({ nuovo: true, vecchio: false, nuova_scadenza: true, revocato: false })

    // Il vecchio è SCONOSCIUTO da questo momento, il nuovo è vivo.
    expect(await rpc(`public.video_rinnovo_usa(${impronta('vecchio')})`)).toEqual({ ok: false, code: 'TOKEN_NON_VALIDO' })
    expect(await rpc(`public.video_rinnovo_usa(${impronta('nuovo')})`)).toMatchObject({ ok: true, stato: 'da-caricare' })
  })

  it('il nativo ripetuto con il file GIÀ ARRIVATO non ruota niente', async () => {
    const prima = await aperto(nativo('t1'))
    await rpc(`public.video_job_uploaded('${prima.jobId}', '${OWNER}', 5000, 'video/mp4')`)
    const seconda = await apri(nativo('t2'))
    expect(seconda).toMatchObject({ ok: true, ripetuta: true, token_ruotato: false })
    expect(
      (await unaRiga<{ resta: boolean }>(`SELECT rinnovo_token_hash = ${impronta('t1')} AS resta FROM public.video_jobs WHERE id = '${prima.jobId}'`)).resta,
    ).toBe(true)
  })

  // Valori diversi con la stessa chiave NON sono una ripetizione: è un errore del chiamante. Ogni riga è
  // un campo che potrebbe essere stato dimenticato dal confronto.
  const DIVERSI: ReadonlyArray<[string, Partial<ArgomentiApri>, Partial<ArgomentiApri>]> = [
    ['altri bambini', {}, { tag: [A1, A3] }],
    ['un bambino in meno', {}, { tag: [A1] }],
    ['un bambino in più', {}, { tag: [A1, A2, A3] }],
    ['un broadcast al posto dei bambini', {}, { tag: [], broadcast: true }],
    ['altre classi', { tag: [], broadcast: true, classi: ['A'] }, { tag: [], broadcast: true, classi: ['B'] }],
    ['classi dove prima non c’erano', { tag: [], broadcast: true }, { tag: [], broadcast: true, classi: ['A'] }],
    ['un altro trasporto (tus → nativo)', {}, nativo('t1')],
    ['un altro trasporto (nativo → tus)', nativo('t1'), {}],
    ['un’altra dimensione dichiarata', {}, { byte: 6000 }],
    ['un altro SHA-256', nativo('t1'), { ...nativo('t1'), sha: impronta('altro-contenuto') }],
  ]

  it.each(DIVERSI)('IDEMPOTENCY_CONFLICT con %s, senza toccare niente', async (_d, primo, secondo) => {
    const prima = await aperto(primo)
    const prima_stato = await righe(`SELECT tag_alunni, broadcast, trasporto, n_tag, classi_destinatarie FROM public.video_intents`)
    const prima_job = await righe(`SELECT byte_dichiarati, rinnovo_token_hash, sha256_dichiarato FROM public.video_jobs`)

    expect(await apri(secondo)).toEqual({ ok: false, code: 'IDEMPOTENCY_CONFLICT' })

    expect(await righe(`SELECT tag_alunni, broadcast, trasporto, n_tag, classi_destinatarie FROM public.video_intents`)).toEqual(prima_stato)
    expect(await righe(`SELECT byte_dichiarati, rinnovo_token_hash, sha256_dichiarato FROM public.video_jobs`)).toEqual(prima_job)
    expect(await conta('public.video_intents')).toBe(1)
    expect(prima.intentId).toBeTruthy()
  })

  it('una chiave che il flusso VECCHIO ha già usato non si adotta: IDEMPOTENCY_CONFLICT, intento vecchio intatto', async () => {
    const vecchio = await rpc<RispostaApri>(
      `public.video_intent_open('${OWNER}', '${SEDE}', 'gallery', 'publish', '{"scope":"sede"}'::jsonb,
        'k1', '${OWNER}/k1.mp4', NULL, NULL)`,
    )
    expect(vecchio.ok).toBe(true)

    expect(await apri({ chiave: 'k1' })).toEqual({ ok: false, code: 'IDEMPOTENCY_CONFLICT' })

    expect(
      await unaRiga(`SELECT status, pubblicazione_automatica, n_tag, tag_alunni FROM public.video_intents WHERE id = '${vecchio.intent!.id}'`),
    ).toEqual({ status: 'pending', pubblicazione_automatica: false, n_tag: 0, tag_alunni: [] })
    expect(
      await unaRiga(`SELECT byte_dichiarati, mime_dichiarato FROM public.video_jobs WHERE id = '${vecchio.job!.id}'`),
    ).toEqual({ byte_dichiarati: null, mime_dichiarato: null })
  })

  // Ogni rifiuto di argomenti avviene PRIMA di aprire: nessuna riga, perché una `{ok:false}` non
  // annulla le scritture già fatte.
  const RIFIUTI: ReadonlyArray<[string, Partial<ArgomentiApri>, string]> = [
    ['senza proprietario', { owner: null }, 'BAD_INPUT'],
    ['senza sede', { scuola: null }, 'BAD_INPUT'],
    ['senza chiave', { chiave: null, percorso: `${OWNER}/x.mp4` }, 'BAD_INPUT'],
    ['senza percorso', { percorso: null }, 'BAD_INPUT'],
    ['con zero byte', { byte: 0 }, 'BAD_INPUT'],
    ['con più di 2 GB', { byte: 2000000001 }, 'BAD_INPUT'],
    ['senza byte', { byte: null }, 'BAD_INPUT'],
    ['con un MIME vuoto', { mime: '' }, 'BAD_INPUT'],
    ['senza MIME', { mime: null }, 'BAD_INPUT'],
    ['con durata zero', { durata: 0 }, 'BAD_INPUT'],
    ['con durata oltre i 300 secondi', { durata: 300.001 }, 'BAD_INPUT'],
    ['senza elenco di bambini', { tag: null }, 'BAD_INPUT'],
    ['senza il flag broadcast', { broadcast: null }, 'BAD_INPUT'],
    ['con un trasporto sconosciuto', { trasporto: 'ftp' }, 'BAD_INPUT'],
    ['senza trasporto', { trasporto: null }, 'BAD_INPUT'],
    ['tus con uno SHA-256', { sha: impronta('x') }, 'BAD_INPUT'],
    ['tus con un token', { token: impronta('x') }, 'BAD_INPUT'],
    ['nativo senza token', { ...nativo(), token: null }, 'BAD_INPUT'],
    ['nativo senza scadenza del token', { ...nativo(), scade: null }, 'BAD_INPUT'],
    ['nativo con la scadenza già passata', { ...nativo(), scade: `clock_timestamp() - interval '1 second'` }, 'BAD_INPUT'],
    ['nativo con un SHA-256 di 31 byte', { ...nativo(), sha: `decode(repeat('ab', 31), 'hex')` }, 'BAD_INPUT'],
    ['nativo con un token di 31 byte', { ...nativo(), token: `decode(repeat('ab', 31), 'hex')` }, 'BAD_INPUT'],
    ['con un broadcast E dei bambini', { tag: [A1], broadcast: true }, 'BROADCAST_CON_TAG'],
    ['senza bambini e senza broadcast', { tag: [], broadcast: false }, 'DESTINATARI_MANCANTI'],
    ['con più di 20 classi', { tag: [], broadcast: true, classi: Array.from({ length: 21 }, (_, i) => `C${i}`) }, 'BAD_INPUT'],
    ['con una classe vuota', { tag: [], broadcast: true, classi: [' '] }, 'BAD_INPUT'],
    ['con un percorso fuori dalla cartella del proprietario', { percorso: `${ALTRO_OWNER}/k1.mp4` }, 'ORIGINAL_PATH_SCOPE'],
  ]

  it.each(RIFIUTI)('rifiuta %s (%s) senza scrivere niente', async (_d, parziali, codice) => {
    expect(await apri(parziali)).toEqual({ ok: false, code: codice })
    expect(await conta('public.video_intents')).toBe(0)
    expect(await conta('public.video_jobs')).toBe(0)
  })

  it('rifiuta più di 200 bambini distinti, e ne accetta 200', async () => {
    const molti = (n: number) => Array.from({ length: n }, (_, i) => `b${String(i).padStart(7, '0')}-0000-4000-8000-000000000000`)
    expect(await apri({ tag: molti(201) })).toEqual({ ok: false, code: 'BAD_INPUT' })
    expect(await conta('public.video_intents')).toBe(0)
    const r = await apri({ tag: molti(200) })
    expect(r).toMatchObject({ ok: true })
    expect((await unaRiga<{ n: number }>(`SELECT n_tag AS n FROM public.video_intents`)).n).toBe(200)
  })

  it('i doppioni non contano nel tetto dei 200: 300 righe con 150 bambini distinti sono 150', async () => {
    const distinti = Array.from({ length: 150 }, (_, i) => `d${String(i).padStart(7, '0')}-0000-4000-8000-000000000000`)
    const r = await apri({ tag: [...distinti, ...distinti] })
    expect(r).toMatchObject({ ok: true })
    expect((await unaRiga<{ n: number }>(`SELECT n_tag AS n FROM public.video_intents`)).n).toBe(150)
  })

  it('la stessa chiave con un’ALTRA sede o un altro percorso: IDEMPOTENCY_CONFLICT di video_intent_open, tale e quale', async () => {
    await aperto({ chiave: 'k1' })
    expect(await apri({ chiave: 'k1', scuola: ALTRA_SEDE })).toEqual({ ok: false, code: 'IDEMPOTENCY_CONFLICT' })
    // Un altro MIME porta un'altra estensione, quindi un altro percorso: non è lo stesso file.
    expect(await apri({ chiave: 'k1', percorso: `${OWNER}/k1.mov`, mime: 'video/quicktime' })).toEqual({ ok: false, code: 'IDEMPOTENCY_CONFLICT' })
    expect(await conta('public.video_intents')).toBe(1)
    expect(await conta('public.video_jobs')).toBe(1)
    expect((await unaRiga<{ s: string }>(`SELECT scuola_id AS s FROM public.video_intents`)).s).toBe(SEDE)
  })

  it('un percorso già assegnato a un altro job esce con il codice di video_intent_open (ORIGINAL_PATH_TAKEN)', async () => {
    await aperto({ chiave: 'k1' })
    expect(await apri({ chiave: 'k2', percorso: `${OWNER}/k1.mp4` })).toEqual({ ok: false, code: 'ORIGINAL_PATH_TAKEN' })
    expect(await conta('public.video_intents')).toBe(1)
    expect(await conta('public.video_jobs')).toBe(1)
  })

  it('il successo si logga con numeri e codici: né un bambino, né un percorso, né un hash', async () => {
    await aperto({ ...nativo('segreto-di-prova'), tag: [A1, A2, A3] })
    const contesti = await contestiLoggati('video-galleria-intent-apri')
    expect(contesti).toHaveLength(1)
    expect(contesti[0]).toMatchObject({ n_tag: 3, broadcast: false, trasporto: 'put-nativo', ripetuta: false, token_ruotato: false })

    const log = await tuttoIlLog()
    for (const vietato of [A1, A2, A3, `${OWNER}/k1.mp4`, 'video/mp4']) {
      expect(log, `il log contiene «${vietato}»`).not.toContain(vietato)
    }
    const hex = (await unaRiga<{ h: string }>(`SELECT encode(${impronta('segreto-di-prova')}, 'hex') AS h`)).h
    expect(log).not.toContain(hex)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4 · video_rinnovo_usa
// ─────────────────────────────────────────────────────────────────────────────

describe('video_rinnovo_usa · il token di rinnovo del caricamento nativo', () => {
  const TOKEN_NON_VALIDO = { ok: false, code: 'TOKEN_NON_VALIDO' }
  const usa = (seme: string) => rpc(`public.video_rinnovo_usa(${impronta(seme)})`)

  it('da-caricare: risponde con percorso, MIME, byte e scadenza, e il token resta vivo (nessuna revoca)', async () => {
    const { jobId, intentId } = await aperto({ ...nativo('t1'), byte: 7777, mime: 'video/quicktime', chiave: 'kn', percorso: `${OWNER}/kn.mov` })
    const r = await usa('t1')
    expect(r).toMatchObject({
      ok: true,
      stato: 'da-caricare',
      job_id: jobId,
      intent_id: intentId,
      bucket: 'video_originals',
      percorso: `${OWNER}/kn.mov`,
      mime: 'video/quicktime',
      byte: 7777,
    })
    const job = await unaRiga<{ revocato: boolean; stessa_scadenza: boolean }>(`
      SELECT rinnovo_token_revocato_il IS NOT NULL AS revocato,
             rinnovo_token_scade_il = '${String(r.scade_il)}'::timestamptz AS stessa_scadenza
      FROM public.video_jobs WHERE id = '${jobId}'
    `)
    expect(job).toEqual({ revocato: false, stessa_scadenza: true })
    // Si può usare più volte finché il file non arriva: la risposta è la stessa.
    expect(await usa('t1')).toMatchObject({ ok: true, stato: 'da-caricare', job_id: jobId })
  })

  it('il rinnovo NON allunga la vita del token', async () => {
    const { jobId } = await aperto(nativo('t1'))
    const prima = (await unaRiga<{ s: string }>(`SELECT rinnovo_token_scade_il::text AS s FROM public.video_jobs WHERE id = '${jobId}'`)).s
    await usa('t1')
    await usa('t1')
    expect(
      (await unaRiga<{ s: string }>(`SELECT rinnovo_token_scade_il::text AS s FROM public.video_jobs WHERE id = '${jobId}'`)).s,
    ).toBe(prima)
  })

  // Quattro cose diverse per chi gestisce il sistema, UNA sola per chi chiede: la risposta è identica.
  it('TOKEN_NON_VALIDO uniforme: assente, di forma sbagliata, sconosciuto, scaduto, revocato, ruotato', async () => {
    const { jobId } = await aperto(nativo('t1'))
    expect(await rpc(`public.video_rinnovo_usa(NULL::bytea)`)).toEqual(TOKEN_NON_VALIDO)
    expect(await rpc(`public.video_rinnovo_usa(decode('abcd', 'hex'))`)).toEqual(TOKEN_NON_VALIDO)
    expect(await rpc(`public.video_rinnovo_usa(decode(repeat('ab', 33), 'hex'))`)).toEqual(TOKEN_NON_VALIDO)
    expect(await usa('mai-emesso')).toEqual(TOKEN_NON_VALIDO)

    // Scaduto: 48 ore passate.
    await db.exec(`UPDATE public.video_jobs SET rinnovo_token_scade_il = clock_timestamp() - interval '1 second' WHERE id = '${jobId}'`)
    expect(await usa('t1')).toEqual(TOKEN_NON_VALIDO)
    await db.exec(`UPDATE public.video_jobs SET rinnovo_token_scade_il = clock_timestamp() + interval '1 day' WHERE id = '${jobId}'`)
    expect(await usa('t1')).toMatchObject({ ok: true, stato: 'da-caricare' })

    // Revocato mentre il file è ancora da caricare: non dà MAI un nuovo indirizzo di caricamento.
    await db.exec(`UPDATE public.video_jobs SET rinnovo_token_revocato_il = clock_timestamp() WHERE id = '${jobId}'`)
    expect(await usa('t1')).toEqual(TOKEN_NON_VALIDO)
  })

  it('i motivi si distinguono NEL LOG (mai nella risposta), e il log non contiene l’hash né il job di un token ignoto', async () => {
    const { jobId } = await aperto(nativo('t1'))
    await usa('mai-emesso')
    await rpc(`public.video_rinnovo_usa(decode('abcd', 'hex'))`)
    await db.exec(`UPDATE public.video_jobs SET rinnovo_token_scade_il = clock_timestamp() - interval '1 second' WHERE id = '${jobId}'`)
    await usa('t1')

    const motivi = (await contestiLoggati('video-rinnovo-usa')).map((c) => c.motivo)
    expect(motivi).toEqual(['sconosciuto', 'forma', 'scaduto'])
    const log = await tuttoIlLog()
    for (const seme of ['t1', 'mai-emesso']) {
      const hex = (await unaRiga<{ h: string }>(`SELECT encode(${impronta(seme)}, 'hex') AS h`)).h
      expect(log, `il log contiene l'hash di «${seme}»`).not.toContain(hex)
    }
  })

  it('il token ruotato non vale più: la rotazione cancella il vecchio hash', async () => {
    await aperto(nativo('vecchio'))
    await apri(nativo('nuovo'))
    expect(await usa('vecchio')).toEqual(TOKEN_NON_VALIDO)
    expect(await usa('nuovo')).toMatchObject({ stato: 'da-caricare' })
  })

  it('arrivato: il file c’è già (il job non è più in awaiting_upload); il token si revoca, e continua a dire «arrivato»', async () => {
    const { jobId } = await aperto(nativo('t1'))
    await rpc(`public.video_job_uploaded('${jobId}', '${OWNER}', 7777, 'video/mp4')`)

    expect(await usa('t1')).toEqual({ ok: true, stato: 'arrivato' })
    expect(
      (await unaRiga<{ revocato: boolean }>(`SELECT rinnovo_token_revocato_il IS NOT NULL AS revocato FROM public.video_jobs WHERE id = '${jobId}'`)).revocato,
    ).toBe(true)
    // È ciò che fa sapere al 409 di una seconda PUT «il file c'è già»: dopo la revoca la risposta non
    // cambia, e non regala niente (un indirizzo di caricamento non si ottiene più).
    expect(await usa('t1')).toEqual({ ok: true, stato: 'arrivato' })
  })

  it.each([
    ['in lavorazione', async (jobId: string) => { await rpc(`public.video_job_claim('${jobId}', '${LEASE_A}', 300)`) }],
    ['pronto', async (jobId: string) => {
      await rpc(`public.video_job_claim('${jobId}', '${LEASE_A}', 300)`)
      await rpc(`public.video_job_ready('${jobId}', 1, '${LEASE_A}', 'outputs/${jobId}/f.mp4', 900, '{"durationSeconds":20}'::jsonb)`)
    }],
    ['fallito DOPO l’arrivo', async (jobId: string) => {
      await db.exec(`UPDATE public.video_jobs SET status = 'failed', error_code = 'FILE_ILLEGGIBILE', original_delete_after = now() WHERE id = '${jobId}'`)
    }],
  ])('arrivato anche per un job %s', async (_d, avanza) => {
    const { jobId } = await aperto(nativo('t1'))
    await rpc(`public.video_job_uploaded('${jobId}', '${OWNER}', 7777, 'video/mp4')`)
    await avanza(jobId)
    expect(await usa('t1')).toEqual({ ok: true, stato: 'arrivato' })
  })

  it('annullato: l’insegnante ha annullato (job annullato, o intento ritirato), o l’upload è stato abbandonato', async () => {
    // 1 · il job annullato dall'insegnante
    const a = await aperto({ ...nativo('ta'), chiave: 'ka' })
    await rpc(`public.video_job_cancel('${a.jobId}', '${OWNER}')`)
    expect(await usa('ta')).toEqual({ ok: true, stato: 'annullato' })
    expect(await usa('ta')).toEqual({ ok: true, stato: 'annullato' })
    expect(
      (await unaRiga<{ revocato: boolean }>(`SELECT rinnovo_token_revocato_il IS NOT NULL AS revocato FROM public.video_jobs WHERE id = '${a.jobId}'`)).revocato,
    ).toBe(true)

    // 2 · l'intento ritirato
    const b = await aperto({ ...nativo('tb'), chiave: 'kb' })
    await rpc(`public.video_intent_revoke('${b.intentId}', '${OWNER}', 1)`)
    expect(await usa('tb')).toEqual({ ok: true, stato: 'annullato' })

    // 3 · l'upload abbandonato: il job è `failed` e il file NON è mai arrivato (nessuna dimensione).
    const c = await aperto({ ...nativo('tc'), chiave: 'kc' })
    await db.exec(`UPDATE public.video_jobs SET status = 'failed', error_code = 'UPLOAD_ABBANDONATO', original_delete_after = now() WHERE id = '${c.jobId}'`)
    expect(await usa('tc')).toEqual({ ok: true, stato: 'annullato' })
  })

  it('non rivela nulla di un token scaduto, nemmeno se il job è già annullato o arrivato', async () => {
    const { jobId } = await aperto(nativo('t1'))
    await rpc(`public.video_job_cancel('${jobId}', '${OWNER}')`)
    await db.exec(`UPDATE public.video_jobs SET rinnovo_token_scade_il = clock_timestamp() - interval '1 second' WHERE id = '${jobId}'`)
    expect(await usa('t1')).toEqual(TOKEN_NON_VALIDO)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5 · video_galleria_pubblica
// ─────────────────────────────────────────────────────────────────────────────

describe('video_galleria_pubblica', () => {
  const stato = (intentId: string) =>
    unaRiga<{
      status: string; target_id: string | null; pubblicato: boolean; tag_alunni: string[]; n_tag: number
      minimizzato: boolean; esito_notificato: string | null; esito_il: string | null
    }>(`
      SELECT status, target_id, published_at IS NOT NULL AS pubblicato, tag_alunni, n_tag,
             minimizzato_il IS NOT NULL AS minimizzato, esito_notificato, esito_notificato_il::text AS esito_il
      FROM public.video_intents WHERE id = '${intentId}'
    `)

  it('il VINCITORE: riga di galleria completa, intento pubblicato, tag minimizzati, uscita con scadenza, evento', async () => {
    const { intentId, jobId } = await intentoPronto({ tag: [A1, A2], classi: null })
    // A2 è uscito dalla sede fra la scelta e la pubblicazione: i tag effettivi sono solo A1.
    const r = await pubblica(intentId, [A1])
    expect(r).toMatchObject({ ok: true, created: true, n_tag: 2, n_tag_effettivi: 1, broadcast: false })
    const mediaId = String(r.media_id)

    const media = await righe<{
      id: string; uploaded_by: string; scuola_id: string; upload_id: string; file_url: string; file_type: string
      caption: string | null; tag_students: string[]; is_broadcast: boolean; target_classes: string[] | null
      eliminato_il: string | null; upload_payload_hash: string | null
    }>(`SELECT id, uploaded_by, scuola_id, upload_id, file_url, file_type, caption, tag_students, is_broadcast,
               target_classes, eliminato_il, upload_payload_hash FROM public.galleria_media_v2`)
    expect(media).toEqual([
      {
        id: mediaId,
        uploaded_by: OWNER,
        scuola_id: SEDE,
        upload_id: intentId,
        file_url: percorsoGalleria(intentId),
        file_type: 'video',
        // Nessuna didascalia per i contenuti NUOVI (decisione del titolare).
        caption: null,
        tag_students: [A1],
        is_broadcast: false,
        target_classes: null,
        eliminato_il: null,
        upload_payload_hash: null,
      },
    ])

    // L'intento: pubblicato, legato alla riga, minimizzato. `n_tag` è quello che l'insegnante ha scelto.
    expect(await stato(intentId)).toMatchObject({
      status: 'published', target_id: mediaId, pubblicato: true, tag_alunni: [], n_tag: 2, minimizzato: true,
    })
    // E NON scrive la marca delle notifiche: la scrive solo `video_intent_esito_segna`.
    expect(await stato(intentId)).toMatchObject({ esito_notificato: null, esito_il: null })

    // L'uscita ha la sua scadenza (adesso), e il file dell'originale la sua di sempre.
    expect(
      await unaRiga(`SELECT output_delete_after IS NOT NULL AS uscita, original_delete_after IS NOT NULL AS originale, output_path IS NOT NULL AS ha_uscita
                     FROM public.video_jobs WHERE id = '${jobId}'`),
    ).toEqual({ uscita: true, originale: true, ha_uscita: true })
    expect(
      (await unaRiga<{ passato: boolean }>(`SELECT output_delete_after <= clock_timestamp() AS passato FROM public.video_jobs WHERE id = '${jobId}'`)).passato,
    ).toBe(true)

    // L'evento di `finalize` è quello che scriveva la route: solo uuid e numeri.
    const eventi = await righe<{ event_type: string; payload: Record<string, unknown> }>(
      `SELECT event_type, payload FROM public.video_outbox ORDER BY event_type`,
    )
    expect(eventi.map((e) => e.event_type)).toEqual(['gallery.auto_publish', 'gallery.published'])
    expect(eventi[1].payload).toEqual({ media_id: mediaId, scuola_id: SEDE, revision: 1 })
  })

  it('un broadcast con classi: nessun bambino, is_broadcast e target_classes copiati dall’intento', async () => {
    const { intentId } = await intentoPronto({ tag: [], broadcast: true, classi: ['Girasoli'] })
    const r = await pubblica(intentId, [])
    expect(r).toMatchObject({ ok: true, created: true, n_tag: 0, n_tag_effettivi: 0, broadcast: true })
    expect(
      await unaRiga(`SELECT tag_students, is_broadcast, target_classes FROM public.galleria_media_v2`),
    ).toEqual({ tag_students: [], is_broadcast: true, target_classes: ['Girasoli'] })
  })

  it('UN SOLO VINCITORE con due chiamate: la seconda risponde created:false, stessa riga, niente di duplicato', async () => {
    const { intentId } = await intentoPronto()
    const prima = await pubblica(intentId, [A1, A2])
    const seconda = await pubblica(intentId, [A1, A2])
    expect(prima).toMatchObject({ ok: true, created: true })
    expect(seconda).toMatchObject({ ok: true, created: false, media_id: prima.media_id, n_tag: 2, n_tag_effettivi: 2 })

    expect(await conta('public.galleria_media_v2')).toBe(1)
    expect(await conta(`public.video_outbox WHERE event_type = 'gallery.published'`)).toBe(1)

    // Una terza chiamata con ALTRI tag non riscrive niente: la riga è quella del vincitore.
    const terza = await pubblica(intentId, [A1])
    expect(terza).toMatchObject({ ok: true, created: false, media_id: prima.media_id, n_tag_effettivi: 2 })
    expect((await unaRiga<{ t: string[] }>(`SELECT tag_students AS t FROM public.galleria_media_v2`)).t).toEqual([A1, A2])
  })

  it('due intenti insieme: ciascuno ha il suo vincitore, in qualunque ordine arrivino le chiamate', async () => {
    const a = await intentoPronto({ chiave: 'ka', tag: [A1] })
    const b = await intentoPronto({ chiave: 'kb', tag: [A2] })
    // Ordine intrecciato: a, b, a, b — poi b, a.
    const esiti = [
      await pubblica(a.intentId, [A1]),
      await pubblica(b.intentId, [A2]),
      await pubblica(a.intentId, [A1]),
      await pubblica(b.intentId, [A2]),
      await pubblica(b.intentId, [A2]),
      await pubblica(a.intentId, [A1]),
    ]
    expect(esiti.map((e) => e.created)).toEqual([true, true, false, false, false, false])
    expect(await conta('public.galleria_media_v2')).toBe(2)
    expect(await conta(`public.video_outbox WHERE event_type = 'gallery.published'`)).toBe(2)
  })

  it('tag_effettivi NON sottoinsieme dei tag dell’intento → TAG_NON_DELL_INTENTO, e non si scrive niente', async () => {
    const { intentId, jobId } = await intentoPronto({ tag: [A1, A2] })
    expect(await pubblica(intentId, [A1, A3])).toEqual({ ok: false, code: 'TAG_NON_DELL_INTENTO' })
    expect(await pubblica(intentId, [A3])).toEqual({ ok: false, code: 'TAG_NON_DELL_INTENTO' })

    expect(await conta('public.galleria_media_v2')).toBe(0)
    expect(await stato(intentId)).toMatchObject({ status: 'confirmed', tag_alunni: [A1, A2], minimizzato: false })
    expect(await conta(`public.video_outbox WHERE event_type = 'gallery.published'`)).toBe(0)
    expect(
      (await unaRiga<{ uscita: boolean }>(`SELECT output_delete_after IS NOT NULL AS uscita FROM public.video_jobs WHERE id = '${jobId}'`)).uscita,
    ).toBe(false)
  })

  it('tag_effettivi vuoto senza broadcast → NESSUN_DESTINATARIO; un broadcast con dei tag → TAG_NON_DELL_INTENTO', async () => {
    const normale = await intentoPronto({ chiave: 'k-normale', tag: [A1] })
    expect(await pubblica(normale.intentId, [])).toEqual({ ok: false, code: 'NESSUN_DESTINATARIO' })

    const diffusione = await intentoPronto({ chiave: 'k-broadcast', tag: [], broadcast: true })
    expect(await pubblica(diffusione.intentId, [A1])).toEqual({ ok: false, code: 'TAG_NON_DELL_INTENTO' })

    expect(await conta('public.galleria_media_v2')).toBe(0)
  })

  it('i doppioni nei tag effettivi non contano: {A1, A1} è {A1}', async () => {
    const { intentId } = await intentoPronto({ tag: [A1, A2] })
    expect(await pubblica(intentId, [A1, A1])).toMatchObject({ ok: true, n_tag_effettivi: 1 })
    expect((await unaRiga<{ t: string[] }>(`SELECT tag_students AS t FROM public.galleria_media_v2`)).t).toEqual([A1])
  })

  // ── IL CUORE: se il finalize rifiuta, la riga di galleria appena scritta NON resta. Ogni riga è uno
  //    stato in cui i controlli propri della funzione passano e solo `video_intent_finalize` può dire di no.
  const FINALIZE_RIFIUTA: ReadonlyArray<[string, string, (intentId: string, jobId: string) => Promise<void>]> = [
    [
      'i job non sono pronti',
      'JOBS_NOT_READY',
      async () => {},
    ],
    [
      'l’intento è stato ritirato',
      'INTENT_REVOKED',
      async (intentId) => {
        await rpc(`public.video_intent_revoke('${intentId}', '${OWNER}', 1)`)
      },
    ],
    [
      'l’intento è in attesa di intervento (non è più confirmed)',
      'NOT_CONFIRMED',
      async (intentId) => {
        await rpc(`public.video_intent_pubblicazione_fallita('${intentId}', 'PUBBLICAZIONE_NON_RIUSCITA')`)
      },
    ],
  ]

  it.each(FINALIZE_RIFIUTA)('se %s, finalize rifiuta (%s) e NESSUNA riga resta in galleria', async (descrizione, codice, prepara) => {
    // Per «i job non sono pronti» il job resta in awaiting_upload: niente `portaAPronto`.
    const { intentId, jobId } =
      codice === 'JOBS_NOT_READY' ? await aperto({ tag: [A1] }) : await intentoPronto({ tag: [A1] })
    await prepara(intentId, jobId)
    const prima = await stato(intentId)

    const r = await pubblica(intentId, [A1])
    expect(r, descrizione).toEqual({ ok: false, code: codice })

    // La riga di galleria è stata ANNULLATA (è il sottoblocco: senza il RAISE resterebbe).
    expect(await conta('public.galleria_media_v2')).toBe(0)
    expect(await conta(`public.video_outbox WHERE event_type = 'gallery.published'`)).toBe(0)
    // L'intento è com'era, e non è stato minimizzato.
    expect(await stato(intentId)).toEqual(prima)
    expect((await stato(intentId)).minimizzato).toBe(false)
    expect(
      (await unaRiga<{ uscita: boolean }>(`SELECT output_delete_after IS NOT NULL AS uscita FROM public.video_jobs WHERE id = '${jobId}'`)).uscita,
    ).toBe(false)

    // E il rifiuto resta nel LOG, scritto fuori dal sottoblocco (quelli di dentro sono stati annullati).
    const codici = (await contestiLoggati('video-galleria-pubblica')).map((c) => c.code)
    expect(codici).toContain(codice)
  })

  it('dopo un rifiuto del finalize, la STESSA pubblicazione riuscita in seguito crea la riga (nessun residuo)', async () => {
    const { intentId, jobId } = await aperto({ tag: [A1] })
    expect(await pubblica(intentId, [A1])).toEqual({ ok: false, code: 'JOBS_NOT_READY' })
    await portaAPronto(jobId)
    expect(await pubblica(intentId, [A1])).toMatchObject({ ok: true, created: true })
    expect(await conta('public.galleria_media_v2')).toBe(1)
  })

  it('una riga già presente con quell’upload_id (stato a metà) si completa: l’intento si lega a QUELLA riga', async () => {
    const { intentId } = await intentoPronto({ tag: [A1] })
    const preesistente = (await unaRiga<{ id: string }>(`
      INSERT INTO public.galleria_media_v2 (uploaded_by, scuola_id, upload_id, file_url, file_type, tag_students)
      VALUES ('${OWNER}', '${SEDE}', '${intentId}', '${percorsoGalleria(intentId)}', 'video', ${uuids([A1])})
      RETURNING id
    `)).id

    const r = await pubblica(intentId, [A1])
    expect(r).toMatchObject({ ok: true, created: false, media_id: preesistente })
    expect(await conta('public.galleria_media_v2')).toBe(1)
    expect(await stato(intentId)).toMatchObject({ status: 'published', target_id: preesistente })
  })

  it('già pubblicato, e la riga è stata purgata: risponde col target dell’intento, senza inventare i tag', async () => {
    const { intentId } = await intentoPronto({ tag: [A1] })
    const prima = await pubblica(intentId, [A1])
    await db.exec(`DELETE FROM public.galleria_media_v2`)
    const dopo = await pubblica(intentId, [A1])
    expect(dopo).toMatchObject({ ok: true, created: false, media_id: prima.media_id, n_tag: 1 })
    expect(dopo.n_tag_effettivi).toBeNull()
    expect(await conta('public.galleria_media_v2')).toBe(0)
  })

  // Rifiuti propri della funzione: nessuna scrittura, nessuna riga di galleria.
  it('rifiuta proprietario, canale, sede, revisione e intento sbagliati, senza scrivere', async () => {
    const { intentId } = await intentoPronto({ tag: [A1] })
    expect(await pubblica(intentId, [A1], { owner: ALTRO_OWNER })).toEqual({ ok: false, code: 'OWNER_MISMATCH' })
    expect(await pubblica(intentId, [A1], { scuola: ALTRA_SEDE })).toEqual({ ok: false, code: 'SCOPE_CHANGED' })
    expect(await pubblica(intentId, [A1], { revisione: 2 })).toEqual({ ok: false, code: 'REVISION_MISMATCH' })
    expect(await pubblica(INESISTENTE, [A1])).toEqual({ ok: false, code: 'NOT_FOUND' })
    expect(await conta('public.galleria_media_v2')).toBe(0)
    expect(await stato(intentId)).toMatchObject({ status: 'confirmed', tag_alunni: [A1] })

    // Un intento NON automatico (il flusso vecchio) non si pubblica da qui.
    const vecchio = await rpc<RispostaApri>(
      `public.video_intent_open('${OWNER}', '${SEDE}', 'gallery', 'publish', '{"scope":"sede"}'::jsonb,
        'vecchio', '${OWNER}/vecchio.mp4', NULL, NULL)`,
    )
    await rpc(`public.video_intent_confirm('${vecchio.intent!.id}', '${OWNER}', 1)`)
    expect(await pubblica(vecchio.intent!.id, [A1])).toEqual({ ok: false, code: 'NON_AUTOMATICA' })
    expect(await conta('public.galleria_media_v2')).toBe(0)
  })

  it('rifiuta argomenti nulli e un tag nullo dentro l’elenco (BAD_INPUT), senza scrivere', async () => {
    const { intentId } = await intentoPronto({ tag: [A1] })
    const url = percorsoGalleria(intentId)
    expect(await rpc(`public.video_galleria_pubblica(NULL, 1, '${OWNER}', '${SEDE}', '${url}', ${uuids([A1])})`)).toEqual({ ok: false, code: 'BAD_INPUT' })
    expect(await rpc(`public.video_galleria_pubblica('${intentId}', NULL, '${OWNER}', '${SEDE}', '${url}', ${uuids([A1])})`)).toEqual({ ok: false, code: 'BAD_INPUT' })
    expect(await rpc(`public.video_galleria_pubblica('${intentId}', 0, '${OWNER}', '${SEDE}', '${url}', ${uuids([A1])})`)).toEqual({ ok: false, code: 'BAD_INPUT' })
    expect(await rpc(`public.video_galleria_pubblica('${intentId}', 1, NULL, '${SEDE}', '${url}', ${uuids([A1])})`)).toEqual({ ok: false, code: 'BAD_INPUT' })
    expect(await rpc(`public.video_galleria_pubblica('${intentId}', 1, '${OWNER}', NULL, '${url}', ${uuids([A1])})`)).toEqual({ ok: false, code: 'BAD_INPUT' })
    expect(await rpc(`public.video_galleria_pubblica('${intentId}', 1, '${OWNER}', '${SEDE}', NULL, ${uuids([A1])})`)).toEqual({ ok: false, code: 'BAD_INPUT' })
    expect(await rpc(`public.video_galleria_pubblica('${intentId}', 1, '${OWNER}', '${SEDE}', '${url}', NULL::uuid[])`)).toEqual({ ok: false, code: 'BAD_INPUT' })
    expect(await rpc(`public.video_galleria_pubblica('${intentId}', 1, '${OWNER}', '${SEDE}', '${url}', ARRAY['${A1}', NULL]::uuid[])`)).toEqual({ ok: false, code: 'BAD_INPUT' })
    expect(await conta('public.galleria_media_v2')).toBe(0)
  })

  // Il percorso della galleria deve stare nella cartella dell'autore: è la forma che
  // `percorsoUploadProprio` impone in TypeScript, ripetuta qui perché la RPC è l'ultima porta.
  it.each([
    ['la cartella di un altro utente', (i: string) => `uploads/${ALTRO_OWNER}/v-${i}.mp4`],
    ['un sottopercorso', (i: string) => `uploads/${OWNER}/altro/v-${i}.mp4`],
    ['un percorso che risale', (i: string) => `uploads/${OWNER}/../${ALTRO_OWNER}/v-${i}.mp4`],
    ['un altro prefisso', (i: string) => `video/${OWNER}/v-${i}.mp4`],
    ['un nome senza estensione', (i: string) => `uploads/${OWNER}/v-${i}`],
    ['un indirizzo completo', (i: string) => `https://esempio.test/uploads/${OWNER}/v-${i}.mp4`],
    ['un percorso vuoto', () => ''],
    ['un percorso lunghissimo', (i: string) => `uploads/${OWNER}/${'a'.repeat(1100)}-${i}.mp4`],
  ])('FILE_URL_NON_VALIDO per %s', async (_d, costruisciPercorso) => {
    const { intentId } = await intentoPronto({ tag: [A1] })
    expect(await pubblica(intentId, [A1], { url: costruisciPercorso(intentId) })).toEqual({ ok: false, code: 'FILE_URL_NON_VALIDO' })
    expect(await conta('public.galleria_media_v2')).toBe(0)
    expect(await stato(intentId)).toMatchObject({ status: 'confirmed' })
  })

  it('il successo si logga con numeri e codici: né un bambino né un percorso di galleria', async () => {
    const { intentId } = await intentoPronto({ tag: [A1, A2] })
    await pubblica(intentId, [A1])
    const contesti = await contestiLoggati('video-galleria-pubblica')
    expect(contesti.some((c) => c.created === true && c.n_tag === 2 && c.n_tag_effettivi === 1)).toBe(true)
    const log = await tuttoIlLog()
    for (const vietato of [A1, A2, `uploads/${OWNER}`, 'video/mp4']) {
      expect(log, `il log contiene «${vietato}»`).not.toContain(vietato)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 6 · video_intent_esito_segna · video_intent_pubblicazione_fallita · _riprova
// ─────────────────────────────────────────────────────────────────────────────

describe('video_intent_esito_segna · l’UNICA marca delle notifiche', () => {
  const segna = (intentId: string, esito: string) => rpc(`public.video_intent_esito_segna('${intentId}', '${esito}')`)

  const marca = (intentId: string) =>
    unaRiga<{ esito: string | null; il: string | null; status: string }>(
      `SELECT esito_notificato AS esito, esito_notificato_il::text AS il, status FROM public.video_intents WHERE id = '${intentId}'`,
    )

  it('«pubblicato» si segna UNA SOLA VOLTA: la seconda chiamata perde e non tocca niente', async () => {
    const { intentId } = await intentoPronto({ tag: [A1] })
    await pubblica(intentId, [A1])

    expect(await segna(intentId, 'pubblicato')).toEqual({ ok: true, segnato: true, esito: 'pubblicato' })
    const prima = await marca(intentId)
    expect(prima.esito).toBe('pubblicato')
    expect(prima.il).not.toBeNull()

    // Chi arriva dopo (un processo che ha ripreso l'evento) NON segna, e quindi non notifica.
    expect(await segna(intentId, 'pubblicato')).toEqual({ ok: true, segnato: false, esito: 'pubblicato' })
    expect(await segna(intentId, 'pubblicato')).toEqual({ ok: true, segnato: false, esito: 'pubblicato' })
    expect(await marca(intentId)).toEqual(prima)
  })

  it('un esito già segnato vince su un altro: «fallito» dopo «pubblicato» non lo riscrive', async () => {
    const { intentId } = await intentoPronto({ tag: [A1] })
    await pubblica(intentId, [A1])
    await segna(intentId, 'pubblicato')
    expect(await segna(intentId, 'fallito')).toEqual({ ok: true, segnato: false, esito: 'pubblicato' })
    expect((await marca(intentId)).esito).toBe('pubblicato')
  })

  it('«fallito» si segna per un intento NON pubblicato (una conversione fallita, nessun destinatario)', async () => {
    const { intentId } = await intentoPronto({ tag: [A1] })
    expect(await segna(intentId, 'fallito')).toEqual({ ok: true, segnato: true, esito: 'fallito' })
    expect(await segna(intentId, 'fallito')).toEqual({ ok: true, segnato: false, esito: 'fallito' })
    // Segnare un esito NON cambia lo stato dell'intento.
    expect((await marca(intentId)).status).toBe('confirmed')
  })

  it('coerenza con lo stato: «pubblicato» solo se l’intento lo è, «fallito» solo se non lo è', async () => {
    const { intentId } = await intentoPronto({ tag: [A1] })
    expect(await segna(intentId, 'pubblicato')).toEqual({ ok: false, code: 'INVALID_STATE' })
    expect((await marca(intentId)).esito).toBeNull()

    await pubblica(intentId, [A1])
    expect(await segna(intentId, 'fallito')).toEqual({ ok: false, code: 'INVALID_STATE' })
    expect((await marca(intentId)).esito).toBeNull()
  })

  it('rifiuta argomenti sbagliati e un intento inesistente', async () => {
    expect(await rpc(`public.video_intent_esito_segna(NULL, 'pubblicato')`)).toEqual({ ok: false, code: 'BAD_INPUT' })
    expect(await segna(INESISTENTE, 'boh')).toEqual({ ok: false, code: 'BAD_INPUT' })
    expect(await rpc(`public.video_intent_esito_segna('${INESISTENTE}', NULL)`)).toEqual({ ok: false, code: 'BAD_INPUT' })
    expect(await segna(INESISTENTE, 'pubblicato')).toEqual({ ok: false, code: 'NOT_FOUND' })
  })
})

describe('video_intent_pubblicazione_fallita', () => {
  const fallita = (intentId: string, codice: string) =>
    rpc(`public.video_intent_pubblicazione_fallita('${intentId}', '${codice}')`)
  const riga = (intentId: string) =>
    unaRiga<{ status: string; errore: string | null }>(
      `SELECT status, pubblicazione_errore AS errore FROM public.video_intents WHERE id = '${intentId}'`,
    )

  it('confirmed → action_required, e scrive SOLO il codice', async () => {
    const { intentId } = await intentoPronto()
    expect(await fallita(intentId, 'PUBBLICAZIONE_NON_RIUSCITA')).toEqual({
      ok: true,
      intent: { id: intentId, status: 'action_required' },
    })
    expect(await riga(intentId)).toEqual({ status: 'action_required', errore: 'PUBBLICAZIONE_NON_RIUSCITA' })
  })

  it('è idempotente: già in action_required vince il PRIMO codice e non si riscrive niente', async () => {
    const { intentId } = await intentoPronto()
    await fallita(intentId, 'NESSUN_DESTINATARIO')
    const seconda = await fallita(intentId, 'PUBBLICAZIONE_NON_RIUSCITA')
    expect(seconda).toMatchObject({ ok: true, idempotent: true, intent: { status: 'action_required' } })
    expect(await riga(intentId)).toEqual({ status: 'action_required', errore: 'NESSUN_DESTINATARIO' })
  })

  it('rifiuta un intento pubblicato, ritirato o non automatico, e un codice che non è un codice', async () => {
    const pubblicato = await intentoPronto({ chiave: 'k-pub', tag: [A1] })
    await pubblica(pubblicato.intentId, [A1])
    expect(await fallita(pubblicato.intentId, 'PUBBLICAZIONE_NON_RIUSCITA')).toEqual({ ok: false, code: 'INTENT_PUBLISHED' })
    expect((await riga(pubblicato.intentId)).status).toBe('published')

    const ritirato = await aperto({ chiave: 'k-rit' })
    await rpc(`public.video_intent_revoke('${ritirato.intentId}', '${OWNER}', 1)`)
    expect(await fallita(ritirato.intentId, 'PUBBLICAZIONE_NON_RIUSCITA')).toEqual({ ok: false, code: 'INTENT_REVOKED' })

    const news = await apriNews('news-fallita')
    expect(await fallita(news.intentId, 'PUBBLICAZIONE_NON_RIUSCITA')).toEqual({ ok: false, code: 'NON_AUTOMATICA' })

    const ancoraPending = await aperto({ chiave: 'k-pend' })
    await db.exec(`UPDATE public.video_intents SET status = 'pending', confirmed_at = NULL WHERE id = '${ancoraPending.intentId}'`)
    expect(await fallita(ancoraPending.intentId, 'PUBBLICAZIONE_NON_RIUSCITA')).toEqual({ ok: false, code: 'INVALID_STATE' })

    const { intentId } = await intentoPronto({ chiave: 'k-ok' })
    for (const cattivo of ['minuscolo', 'CON SPAZI', '1INIZIA_CON_CIFRA', 'X'.repeat(81), '']) {
      expect(await fallita(intentId, cattivo), `«${cattivo}»`).toEqual({ ok: false, code: 'BAD_INPUT' })
    }
    expect(await rpc(`public.video_intent_pubblicazione_fallita('${intentId}', NULL)`)).toEqual({ ok: false, code: 'BAD_INPUT' })
    expect(await rpc(`public.video_intent_pubblicazione_fallita(NULL, 'CODICE')`)).toEqual({ ok: false, code: 'BAD_INPUT' })
    expect(await fallita(INESISTENTE, 'CODICE')).toEqual({ ok: false, code: 'NOT_FOUND' })
    expect((await riga(intentId)).status).toBe('confirmed')
  })

  it('accetta un codice di 80 caratteri (il limite della colonna), non di 81', async () => {
    const { intentId } = await intentoPronto()
    expect(await fallita(intentId, 'X'.repeat(80))).toMatchObject({ ok: true })
    expect((await riga(intentId)).errore).toHaveLength(80)
  })
})

describe('video_intent_pubblicazione_riprova · il «Riprova» dell’insegnante', () => {
  const riprova = (intentId: string, owner = OWNER) => rpc(`public.video_intent_pubblicazione_riprova('${intentId}', '${owner}')`)
  const stato = (intentId: string) =>
    unaRiga<{ status: string; errore: string | null; esito: string | null; esito_il: string | null }>(
      `SELECT status, pubblicazione_errore AS errore, esito_notificato AS esito, esito_notificato_il::text AS esito_il
       FROM public.video_intents WHERE id = '${intentId}'`,
    )
  const evento = (intentId: string) =>
    unaRiga<{ sent: boolean; attempts: number; lease: boolean; creato_di_recente: boolean; n: number }>(`
      SELECT sent_at IS NOT NULL AS sent, attempts, lease_owner IS NOT NULL AS lease,
             created_at > clock_timestamp() - interval '1 minute' AS creato_di_recente,
             (SELECT count(*)::int FROM public.video_outbox WHERE intent_id = '${intentId}' AND event_type = 'gallery.auto_publish') AS n
      FROM public.video_outbox WHERE intent_id = '${intentId}' AND event_type = 'gallery.auto_publish'
    `)

  /**
   * Un intento il cui evento di pubblicazione è stato PRESO, FALLITO e CHIUSO dal pubblicatore, con la
   * pubblicazione dichiarata non riuscita e la marca «fallito» già scritta: lo stato in cui l'insegnante
   * vede il pulsante «Riprova».
   */
  async function inAttesaDiRiprova(chiave = 'k1'): Promise<{ intentId: string; jobId: string }> {
    const { intentId, jobId } = await intentoPronto({ chiave, tag: [A1, A2] })
    // Il pubblicatore prende l'evento (tentativi > 0), fallisce per oltre 60 minuti, lo dichiara fallito
    // e lo CHIUDE: `sent_at` valorizzato.
    const preso = await rpc<{ ok: boolean; eventi: Array<{ id: string }> }>(`public.video_outbox_claim('${LEASE_B}', 60, 10)`)
    expect(preso.eventi).toHaveLength(1)
    await rpc(`public.video_intent_pubblicazione_fallita('${intentId}', 'PUBBLICAZIONE_NON_RIUSCITA')`)
    await rpc(`public.video_intent_esito_segna('${intentId}', 'fallito')`)
    await rpc(`public.video_outbox_sent('${preso.eventi[0].id}', '${LEASE_B}')`)
    // E l'evento è vecchio: lo si porta indietro, per provare che il «Riprova» lo fa ripartire da adesso.
    await db.exec(`UPDATE public.video_outbox SET created_at = created_at - interval '2 hours', updated_at = updated_at - interval '2 hours' WHERE intent_id = '${intentId}'`)
    return { intentId, jobId }
  }

  it('riporta a confirmed, azzera errore ed esito, e RIARMA l’evento di pubblicazione (stesso evento, da capo)', async () => {
    const { intentId } = await inAttesaDiRiprova()
    expect(await stato(intentId)).toMatchObject({ status: 'action_required', errore: 'PUBBLICAZIONE_NON_RIUSCITA', esito: 'fallito' })
    expect(await evento(intentId)).toMatchObject({ sent: true, attempts: 1, n: 1, creato_di_recente: false })

    expect(await riprova(intentId)).toEqual({ ok: true, intent: { id: intentId, status: 'confirmed' } })

    expect(await stato(intentId)).toEqual({ status: 'confirmed', errore: null, esito: null, esito_il: null })
    // UN evento solo (l'UNIQUE), riarmato: non chiuso, senza tentativi né lease, e datato ADESSO — il
    // pubblicatore conta i suoi 60 minuti da `created_at`.
    expect(await evento(intentId)).toEqual({ sent: false, attempts: 0, lease: false, creato_di_recente: true, n: 1 })
  })

  it('dopo il «Riprova» la pubblicazione riesce e la marca si può scrivere di nuovo, una volta', async () => {
    const { intentId } = await inAttesaDiRiprova()
    await riprova(intentId)
    expect(await pubblica(intentId, [A1, A2])).toMatchObject({ ok: true, created: true })
    expect(await rpc(`public.video_intent_esito_segna('${intentId}', 'pubblicato')`)).toEqual({ ok: true, segnato: true, esito: 'pubblicato' })
    expect(await rpc(`public.video_intent_esito_segna('${intentId}', 'pubblicato')`)).toMatchObject({ segnato: false })
  })

  it('non è ripetibile: dopo il «Riprova» l’intento è confirmed, e un secondo clic dice RIPROVA_NON_POSSIBILE', async () => {
    const { intentId } = await inAttesaDiRiprova()
    await riprova(intentId)
    expect(await riprova(intentId)).toEqual({ ok: false, code: 'RIPROVA_NON_POSSIBILE', motivo: 'stato' })
  })

  // Ogni riga è una ragione per cui riprovare NON ha senso. Tutte rispondono RIPROVA_NON_POSSIBILE col
  // MOTIVO (per il log e per la frase che la route traduce), e nessuna tocca niente.
  const NON_POSSIBILE: ReadonlyArray<[string, string, (intentId: string, jobId: string) => Promise<void>]> = [
    ['l’intento è ancora confirmed', 'stato', async (i) => {
      await db.exec(`UPDATE public.video_intents SET status = 'confirmed', pubblicazione_errore = NULL WHERE id = '${i}'`)
    }],
    ['l’intento non è automatico (il flusso vecchio)', 'non-automatica', async (i) => {
      await db.exec(`UPDATE public.video_intents SET pubblicazione_automatica = false WHERE id = '${i}'`)
    }],
    ['i tag sono stati minimizzati (non si saprebbe a chi pubblicare)', 'minimizzato', async (i) => {
      await db.exec(`UPDATE public.video_intents SET minimizzato_il = now() WHERE id = '${i}'`)
    }],
    ['il job non è più pronto', 'job-non-pronti', async (_i, j) => {
      await db.exec(`UPDATE public.video_jobs SET status = 'cancelled' WHERE id = '${j}'`)
    }],
    ['l’uscita è già stata tolta dalla conservazione', 'uscita-rimossa', async (_i, j) => {
      await db.exec(`UPDATE public.video_jobs SET output_delete_after = now(), output_deleted_at = now() WHERE id = '${j}'`)
    }],
    ['sono passati 7 giorni dalla verifica', 'scaduto', async (_i, j) => {
      await db.exec(`
        UPDATE public.video_jobs
        SET verified_at = verified_at - interval '8 days',
            original_delete_after = verified_at - interval '8 days' + interval '7 days'
        WHERE id = '${j}'
      `)
    }],
    ['l’uscita sta per essere tolta (la scadenza è passata ma il file c’è ancora)', 'scaduto', async (_i, j) => {
      await db.exec(`UPDATE public.video_jobs SET output_delete_after = clock_timestamp() - interval '1 second' WHERE id = '${j}'`)
    }],
  ]

  it.each(NON_POSSIBILE)('RIPROVA_NON_POSSIBILE se %s (%s)', async (_d, motivo, rovina) => {
    const { intentId, jobId } = await inAttesaDiRiprova()
    await rovina(intentId, jobId)
    const prima = { stato: await stato(intentId), evento: await evento(intentId) }

    expect(await riprova(intentId)).toEqual({ ok: false, code: 'RIPROVA_NON_POSSIBILE', motivo })

    expect({ stato: await stato(intentId), evento: await evento(intentId) }).toEqual(prima)
  })

  it('solo l’AUTORE: un altro proprietario prende OWNER_MISMATCH, e non cambia niente', async () => {
    const { intentId } = await inAttesaDiRiprova()
    const prima = await stato(intentId)
    expect(await riprova(intentId, ALTRO_OWNER)).toEqual({ ok: false, code: 'OWNER_MISMATCH' })
    expect(await stato(intentId)).toEqual(prima)
  })

  it('rifiuta argomenti nulli e un intento inesistente', async () => {
    expect(await rpc(`public.video_intent_pubblicazione_riprova(NULL, '${OWNER}')`)).toEqual({ ok: false, code: 'BAD_INPUT' })
    expect(await rpc(`public.video_intent_pubblicazione_riprova('${INESISTENTE}', NULL)`)).toEqual({ ok: false, code: 'BAD_INPUT' })
    expect(await riprova(INESISTENTE)).toEqual({ ok: false, code: 'NOT_FOUND' })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 7 · sorveglianza esclusiva, tetto parallelo, diagnosi
// ─────────────────────────────────────────────────────────────────────────────

/** Un job News in coda (`queued`): il file è arrivato, nessuno lo ha ancora preso. */
async function inCoda(chiave: string, conn: PGlite = db, minutiFa = 0): Promise<{ intentId: string; jobId: string }> {
  const n = await apriNews(chiave, conn)
  await rpc(`public.video_job_uploaded('${n.jobId}', '${OWNER}', 5000, 'video/mp4')`, conn)
  if (minutiFa > 0) {
    await conn.exec(`
      UPDATE public.video_jobs
      SET created_at = created_at - interval '${minutiFa} minutes', updated_at = updated_at - interval '${minutiFa} minutes'
      WHERE id = '${n.jobId}'
    `)
  }
  return n
}

/** Un job News in lavorazione: preso da LEASE_A (attempt 1, fence 1, lease di 300 secondi). */
async function inLavorazione(chiave: string, conn: PGlite = db, lease = LEASE_A): Promise<{ intentId: string; jobId: string }> {
  const n = await inCoda(chiave, conn)
  const preso = await rpc(`public.video_job_claim('${n.jobId}', '${lease}', 300)`, conn)
  expect(preso.ok, `la presa di ${chiave} doveva riuscire`).toBe(true)
  return n
}

const scadiLease = (jobId: string, conn: PGlite = db) =>
  conn.exec(`UPDATE public.video_jobs SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = '${jobId}'`)

describe('video_job_sorveglianza_prendi / _rilascia · una sola invocazione per job', () => {
  const prendi = (jobId: string, invocazione: string, secondi = 270) =>
    rpc(`public.video_job_sorveglianza_prendi('${jobId}', '${invocazione}', ${secondi})`)
  const rilascia = (jobId: string, invocazione: string) =>
    rpc(`public.video_job_sorveglianza_rilascia('${jobId}', '${invocazione}')`)
  const lease = (jobId: string) =>
    unaRiga<{ da: string | null; ancora_s: number | null; aggiornato: string }>(`
      SELECT sorvegliato_da AS da,
             round(EXTRACT(EPOCH FROM (sorvegliato_fino_a - clock_timestamp())))::int AS ancora_s,
             updated_at::text AS aggiornato
      FROM public.video_jobs WHERE id = '${jobId}'
    `)

  it('la prima invocazione ottiene la lease (270 secondi), la seconda risponde GIA_SORVEGLIATO e non la sposta', async () => {
    const { jobId } = await inLavorazione('s1')
    const prima = await prendi(jobId, INV_1)
    expect(prima).toMatchObject({ ok: true })
    expect(prima.sorvegliato_fino_a).toBeTruthy()
    const dopoPrima = await lease(jobId)
    expect(dopoPrima.da).toBe(INV_1)
    expect(dopoPrima.ancora_s).toBeGreaterThan(260)
    expect(dopoPrima.ancora_s).toBeLessThanOrEqual(270)

    // Un esito TRANQUILLO: nessuna eccezione, nessun errore di livello `error` nel log.
    expect(await prendi(jobId, INV_2)).toEqual({ ok: false, code: 'GIA_SORVEGLIATO' })
    expect((await lease(jobId)).da).toBe(INV_1)
    const livelli = (await righe<{ livello: string; code: string | null }>(`
      SELECT payload -> 0 ->> 'livello' AS livello, payload -> 0 -> 'contesto' ->> 'code' AS code
      FROM public.log_migrazioni WHERE payload -> 0 ->> 'evento' = 'video-job-sorveglianza' ORDER BY ctid
    `))
    expect(livelli.find((l) => l.code === 'GIA_SORVEGLIATO')?.livello).toBe('info')
  })

  it('la STESSA invocazione che ripete la rinnova', async () => {
    const { jobId } = await inLavorazione('s2')
    await prendi(jobId, INV_1, 60)
    const corta = await lease(jobId)
    expect(await prendi(jobId, INV_1, 600)).toMatchObject({ ok: true })
    const lunga = await lease(jobId)
    expect(lunga.da).toBe(INV_1)
    expect(lunga.ancora_s!).toBeGreaterThan(corta.ancora_s! + 400)
  })

  it('una lease SCADUTA si riprende: l’invocazione che non c’è più non blocca il job', async () => {
    const { jobId } = await inLavorazione('s3')
    await prendi(jobId, INV_1)
    await db.exec(`UPDATE public.video_jobs SET sorvegliato_fino_a = clock_timestamp() - interval '1 second' WHERE id = '${jobId}'`)
    expect(await prendi(jobId, INV_2)).toMatchObject({ ok: true })
    expect((await lease(jobId)).da).toBe(INV_2)
  })

  it('un job in coda si sorveglia come uno in lavorazione (la sorveglianza viene PRIMA della presa)', async () => {
    const { jobId } = await inCoda('s4')
    expect(await prendi(jobId, INV_1)).toMatchObject({ ok: true })
  })

  it('NON tocca updated_at: guardare un job non è un progresso (la rete degli incagliati misura i progressi)', async () => {
    const { jobId } = await inLavorazione('s5')
    const prima = (await lease(jobId)).aggiornato
    await prendi(jobId, INV_1)
    await rilascia(jobId, INV_1)
    expect((await lease(jobId)).aggiornato).toBe(prima)
  })

  it('rilascia: chi la tiene la libera; chi non la tiene non fa niente (non è un errore)', async () => {
    const { jobId } = await inLavorazione('s6')
    await prendi(jobId, INV_1)

    expect(await rilascia(jobId, INV_2)).toEqual({ ok: true, rilasciato: false })
    expect((await lease(jobId)).da).toBe(INV_1)

    expect(await rilascia(jobId, INV_1)).toEqual({ ok: true, rilasciato: true })
    expect((await lease(jobId)).da).toBeNull()
    // Ora la prende chiunque, e rilasciare di nuovo non rompe niente.
    expect(await rilascia(jobId, INV_1)).toEqual({ ok: true, rilasciato: false })
    expect(await prendi(jobId, INV_2)).toMatchObject({ ok: true })
  })

  it('si sorveglia solo un job queued o processing: un job concluso risponde INVALID_STATE', async () => {
    const attesa = await apriNews('s7-attesa') // awaiting_upload
    expect(await prendi(attesa.jobId, INV_1)).toEqual({ ok: false, code: 'INVALID_STATE' })

    const { jobId } = await inLavorazione('s7-pronto')
    await rpc(`public.video_job_ready('${jobId}', 1, '${LEASE_A}', 'outputs/${jobId}/f.mp4', 900, '{"durationSeconds":20}'::jsonb)`)
    expect(await prendi(jobId, INV_1)).toEqual({ ok: false, code: 'INVALID_STATE' })
    expect((await lease(jobId)).da).toBeNull()
  })

  it('rifiuta argomenti nulli o fuori misura, e un job inesistente', async () => {
    const { jobId } = await inLavorazione('s8')
    expect(await rpc(`public.video_job_sorveglianza_prendi(NULL, '${INV_1}', 270)`)).toEqual({ ok: false, code: 'BAD_INPUT' })
    expect(await rpc(`public.video_job_sorveglianza_prendi('${jobId}', NULL, 270)`)).toEqual({ ok: false, code: 'BAD_INPUT' })
    expect(await rpc(`public.video_job_sorveglianza_prendi('${jobId}', '${INV_1}', NULL)`)).toEqual({ ok: false, code: 'BAD_INPUT' })
    expect(await prendi(jobId, INV_1, 0)).toEqual({ ok: false, code: 'BAD_INPUT' })
    expect(await prendi(jobId, INV_1, 901)).toEqual({ ok: false, code: 'BAD_INPUT' })
    expect(await prendi(INESISTENTE, INV_1)).toEqual({ ok: false, code: 'NOT_FOUND' })
    expect(await rilascia(INESISTENTE, INV_1)).toEqual({ ok: false, code: 'NOT_FOUND' })
    expect(await rpc(`public.video_job_sorveglianza_rilascia(NULL, '${INV_1}')`)).toEqual({ ok: false, code: 'BAD_INPUT' })
    expect((await lease(jobId)).da).toBeNull()
  })
})

describe('video_job_prendi / video_job_prossimo · il tetto dei Sandbox in parallelo', () => {
  const prendi = (jobId: string, owner = LEASE_A, tetto = 3, secondi = 300) =>
    rpc(`public.video_job_prendi('${jobId}', '${owner}', ${secondi}, ${tetto})`)
  const prossimo = (owner = LEASE_A, tetto = 3, secondi = 300) =>
    rpc(`public.video_job_prossimo('${owner}', ${secondi}, ${tetto})`)
  const riga = (jobId: string) =>
    unaRiga<{ status: string; attempt: number; fence: number }>(
      `SELECT status, attempt, fence_epoch::int AS fence FROM public.video_jobs WHERE id = '${jobId}'`,
    )

  /** `n` job in lavorazione con la lease VIVA. */
  async function treInLavorazione(n = 3): Promise<string[]> {
    const ids: string[] = []
    for (let i = 0; i < n; i++) ids.push((await inLavorazione(`p${i}`)).jobId)
    return ids
  }

  it('sotto il tetto DELEGA a video_job_claim: il job passa a processing con la lease', async () => {
    await treInLavorazione(2)
    const { jobId } = await inCoda('q1')
    expect(await prendi(jobId, LEASE_A, 3, 111)).toMatchObject({
      ok: true,
      job: { id: jobId, status: 'processing', attempt: 1, fence_epoch: 1, lease_owner: LEASE_A },
    })
    expect(await riga(jobId)).toEqual({ status: 'processing', attempt: 1, fence: 1 })
  })

  it('al tetto risponde CAPACITA_PIENA con i numeri, e NON tocca il job', async () => {
    await treInLavorazione(3)
    const { jobId } = await inCoda('q1')
    expect(await prendi(jobId, LEASE_A, 3)).toEqual({ ok: false, code: 'CAPACITA_PIENA', in_lavorazione: 3, tetto: 3 })
    expect(await riga(jobId)).toEqual({ status: 'queued', attempt: 0, fence: 0 })
    // Con un posto in più si prende.
    expect(await prendi(jobId, LEASE_A, 4)).toMatchObject({ ok: true, job: { status: 'processing' } })
  })

  it('il tetto conta i job con la lease VIVA: quelli a lease scaduta non occupano un posto', async () => {
    const ids = await treInLavorazione(3)
    await scadiLease(ids[0])
    await scadiLease(ids[1])
    const { jobId } = await inCoda('q1')
    // Vivo ne resta UNO: con tetto 2 c'è posto.
    expect(await prendi(jobId, LEASE_A, 2)).toMatchObject({ ok: true })
    // Ora i vivi sono due (quello rimasto + questo): il tetto 2 è pieno.
    const altro = await inCoda('q2')
    expect(await prendi(altro.jobId, LEASE_A, 2)).toMatchObject({ ok: false, code: 'CAPACITA_PIENA', in_lavorazione: 2 })
  })

  it('un job GIÀ MIO e vivo non occupa un posto in più: a capacità piena il runner riprende il proprio lavoro', async () => {
    const ids = await treInLavorazione(3)
    // Il riaggancio di una seconda invocazione: `video_job_claim` lo riconosce (idempotente) e non sposta niente.
    expect(await prendi(ids[0], LEASE_A, 3)).toMatchObject({ ok: true, job: { id: ids[0], attempt: 1, fence_epoch: 1 } })
    expect(await riga(ids[0])).toEqual({ status: 'processing', attempt: 1, fence: 1 })
    // Ma un ALTRO proprietario non lo riprende: a capacità piena prende CAPACITA_PIENA, non LEASE_ACTIVE.
    expect(await prendi(ids[0], LEASE_B, 3)).toMatchObject({ ok: false, code: 'CAPACITA_PIENA' })
    // Con posto libero la sua risposta passa tale e quale: il rifiuto è quello di claim.
    expect(await prendi(ids[0], LEASE_B, 4)).toEqual({ ok: false, code: 'LEASE_ACTIVE' })
  })

  it('i rifiuti di claim escono col LORO codice (nessuna copia della disciplina dei tentativi)', async () => {
    expect(await prendi(INESISTENTE, LEASE_A, 3)).toEqual({ ok: false, code: 'NOT_FOUND' })
    const attesa = await apriNews('q-attesa') // awaiting_upload
    expect(await prendi(attesa.jobId)).toEqual({ ok: false, code: 'INVALID_STATE' })
    // Un ritentativo non ancora dovuto: RETRY_NOT_DUE è un codice della PR 1, che passa.
    const { jobId } = await inLavorazione('q-retry')
    await rpc(`public.video_job_retry('${jobId}', 1, '${LEASE_A}', 'BUILD_DOWNLOAD_FAILED', 4, 300)`)
    expect(await prendi(jobId)).toEqual({ ok: false, code: 'RETRY_NOT_DUE' })
  })

  it('rifiuta argomenti nulli o fuori misura PRIMA di prendere il lock di capacità', async () => {
    const { jobId } = await inCoda('q1')
    expect(await prendi(jobId, LEASE_A, 0)).toEqual({ ok: false, code: 'BAD_INPUT' })
    expect(await prendi(jobId, LEASE_A, 51)).toEqual({ ok: false, code: 'BAD_INPUT' })
    expect(await rpc(`public.video_job_prendi('${jobId}', '${LEASE_A}', 300, NULL)`)).toEqual({ ok: false, code: 'BAD_INPUT' })
    expect(await prendi(jobId, LEASE_A, 3, 0)).toEqual({ ok: false, code: 'BAD_INPUT' })
    expect(await prendi(jobId, LEASE_A, 3, 1801)).toEqual({ ok: false, code: 'BAD_INPUT' })
    expect(await rpc(`public.video_job_prendi(NULL, '${LEASE_A}', 300, 3)`)).toEqual({ ok: false, code: 'BAD_INPUT' })
    expect(await rpc(`public.video_job_prendi('${jobId}', NULL, 300, 3)`)).toEqual({ ok: false, code: 'BAD_INPUT' })
    expect(await riga(jobId)).toEqual({ status: 'queued', attempt: 0, fence: 0 })
  })

  it('video_job_prossimo: prende il più vecchio in coda (FIFO) se c’è posto', async () => {
    const recente = await inCoda('f-recente', db, 0)
    const vecchio = await inCoda('f-vecchio', db, 30)
    expect(await prossimo(LEASE_A, 3)).toMatchObject({ ok: true, job: { id: vecchio.jobId, status: 'processing' } })
    expect((await riga(recente.jobId)).status).toBe('queued')
  })

  it('video_job_prossimo: coda vuota → EMPTY_QUEUE (il codice di video_job_next, tale e quale)', async () => {
    expect(await prossimo()).toEqual({ ok: false, code: 'EMPTY_QUEUE' })
  })

  it('video_job_prossimo: al tetto → CAPACITA_PIENA, e il job in coda resta in coda', async () => {
    await treInLavorazione(3)
    const { jobId } = await inCoda('f-coda')
    expect(await prossimo(LEASE_A, 3)).toEqual({ ok: false, code: 'CAPACITA_PIENA', in_lavorazione: 3, tetto: 3 })
    expect(await riga(jobId)).toEqual({ status: 'queued', attempt: 0, fence: 0 })
    expect(await prossimo(LEASE_A, 4)).toMatchObject({ ok: true, job: { id: jobId } })
  })

  it('video_job_prossimo: rifiuta argomenti nulli o fuori misura', async () => {
    expect(await rpc(`public.video_job_prossimo(NULL, 300, 3)`)).toEqual({ ok: false, code: 'BAD_INPUT' })
    expect(await prossimo(LEASE_A, 0)).toEqual({ ok: false, code: 'BAD_INPUT' })
    expect(await prossimo(LEASE_A, 51)).toEqual({ ok: false, code: 'BAD_INPUT' })
    expect(await prossimo(LEASE_A, 3, 0)).toEqual({ ok: false, code: 'BAD_INPUT' })
    expect(await rpc(`public.video_job_prossimo('${LEASE_A}', 300, NULL)`)).toEqual({ ok: false, code: 'BAD_INPUT' })
  })

  // ── LA DELEGA È VERA: `video_job_claim` e `video_job_next` si sostituiscono con una SPIA che registra la
  //    chiamata e risponde una cosa riconoscibile. Con una copia della logica dentro `video_job_prendi` /
  //    `video_job_prossimo` la risposta sarebbe quella vera e il test resterebbe rosso.
  describe('la delega a claim e a next è reale (con una spia)', () => {
    let spia: PGlite

    beforeAll(async () => {
      spia = await costruisci()
      await spia.exec(`
        CREATE TABLE public.chiamate_spia (quale text NOT NULL, argomenti text NOT NULL);
        CREATE OR REPLACE FUNCTION public.video_job_claim(p_job_id uuid, p_lease_owner uuid, p_lease_seconds integer)
        RETURNS jsonb LANGUAGE plpgsql AS $$
        BEGIN
          INSERT INTO public.chiamate_spia VALUES ('claim', p_job_id::text || '|' || p_lease_owner::text || '|' || p_lease_seconds::text);
          RETURN jsonb_build_object('ok', true, 'spia', 'claim');
        END $$;
        CREATE OR REPLACE FUNCTION public.video_job_next(p_lease_owner uuid, p_lease_seconds integer)
        RETURNS jsonb LANGUAGE plpgsql AS $$
        BEGIN
          INSERT INTO public.chiamate_spia VALUES ('next', p_lease_owner::text || '|' || p_lease_seconds::text);
          RETURN jsonb_build_object('ok', true, 'spia', 'next');
        END $$;
      `)
    }, 60_000)

    afterAll(async () => {
      await spia.close()
    })

    beforeEach(async () => {
      await svuota(spia)
      await spia.exec('TRUNCATE public.chiamate_spia')
    })

    it('video_job_prendi risponde ESATTAMENTE ciò che risponde video_job_claim, con i suoi argomenti', async () => {
      const { jobId } = await inCoda('spia-1', spia)
      expect(await rpc(`public.video_job_prendi('${jobId}', '${LEASE_B}', 123, 3)`, spia)).toEqual({ ok: true, spia: 'claim' })
      expect(await righe(`SELECT quale, argomenti FROM public.chiamate_spia`, spia)).toEqual([
        { quale: 'claim', argomenti: `${jobId}|${LEASE_B}|123` },
      ])
    })

    it('video_job_prossimo risponde ESATTAMENTE ciò che risponde video_job_next, con i suoi argomenti', async () => {
      expect(await rpc(`public.video_job_prossimo('${LEASE_B}', 77, 3)`, spia)).toEqual({ ok: true, spia: 'next' })
      expect(await righe(`SELECT quale, argomenti FROM public.chiamate_spia`, spia)).toEqual([
        { quale: 'next', argomenti: `${LEASE_B}|77` },
      ])
    })

    it('a capacità piena la CAPACITA_PIENA si decide SENZA chiamare il delegato', async () => {
      // Tre job «in lavorazione» con la lease viva, scritti direttamente (la spia non cambia lo stato).
      for (let i = 0; i < 3; i++) {
        const n = await inCoda(`spia-pieno-${i}`, spia)
        await spia.exec(`
          UPDATE public.video_jobs
          SET status = 'processing', attempt = 1, fence_epoch = 1, lease_owner = '${LEASE_A}',
              lease_expires_at = clock_timestamp() + interval '5 minutes'
          WHERE id = '${n.jobId}'
        `)
      }
      const { jobId } = await inCoda('spia-nuovo', spia)
      expect(await rpc(`public.video_job_prendi('${jobId}', '${LEASE_B}', 300, 3)`, spia)).toMatchObject({ code: 'CAPACITA_PIENA' })
      expect(await rpc(`public.video_job_prossimo('${LEASE_B}', 300, 3)`, spia)).toMatchObject({ code: 'CAPACITA_PIENA' })
      expect(await conta('public.chiamate_spia', spia)).toBe(0)
    })
  })
})

describe('video_job_diagnosi · solo numeri ed enumerati', () => {
  const diagnosi = (jobId: string, json: string, fence = 1, owner = LEASE_A) =>
    rpc(`public.video_job_diagnosi('${jobId}', ${fence}, '${owner}', '${json}'::jsonb)`)
  const letta = async (jobId: string) =>
    (await unaRiga<{ d: unknown }>(`SELECT diagnosi_verifica AS d FROM public.video_jobs WHERE id = '${jobId}'`)).d

  const COMPLETA = {
    esito: 'TERMINAL_COVERAGE_MISMATCH',
    frame: { sorgente: 264, uscita: 264 },
    copertura_s: { sorgente: 8.72406, uscita: 8.754358 },
    tolleranza_ms: 3.036,
    hdr: false,
    trasferimento: 'arib-std-b67',
    formato: 'yuv420p10le',
    modalita: 'preserve',
    tracce_audio: [1, 2],
    nota: null,
  }

  it('scrive la diagnosi (numeri, booleani, enumerati, null, oggetti e liste annidati) e la sovrascrive al giro dopo', async () => {
    const { jobId } = await inLavorazione('d1')
    expect(await diagnosi(jobId, JSON.stringify(COMPLETA))).toEqual({ ok: true })
    expect(await letta(jobId)).toEqual(COMPLETA)
    // Il tentativo successivo riscrive: vale l'ultima misura.
    expect(await diagnosi(jobId, '{"esito": "OK"}')).toEqual({ ok: true })
    expect(await letta(jobId)).toEqual({ esito: 'OK' })
    // E non cambia niente dello stato del job.
    expect((await unaRiga<{ status: string; attempt: number }>(`SELECT status, attempt FROM public.video_jobs WHERE id = '${jobId}'`))).toEqual({ status: 'processing', attempt: 1 })
  })

  it('con la fence sbagliata (un worker scaduto) → FENCE_MISMATCH, e non scrive', async () => {
    const { jobId } = await inLavorazione('d2')
    expect(await diagnosi(jobId, '{"a": 1}', 2)).toEqual({ ok: false, code: 'FENCE_MISMATCH' })
    expect(await diagnosi(jobId, '{"a": 1}', 0)).toEqual({ ok: false, code: 'FENCE_MISMATCH' })
    expect(await letta(jobId)).toBeNull()
  })

  it('con un owner di lease diverso → LEASE_MISMATCH, e non scrive', async () => {
    const { jobId } = await inLavorazione('d3')
    expect(await diagnosi(jobId, '{"a": 1}', 1, LEASE_B)).toEqual({ ok: false, code: 'LEASE_MISMATCH' })
    expect(await letta(jobId)).toBeNull()
  })

  it('un job che non è in lavorazione → INVALID_STATE; un job inesistente → NOT_FOUND', async () => {
    const coda = await inCoda('d4')
    expect(await diagnosi(coda.jobId, '{"a": 1}', 0)).toEqual({ ok: false, code: 'INVALID_STATE' })
    const pronto = await inLavorazione('d4-pronto')
    await rpc(`public.video_job_ready('${pronto.jobId}', 1, '${LEASE_A}', 'outputs/${pronto.jobId}/f.mp4', 900, '{"durationSeconds":20}'::jsonb)`)
    expect(await diagnosi(pronto.jobId, '{"a": 1}')).toEqual({ ok: false, code: 'INVALID_STATE' })
    expect(await diagnosi(INESISTENTE, '{"a": 1}')).toEqual({ ok: false, code: 'NOT_FOUND' })
    expect(await letta(coda.jobId)).toBeNull()
  })

  // Ogni riga è un modo di far entrare testo libero, o qualcosa che non è un oggetto, nella colonna.
  const RIFIUTATE: ReadonlyArray<[string, string]> = [
    ['un array al posto di un oggetto', '[1, 2, 3]'],
    ['una stringa al posto di un oggetto', '"TERMINAL_COVERAGE_MISMATCH"'],
    ['un numero al posto di un oggetto', '42'],
    ['un null JSON', 'null'],
    ['testo libero con degli spazi', '{"nota": "il video di mario rossi"}'],
    ['un nome di file (ha un punto)', '{"file": "recita.mov"}'],
    ['un orario', '{"inizio": "00:30:15"}'],
    ['un frame rate frazionario come stringa', '{"fps": "30000/1001"}'],
    ['una stringa con lettere accentate', '{"citta": "città"}'],
    ['una stringa che comincia per cifra', '{"profilo": "10bit"}'],
    ['una stringa vuota', '{"k": ""}'],
    ['una stringa di 65 caratteri', `{"k": "${'a'.repeat(65)}"}`],
    ['testo libero nascosto dentro una lista annidata', '{"a": {"b": [1, "ok", "no no"]}}'],
    ['più di 2048 byte (anche di soli numeri)', `{${Array.from({ length: 300 }, (_, i) => `"k${i}": 123456`).join(', ')}}`],
  ]

  it.each(RIFIUTATE)('BAD_INPUT per %s, e non scrive', async (_d, json) => {
    const { jobId } = await inLavorazione('d5')
    await diagnosi(jobId, '{"prima": 1}')
    expect(await diagnosi(jobId, json)).toEqual({ ok: false, code: 'BAD_INPUT' })
    expect(await letta(jobId)).toEqual({ prima: 1 })
  })

  it('accetta le stringhe-enumerato ai limiti: una lettera, 64 caratteri, trattini e sottolineati', async () => {
    const { jobId } = await inLavorazione('d6')
    const limite = `a${'b'.repeat(63)}`
    expect(await diagnosi(jobId, `{"a": "x", "b": "${limite}", "c": "arib-std-b67", "d": "A_B-c9"}`)).toEqual({ ok: true })
    expect(limite).toHaveLength(64)
  })

  it('rifiuta argomenti nulli', async () => {
    const { jobId } = await inLavorazione('d7')
    expect(await rpc(`public.video_job_diagnosi(NULL, 1, '${LEASE_A}', '{}'::jsonb)`)).toEqual({ ok: false, code: 'BAD_INPUT' })
    expect(await rpc(`public.video_job_diagnosi('${jobId}', NULL, '${LEASE_A}', '{}'::jsonb)`)).toEqual({ ok: false, code: 'BAD_INPUT' })
    expect(await rpc(`public.video_job_diagnosi('${jobId}', 1, NULL, '{}'::jsonb)`)).toEqual({ ok: false, code: 'BAD_INPUT' })
    expect(await rpc(`public.video_job_diagnosi('${jobId}', 1, '${LEASE_A}', NULL)`)).toEqual({ ok: false, code: 'BAD_INPUT' })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 8 · video_runner_kick · video_runner_ventaglio
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Un database con un FINTO `pg_net` e un finto `cron_config`: `net.http_post` scrive la chiamata in una
 * tabella invece di spedirla, e `cron_config` legge i valori da una tabella. Lo stub non ha né l'uno né
 * l'altro, ed è esattamente il database della CI e di PGlite: qui si prova anche il caso in cui ci sono.
 */
async function costruisciConPgNet(): Promise<PGlite> {
  const conn = await costruisci()
  await conn.exec(`
    CREATE SCHEMA net;
    CREATE TABLE net.chiamate (ordine serial PRIMARY KEY, url text, body jsonb, headers jsonb);
    CREATE FUNCTION net.http_post(
      url text,
      body jsonb DEFAULT '{}'::jsonb,
      params jsonb DEFAULT '{}'::jsonb,
      headers jsonb DEFAULT '{"Content-Type": "application/json"}'::jsonb,
      timeout_milliseconds integer DEFAULT 5000
    ) RETURNS bigint LANGUAGE plpgsql AS $$
    BEGIN
      INSERT INTO net.chiamate(url, body, headers) VALUES (url, body, headers);
      RETURN 1;
    END $$;

    CREATE TABLE public.cron_finto (nome text PRIMARY KEY, valore text);
    CREATE FUNCTION public.cron_config(p_nome text) RETURNS text LANGUAGE sql AS $$
      SELECT valore FROM public.cron_finto WHERE nome = p_nome
    $$;
  `)
  return conn
}

const configura = (conn: PGlite, valori: Record<string, string>) =>
  conn.exec(
    `INSERT INTO public.cron_finto(nome, valore) VALUES ${Object.entries(valori)
      .map(([k, v]) => `('${k}', '${v}')`)
      .join(', ')} ON CONFLICT (nome) DO UPDATE SET valore = EXCLUDED.valore`,
  )

const chiamate = (conn: PGlite) =>
  righe<{ url: string; body: { job_id?: string }; headers: Record<string, string> }>(
    `SELECT url, body, headers FROM net.chiamate ORDER BY ordine`,
    conn,
  )

describe('video_runner_kick · senza pg_net (il database della CI, PGlite)', () => {
  it('non fa NIENTE, non solleva, e lascia una riga di log che dice perché', async () => {
    const { jobId } = await inCoda('k-senza-net')
    expect(await rpc(`public.video_runner_kick('${jobId}')`)).toEqual({ ok: true, inviato: false, motivo: 'pg-net-assente' })
    const log = await righe<{ livello: string; code: string }>(`
      SELECT payload -> 0 ->> 'livello' AS livello, payload -> 0 -> 'contesto' ->> 'code' AS code
      FROM public.log_migrazioni WHERE payload -> 0 ->> 'evento' = 'video-runner-kick'
    `)
    expect(log).toEqual([{ livello: 'info', code: 'PG_NET_ASSENTE' }])
  })

  it('un job nullo → BAD_INPUT, senza sollevare', async () => {
    expect(await rpc(`public.video_runner_kick(NULL)`)).toEqual({ ok: false, code: 'BAD_INPUT' })
  })

  it('la guardia cerca http_post PER NOME: una firma diversa di pg_net non la fa tacere', async () => {
    // Una versione di pg_net con una firma DIVERSA (nessun argomento `body`): la guardia per firma
    // direbbe «non c'è» e il calcio sparirebbe in silenzio. Per nome, il calcio parte.
    const conn = await costruisci()
    try {
      await conn.exec(`
        CREATE SCHEMA net;
        CREATE TABLE net.chiamate (ordine serial PRIMARY KEY, url text, body jsonb, headers jsonb);
        CREATE FUNCTION net.http_post(url text, headers jsonb DEFAULT '{}'::jsonb, body jsonb DEFAULT '{}'::jsonb, retries integer DEFAULT 0)
        RETURNS bigint LANGUAGE plpgsql AS $$
        BEGIN INSERT INTO net.chiamate(url, body, headers) VALUES (url, body, headers); RETURN 1; END $$;
        CREATE TABLE public.cron_finto (nome text PRIMARY KEY, valore text);
        CREATE FUNCTION public.cron_config(p_nome text) RETURNS text LANGUAGE sql AS $$ SELECT valore FROM public.cron_finto WHERE nome = p_nome $$;
      `)
      await configura(conn, { 'app.push_dispatch_url': 'https://app.esempio.test/api/push/dispatch' })
      const { jobId } = await inCoda('k-firma', conn)
      expect(await rpc(`public.video_runner_kick('${jobId}')`, conn)).toEqual({ ok: true, inviato: true })
      expect((await chiamate(conn)).map((c) => c.url)).toEqual(['https://app.esempio.test/api/video/runner'])
    } finally {
      await conn.close()
    }
  }, 60_000)
})

describe('video_runner_kick · con pg_net', () => {
  let conn: PGlite

  beforeAll(async () => {
    conn = await costruisciConPgNet()
  }, 60_000)

  afterAll(async () => {
    await conn.close()
  })

  beforeEach(async () => {
    await svuota(conn)
    await conn.exec(`TRUNCATE net.chiamate; TRUNCATE public.cron_finto`)
  })

  it('chiama POST /api/video/runner con {job_id}, l’origine ricavata dal Vault e il segreto SOLO nell’intestazione', async () => {
    await configura(conn, {
      'app.push_dispatch_url': 'https://app.esempio.test/api/push/dispatch?x=1',
      'app.cron_secret': 'segreto-di-prova-123',
    })
    const { jobId } = await inCoda('k1', conn)

    expect(await rpc(`public.video_runner_kick('${jobId}')`, conn)).toEqual({ ok: true, inviato: true })

    expect(await chiamate(conn)).toEqual([
      {
        url: 'https://app.esempio.test/api/video/runner',
        body: { job_id: jobId },
        headers: { 'Content-Type': 'application/json', 'x-cron-secret': 'segreto-di-prova-123' },
      },
    ])
    // Il segreto e l'indirizzo non finiscono mai nel log.
    const log = await tuttoIlLog(conn)
    expect(log).not.toContain('segreto-di-prova-123')
    expect(log).not.toContain('esempio.test')
    expect((await contestiLoggati('video-runner-kick', conn)).map((c) => c.code ?? null)).toEqual([null])
  })

  it('cerca l’origine in tre configurazioni, nell’ordine di tick: push, promemoria, retention', async () => {
    const { jobId } = await inCoda('k1', conn)

    await configura(conn, { 'app.retention_iscrizioni_url': 'https://tre.esempio.test/api/retention' })
    await rpc(`public.video_runner_kick('${jobId}')`, conn)
    await configura(conn, { 'app.notifiche_promemoria_url': 'https://due.esempio.test/api/promemoria' })
    await rpc(`public.video_runner_kick('${jobId}')`, conn)
    await configura(conn, { 'app.push_dispatch_url': 'https://uno.esempio.test/api/push' })
    await rpc(`public.video_runner_kick('${jobId}')`, conn)

    expect((await chiamate(conn)).map((c) => c.url)).toEqual([
      'https://tre.esempio.test/api/video/runner',
      'https://due.esempio.test/api/video/runner',
      'https://uno.esempio.test/api/video/runner',
    ])
  })

  it('senza il segreto configurato spedisce un’intestazione VUOTA (non NULL, che pg_net rifiuterebbe)', async () => {
    await configura(conn, { 'app.push_dispatch_url': 'https://app.esempio.test/x' })
    const { jobId } = await inCoda('k1', conn)
    await rpc(`public.video_runner_kick('${jobId}')`, conn)
    expect((await chiamate(conn))[0].headers['x-cron-secret']).toBe('')
  })

  it('senza nessun URL configurato → URL_ASSENTE, una riga di log di livello ERROR, e nessuna chiamata', async () => {
    const { jobId } = await inCoda('k1', conn)
    expect(await rpc(`public.video_runner_kick('${jobId}')`, conn)).toEqual({ ok: false, code: 'URL_ASSENTE' })
    expect(await chiamate(conn)).toEqual([])
    const log = await righe<{ livello: string; code: string }>(`
      SELECT payload -> 0 ->> 'livello' AS livello, payload -> 0 -> 'contesto' ->> 'code' AS code
      FROM public.log_migrazioni WHERE payload -> 0 ->> 'evento' = 'video-runner-kick'
    `, conn)
    // Configurazione mancante = livello error, mai info (AGENTS.md, regola 4).
    expect(log).toEqual([{ livello: 'error', code: 'URL_ASSENTE' }])
  })

  it('un valore che non è un indirizzo (nessuno schema://host) conta come URL assente', async () => {
    await configura(conn, { 'app.push_dispatch_url': 'non-un-indirizzo' })
    const { jobId } = await inCoda('k1', conn)
    expect(await rpc(`public.video_runner_kick('${jobId}')`, conn)).toEqual({ ok: false, code: 'URL_ASSENTE' })
    expect(await chiamate(conn)).toEqual([])
  })

  it('se pg_net rifiuta l’accodamento → POST_FALLITO, riga error, e NESSUNA eccezione (non deve costare un arrivo)', async () => {
    await configura(conn, { 'app.push_dispatch_url': 'https://app.esempio.test/x', 'app.cron_secret': 'segreto-di-prova-123' })
    await conn.exec(`
      CREATE OR REPLACE FUNCTION net.http_post(
        url text, body jsonb DEFAULT '{}'::jsonb, params jsonb DEFAULT '{}'::jsonb,
        headers jsonb DEFAULT '{}'::jsonb, timeout_milliseconds integer DEFAULT 5000
      ) RETURNS bigint LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'pg_net non risponde'; END $$;
    `)
    const { jobId } = await inCoda('k1', conn)
    expect(await rpc(`public.video_runner_kick('${jobId}')`, conn)).toEqual({ ok: false, code: 'POST_FALLITO' })
    expect((await contestiLoggati('video-runner-kick', conn)).map((c) => c.code)).toEqual(['POST_FALLITO'])
    expect(await tuttoIlLog(conn)).not.toContain('segreto-di-prova-123')
  })

  it('anche cron_config che SOLLEVA (il Vault non risponde) non fa sollevare il calcio', async () => {
    await conn.exec(`
      CREATE OR REPLACE FUNCTION public.cron_config(p_nome text) RETURNS text LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'vault irraggiungibile'; END $$;
    `)
    const { jobId } = await inCoda('k1', conn)
    expect(await rpc(`public.video_runner_kick('${jobId}')`, conn)).toEqual({ ok: false, code: 'POST_FALLITO' })
  })

  it('pg_net c’è ma cron_config no → URL_ASSENTE (la configurazione manca, e lo dice)', async () => {
    await conn.exec(`DROP FUNCTION public.cron_config(text)`)
    const { jobId } = await inCoda('k1', conn)
    expect(await rpc(`public.video_runner_kick('${jobId}')`, conn)).toEqual({ ok: false, code: 'URL_ASSENTE' })
  })
})

describe('video_runner_ventaglio · chi ha bisogno di un’invocazione', () => {
  let conn: PGlite

  beforeAll(async () => {
    conn = await costruisciConPgNet()
  }, 60_000)

  afterAll(async () => {
    await conn.close()
  })

  beforeEach(async () => {
    await svuota(conn)
    await conn.exec(`TRUNCATE net.chiamate; TRUNCATE public.cron_finto`)
    await configura(conn, { 'app.push_dispatch_url': 'https://app.esempio.test/x', 'app.cron_secret': 's' })
  })

  const ventaglio = (tetto: number, escludi: string | null = null) =>
    rpc<{ ok: boolean; candidati: number; calciati: number; in_lavorazione: number; liberi: number }>(
      `public.video_runner_ventaglio(${tetto}, ${escludi === null ? 'NULL::uuid' : `'${escludi}'`})`,
      conn,
    )
  const calciati = async () => (await chiamate(conn)).map((c) => c.body.job_id)

  /**
   * Lo scenario: due job vivi (uno sorvegliato, uno no), uno a lease scaduta, tre in coda dovuti in
   * ordine di arrivo, uno in attesa del suo ritentativo e uno di un intento ritirato.
   */
  async function scenario() {
    const sorvegliato = await inLavorazione('vivo-sorvegliato', conn)
    const nonSorvegliato = await inLavorazione('vivo-libero', conn)
    await conn.exec(`UPDATE public.video_jobs SET sorvegliato_da = '${INV_1}', sorvegliato_fino_a = clock_timestamp() + interval '4 minutes' WHERE id = '${sorvegliato.jobId}'`)
    const scaduto = await inLavorazione('scaduto', conn)
    await scadiLease(scaduto.jobId, conn)
    const c1 = await inCoda('coda-1', conn, 50)
    const c2 = await inCoda('coda-2', conn, 40)
    const c3 = await inCoda('coda-3', conn, 30)
    const inAttesa = await inCoda('in-attesa', conn, 60)
    await conn.exec(`UPDATE public.video_jobs SET next_attempt_at = clock_timestamp() + interval '10 minutes' WHERE id = '${inAttesa.jobId}'`)
    const ritirato = await inCoda('ritirato', conn, 70)
    await rpc(`public.video_intent_revoke('${ritirato.intentId}', '${OWNER}', 1)`, conn)
    // `scaduto` va dopo i job in coda nell'ordine di arrivo? No: il suo created_at è il più recente, quindi
    // nella coda dei «posti nuovi» viene DOPO c1, c2 e c3. Si anticipa perché sia il primo.
    await conn.exec(`UPDATE public.video_jobs SET created_at = created_at - interval '90 minutes' WHERE id = '${scaduto.jobId}'`)
    return { sorvegliato, nonSorvegliato, scaduto, c1, c2, c3, inAttesa, ritirato }
  }

  it('calcia i job vivi NON sorvegliati (senza posto) e, fino ai posti liberi, i nuovi nell’ordine di arrivo', async () => {
    const s = await scenario()
    // Tetto 3: due vivi → UN posto libero. Prima i vivi non sorvegliati, poi UN posto nuovo, al più vecchio:
    // il job a lease scaduta (che vuole un posto nuovo anche lui).
    const r = await ventaglio(3)
    expect(r).toEqual({ ok: true, candidati: 2, calciati: 2, in_lavorazione: 2, liberi: 1 })
    expect(await calciati()).toEqual([s.nonSorvegliato.jobId, s.scaduto.jobId])
  })

  it('con più posti liberi calcia più job nuovi, mai quelli in attesa del ritentativo né di un intento ritirato', async () => {
    const s = await scenario()
    const r = await ventaglio(5) // due vivi → tre posti liberi
    expect(r).toMatchObject({ ok: true, in_lavorazione: 2, liberi: 3 })
    expect(await calciati()).toEqual([s.nonSorvegliato.jobId, s.scaduto.jobId, s.c1.jobId, s.c2.jobId])
    const tutti = new Set(await calciati())
    for (const escluso of [s.sorvegliato, s.inAttesa, s.ritirato]) expect(tutti.has(escluso.jobId)).toBe(false)
  })

  it('p_escludi toglie quel job dal ventaglio (lo sorveglia chi chiama)', async () => {
    const s = await scenario()
    await ventaglio(5, s.nonSorvegliato.jobId)
    expect(await calciati()).toEqual([s.scaduto.jobId, s.c1.jobId, s.c2.jobId])
    await conn.exec('TRUNCATE net.chiamate')
    await ventaglio(5, s.c1.jobId)
    expect(await calciati()).toEqual([s.nonSorvegliato.jobId, s.scaduto.jobId, s.c2.jobId, s.c3.jobId])
  })

  it('a capacità piena non calcia nessun job NUOVO, ma i vivi non sorvegliati sì (riagganciano un Sandbox acceso)', async () => {
    const s = await scenario()
    const r = await ventaglio(2) // due vivi → zero posti liberi
    expect(r).toEqual({ ok: true, candidati: 1, calciati: 1, in_lavorazione: 2, liberi: 0 })
    expect(await calciati()).toEqual([s.nonSorvegliato.jobId])
  })

  it('i job a lease scaduta NON contano come vivi: liberano il posto', async () => {
    const a = await inLavorazione('a', conn)
    await scadiLease(a.jobId, conn)
    const r = await ventaglio(1)
    expect(r).toMatchObject({ in_lavorazione: 0, liberi: 1 })
    expect(await calciati()).toEqual([a.jobId])
  })

  it('una coda vuota non calcia niente e lo dice (candidati 0)', async () => {
    expect(await ventaglio(3)).toEqual({ ok: true, candidati: 0, calciati: 0, in_lavorazione: 0, liberi: 3 })
    expect(await calciati()).toEqual([])
  })

  it('il successo si logga SEMPRE, anche a zero (altrimenti «niente da fare» e «non gira più» si somigliano)', async () => {
    await ventaglio(3)
    expect(await contestiLoggati('video-runner-ventaglio', conn)).toEqual([
      { candidati: 0, calciati: 0, in_lavorazione: 0, liberi: 3 },
    ])
  })

  it('rifiuta un tetto nullo o fuori misura', async () => {
    expect(await rpc(`public.video_runner_ventaglio(NULL, NULL)`, conn)).toEqual({ ok: false, code: 'BAD_INPUT' })
    expect(await ventaglio(0)).toEqual({ ok: false, code: 'BAD_INPUT' })
    expect(await ventaglio(51)).toEqual({ ok: false, code: 'BAD_INPUT' })
  })

  it('senza pg_net NON solleva: conta i candidati e non ne calcia nessuno', async () => {
    // Il database condiviso non ha né pg_net né cron_config: è quello della CI.
    const a = await inLavorazione('senza-net-a')
    await inCoda('senza-net-b')
    expect(await rpc(`public.video_runner_ventaglio(3, NULL)`)).toEqual({
      ok: true, candidati: 2, calciati: 0, in_lavorazione: 1, liberi: 2,
    })
    expect(a.jobId).toBeTruthy()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 9 · IL TESTO DEL FILE A — ciò che da una connessione sola non si vede, e le dichiarazioni della testata
// ─────────────────────────────────────────────────────────────────────────────

/** Da `CREATE OR REPLACE FUNCTION public.<nome>(` al `$$;` che ne chiude il corpo. */
function corpoDi(sql: string, nome: string): string {
  const da = sql.search(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${nome}\\(`))
  if (da < 0) throw new Error(`non trovo la funzione ${nome}`)
  const apre = sql.indexOf('$$', da)
  const chiude = sql.indexOf('$$', apre + 2)
  return sql.slice(apre + 2, chiude)
}

/** Da `CREATE OR REPLACE FUNCTION public.<nome>(` al `GRANT EXECUTE … TO service_role;` che la chiude. */
function funzioneCompleta(sql: string, nome: string, firma: string): string {
  const forma = new RegExp(
    `CREATE OR REPLACE FUNCTION public\\.${nome}\\([\\s\\S]*?\\nGRANT EXECUTE ON FUNCTION public\\.${nome}\\(${firma}\\)\\n  TO service_role;`,
  )
  const trovata = forma.exec(sql)
  if (!trovata) throw new Error(`non trovo la funzione ${nome}(${firma}) in quel file`)
  return trovata[0]
}

const occorrenze = (testo: string, pezzo: string): number => testo.split(pezzo).length - 1

describe('il testo del file A', () => {
  it('la testata dichiara la firma ESATTA di ogni funzione nuova: stessi nomi e stessi tipi degli argomenti', async () => {
    // T5, T6 e T7 leggono le firme da lì: una testata che dicesse `p_tag` dove il codice ha `p_tag_alunni`
    // farebbe passare i loro test e fallire la produzione. Si confronta con il catalogo, non a occhio.
    const testata = MIGRAZIONE_A.split('\n')
      .filter((r) => r.startsWith('--'))
      .map((r) => r.replace(/^--\s?/, ''))
      .join('\n')
      .replace(/\btimestamptz\b/g, 'timestamp with time zone')

    for (const { nome } of FUNZIONI_NUOVE) {
      const dichiarata = new RegExp(`\\b${nome}\\(\\s*((?:p_[a-z0-9_]+ [a-z\\[\\] ]+,?\\s*)+)\\)`).exec(testata)
      expect(dichiarata, `la testata non dichiara la firma di ${nome}`).not.toBeNull()
      const attesa = dichiarata![1].replace(/\s+/g, ' ').trim().replace(/,$/, '')

      const { reale } = await unaRiga<{ reale: string }>(`
        SELECT pg_get_function_identity_arguments(p.oid) AS reale
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = '${nome}'
      `)
      expect(attesa, `la firma di ${nome} nella testata diverge da quella della funzione`).toBe(reale)
    }
  })

  it('video_job_ready differisce dall’originale SOLO per le tre modifiche dichiarate, byte per byte (commenti esclusi)', () => {
    const originale = funzioneCompleta(TRANSIZIONI, 'video_job_ready', 'uuid, bigint, uuid, text, bigint, jsonb')
    const nuova = funzioneCompleta(MIGRAZIONE_A, 'video_job_ready', 'uuid, bigint, uuid, text, bigint, jsonb')

    // Il controllo positivo dell'estrattore: se non trovasse il corpo vero il confronto qui sotto sarebbe
    // fra due stringhe corte e verde per costruzione.
    expect(soloCodice(originale)).toContain('v_duration > 180')
    expect(soloCodice(originale).length).toBeGreaterThan(3000)

    const M1_NUOVA = 'v_duration > 300'
    const M1_VECCHIA = 'v_duration > 180'
    const M2 =
      "      output_delete_after = CASE WHEN v_intent.channel = 'news' THEN v_now + interval '7 days' ELSE output_delete_after END,\n"
    const M3 = [
      "  IF v_intent.pubblicazione_automatica AND v_intent.status = 'confirmed' THEN",
      '    BEGIN',
      '      INSERT INTO public.video_outbox(intent_id, revision, event_type, payload)',
      '      VALUES (',
      "        v_intent.id, v_intent.revision, 'gallery.auto_publish',",
      "        pg_catalog.jsonb_build_object('intent_id', v_intent.id, 'job_id', p_job_id)",
      '      );',
      '    EXCEPTION WHEN unique_violation THEN',
      '      PERFORM public._video_job_transition_log(',
      "        'video-job-ready', 'info', p_job_id, v_intent.id, 'OUTBOX_ALREADY_QUEUED'",
      '      );',
      '    END;',
      '  END IF;',
    ].join('\n') + '\n\n'

    const codice = soloCodice(nuova)
    expect(occorrenze(codice, M1_NUOVA), 'il tetto a 300 deve esserci, una volta sola').toBe(1)
    expect(occorrenze(codice, M2), 'la scadenza dell’uscita deve esserci, una volta sola').toBe(1)
    expect(occorrenze(codice, M3), 'l’accodamento dell’evento deve esserci, una volta sola').toBe(1)

    // Tolte le tre modifiche, il corpo è IDENTICO all'originale, byte per byte.
    const ripristinato = codice.replace(M1_NUOVA, M1_VECCHIA).replace(M2, '').replace(M3, '')
    expect(ripristinato).toBe(soloCodice(originale))
  })

  it('#23 — il file A NON ridefinisce video_job_retry né le altre transizioni dei job: a tentativi esauriti scrive già last_error_code', () => {
    const codice = soloCodice(MIGRAZIONE_A)
    for (const nome of ['retry', 'claim', 'next', 'fail', 'cancel', 'heartbeat', 'uploaded']) {
      expect(codice, `video_job_${nome} non va riscritta qui`).not.toMatch(
        new RegExp(`CREATE\\s+(OR\\s+REPLACE\\s+)?FUNCTION\\s+public\\.video_job_${nome}\\s*\\(`),
      )
    }
    // L'unica funzione già esistente che si sostituisce è video_job_ready.
    const sostituite = [...codice.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)\(/g)].map((m) => m[1])
    const nuove = new Set(FUNZIONI_NUOVE.map((f) => f.nome))
    expect(sostituite.filter((n) => !nuove.has(n))).toEqual(['video_job_ready'])
  })

  it('video_job_prendi e video_job_prossimo: lock di capacità PRIMA del conteggio, conteggio PRIMA della delega, delega UNA volta', () => {
    for (const [nome, delegato] of [
      ['video_job_prendi', 'public.video_job_claim('],
      ['video_job_prossimo', 'public.video_job_next('],
    ] as const) {
      const corpo = soloCodice(corpoDi(MIGRAZIONE_A, nome))
      const lock = corpo.indexOf('pg_advisory_xact_lock')
      const conteggio = corpo.indexOf('count(*)')
      const delega = corpo.indexOf(delegato)
      expect(lock, `${nome} non prende il lock di capacità`).toBeGreaterThan(-1)
      expect(conteggio, `${nome} non conta i job vivi`).toBeGreaterThan(lock)
      expect(delega, `${nome} non delega`).toBeGreaterThan(conteggio)
      expect(occorrenze(corpo, delegato), `${nome} deve delegare una volta sola`).toBe(1)
      // Lo stesso lock in entrambe: due funzioni con due chiavi diverse non si escluderebbero a vicenda.
      expect(corpo).toContain("hashtext('video_conversioni_capacita')")
    }
  })

  it('l’ordine dei lock è INTENTO → JOB in ogni funzione che li prende entrambi', () => {
    // `[^;]` attraversa gli a capo: la clausola finisce al `;` dell'istruzione, non alla riga.
    const intento = /FROM\s+public\.video_intents\b[^;]*?FOR UPDATE/
    const job = /FROM\s+public\.video_jobs\b[^;]*?FOR UPDATE/
    let verificate = 0
    for (const { nome } of FUNZIONI_NUOVE) {
      const corpo = soloCodice(corpoDi(MIGRAZIONE_A, nome))
      const i = intento.exec(corpo)
      const j = job.exec(corpo)
      if (!i || !j) continue
      verificate += 1
      expect(i.index, `${nome} blocca il job PRIMA dell'intento: un deadlock che si vede solo sotto carico`).toBeLessThan(j.index)
    }
    // Quattro funzioni prendono entrambi i lock (apri, rinnovo, pubblica, riprova): se lo scanner ne vedesse
    // meno, il confronto qui sopra starebbe guardando il vuoto.
    expect(verificate).toBeGreaterThanOrEqual(4)
  })

  it('clock_timestamp() si prende DOPO i lock (di riga o di capacità), mai prima', () => {
    let verificate = 0
    for (const { nome } of FUNZIONI_NUOVE) {
      const corpo = soloCodice(corpoDi(MIGRAZIONE_A, nome))
      const orologio = corpo.indexOf('v_now := pg_catalog.clock_timestamp()')
      // L'ultimo lock di riga (`FOR UPDATE`) oppure, per le funzioni di capacità, il lock di transazione.
      const ultimoLock = Math.max(corpo.lastIndexOf('FOR UPDATE'), corpo.indexOf('pg_advisory_xact_lock'))
      if (ultimoLock < 0 || orologio < 0) continue
      verificate += 1
      expect(orologio, `${nome} legge l'orologio prima di aver preso i lock: una lease nata già consumata`).toBeGreaterThan(ultimoLock)
    }
    // Sette funzioni con i lock di riga (apri, rinnovo, pubblica, esito, fallita, riprova, sorveglianza) più le
    // due di capacità: se lo scanner ne vedesse meno, il confronto starebbe guardando il vuoto.
    expect(verificate).toBeGreaterThanOrEqual(9)
  })

  it('nessuna chiamata di log nomina un campo vietato (bambini, hash, percorsi, segreti)', () => {
    const codice = soloCodice(MIGRAZIONE_A)
    const chiamate = [...codice.matchAll(/_video_job_transition_log\(/g)].map((m) => {
      // Dalla parentesi aperta alla sua chiusa bilanciata.
      let livello = 0
      for (let i = m.index! + m[0].length - 1; i < codice.length; i++) {
        if (codice[i] === '(') livello += 1
        if (codice[i] === ')') {
          livello -= 1
          if (livello === 0) return codice.slice(m.index!, i + 1)
        }
      }
      return ''
    })
    expect(chiamate.length, 'lo scanner non trova le chiamate di log').toBeGreaterThan(80)
    // Si guardano i VALORI che finirebbero nel log, non i nomi: un letterale (`'campo', 'tag_alunni'` dice QUALE
    // campo era sbagliato) e un conteggio (`cardinality(v_tag)`, `octet_length(p_diagnosi::text)`) non portano
    // niente di personale, e vanno tolti prima di cercare i riferimenti vietati.
    const valori = (c: string) =>
      c
        .replace(/'[^']*'/g, "''")
        .replace(/pg_catalog\.(cardinality|octet_length)\([^()]*\)/g, 'N')
    const vietato = /\b(tag_alunni|p_tag_alunni|p_tag_effettivi|v_tag|p_token_hash|p_hash|rinnovo_token_hash|p_file_url|file_url|p_original_path|original_path|p_sha256|v_secret|cron_secret|p_diagnosi|v_base|v_origine)\b/
    expect(chiamate.filter((c) => vietato.test(valori(c)))).toEqual([])

    // Il controllo positivo: lo stesso filtro SEGNALA un log che nomina davvero un valore vietato.
    const sbagliata = "_video_job_transition_log('x', 'info', NULL, NULL, NULL, pg_catalog.jsonb_build_object('t', v_intent.tag_alunni))"
    expect(vietato.test(valori(sbagliata))).toBe(true)
    const innocua = "_video_job_transition_log('x', 'info', NULL, NULL, NULL, pg_catalog.jsonb_build_object('campo', 'tag_alunni', 'n', pg_catalog.cardinality(v_tag)))"
    expect(vietato.test(valori(innocua))).toBe(false)
  })

  it('nessun console, nessun segreto e nessun uuid di sede nel file (il repository è pubblico)', () => {
    const codice = soloCodice(MIGRAZIONE_A)
    expect(codice).not.toMatch(/console\./)
    expect(codice).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 10 · RIAPPLICAZIONE, DATI ESISTENTI, RETROCOMPATIBILITÀ
// ─────────────────────────────────────────────────────────────────────────────

/** Una fotografia del catalogo delle tre tabelle video e di tutte le funzioni `video_*`. */
async function fotografia(conn: PGlite): Promise<Record<string, unknown[]>> {
  return {
    funzioni: await righe(`
      SELECT p.proname, pg_get_functiondef(p.oid) AS def, p.proacl::text AS acl, p.prosecdef, p.proconfig::text AS config
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname LIKE 'video\\_%' ORDER BY p.proname, p.oid
    `, conn),
    // L'OID del vincolo c'è di proposito: se un vincolo fosse stato tolto e ricreato avrebbe un OID nuovo.
    vincoli: await righe(`
      SELECT conrelid::regclass::text AS tabella, conname, oid::int AS oid, pg_get_constraintdef(oid) AS def
      FROM pg_constraint WHERE conrelid IN ('public.video_intents'::regclass, 'public.video_jobs'::regclass, 'public.video_outbox'::regclass)
      ORDER BY conrelid::regclass::text, conname
    `, conn),
    indici: await righe(`
      SELECT tablename, indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename IN ('video_intents', 'video_jobs', 'video_outbox') ORDER BY indexname
    `, conn),
    colonne: await righe(`
      SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name IN ('video_intents', 'video_jobs', 'video_outbox')
      ORDER BY table_name, ordinal_position
    `, conn),
  }
}

describe('applicazione ripetuta e dati esistenti', () => {
  it('applicata DUE volte di fila (anche tre) non cambia niente: funzioni, vincoli (stessi OID), indici, colonne, dati', async () => {
    const conn = await costruisci()
    try {
      // Dei dati che il file ha già toccato: un intento aperto, pronto, pubblicato.
      const { intentId, jobId } = await intentoPronto({ tag: [A1, A2] }, conn)
      await pubblica(intentId, [A1], {}, conn)
      const datiPrima = {
        intenti: await righe(`SELECT * FROM public.video_intents ORDER BY id`, conn),
        job: await righe(`SELECT * FROM public.video_jobs ORDER BY id`, conn),
        media: await conta('public.galleria_media_v2', conn),
        outbox: await conta('public.video_outbox', conn),
      }
      const prima = await fotografia(conn)
      expect((prima.vincoli as Array<{ conname: string }>).some((v) => v.conname === 'video_jobs_probe_chk')).toBe(true)

      await conn.exec(MIGRAZIONE_A)
      await conn.exec(MIGRAZIONE_A)

      expect(await fotografia(conn)).toEqual(prima)
      expect({
        intenti: await righe(`SELECT * FROM public.video_intents ORDER BY id`, conn),
        job: await righe(`SELECT * FROM public.video_jobs ORDER BY id`, conn),
        media: await conta('public.galleria_media_v2', conn),
        outbox: await conta('public.video_outbox', conn),
      }).toEqual(datiPrima)
      expect(jobId).toBeTruthy()
      // Il solo segno delle riapplicazioni è il log di successo: uno per applicazione (la prima + due).
      expect((await contestiLoggati('video-pubblicazione-automatica-migration', conn))).toHaveLength(3)
    } finally {
      await conn.close()
    }
  }, 60_000)

  it('su un database con le righe della produzione (PR 1 applicata): sopravvivono con i default, e la durata passa a 300', async () => {
    const conn = await costruisci({ conA: false })
    try {
      // Il flusso VECCHIO, com'era in produzione: una News pronta con 179 secondi (sotto il vecchio tetto) e un
      // intento di galleria pubblicato attraverso `video_intent_finalize` (come faceva la route).
      const news = await apriNews('vecchia-news', conn)
      await rpc(`public.video_job_uploaded('${news.jobId}', '${OWNER}', 5000, 'video/mp4')`, conn)
      await rpc(`public.video_job_claim('${news.jobId}', '${LEASE_A}', 300)`, conn)
      await rpc(`public.video_job_ready('${news.jobId}', 1, '${LEASE_A}', 'outputs/${news.jobId}/f.mp4', 900, '{"durationSeconds":179}'::jsonb)`, conn)
      expect(
        await rpc(`public.video_job_ready('${news.jobId}', 1, '${LEASE_A}', 'outputs/${news.jobId}/g.mp4', 900, '{"durationSeconds":250}'::jsonb)`, conn),
        'prima del file A il tetto era 180',
      ).toEqual({ ok: false, code: 'BAD_INPUT' })

      const gallery = await rpc<RispostaApri>(
        `public.video_intent_open('${OWNER}', '${SEDE}', 'gallery', 'publish', '{"scope":"sede"}'::jsonb, 'g-vecchia', '${OWNER}/g-vecchia.mp4', NULL, NULL)`,
        conn,
      )
      await rpc(`public.video_job_uploaded('${gallery.job!.id}', '${OWNER}', 5000, 'video/mp4')`, conn)
      await rpc(`public.video_job_claim('${gallery.job!.id}', '${LEASE_A}', 300)`, conn)
      await rpc(`public.video_job_ready('${gallery.job!.id}', 1, '${LEASE_A}', 'outputs/${gallery.job!.id}/f.mp4', 900, '{"durationSeconds":120}'::jsonb)`, conn)
      await rpc(`public.video_intent_confirm('${gallery.intent!.id}', '${OWNER}', 1)`, conn)
      const media = '70000000-0000-4000-8000-000000000007'
      expect(
        await rpc(`public.video_intent_finalize('${gallery.intent!.id}', '${OWNER}', 1, '${SEDE}', 'gallery', '${media}', 'gallery.published', '{"media_id": "${media}"}'::jsonb)`, conn),
      ).toMatchObject({ ok: true })

      const prima = {
        intenti: await conta('public.video_intents', conn),
        job: await conta('public.video_jobs', conn),
        outbox: await conta('public.video_outbox', conn),
      }
      await conn.exec(MIGRAZIONE_A)
      expect({
        intenti: await conta('public.video_intents', conn),
        job: await conta('public.video_jobs', conn),
        outbox: await conta('public.video_outbox', conn),
      }).toEqual(prima)

      // Le righe vecchie hanno i default che le lasciano com'erano: non automatiche, senza bambini, tus.
      expect(
        await righe(`
          SELECT pubblicazione_automatica, tag_alunni, broadcast, classi_destinatarie, n_tag, trasporto,
                 esito_notificato, esito_notificato_il, pubblicazione_errore, minimizzato_il
          FROM public.video_intents
        `, conn),
      ).toEqual([
        { pubblicazione_automatica: false, tag_alunni: [], broadcast: false, classi_destinatarie: null, n_tag: 0, trasporto: 'tus', esito_notificato: null, esito_notificato_il: null, pubblicazione_errore: null, minimizzato_il: null },
        { pubblicazione_automatica: false, tag_alunni: [], broadcast: false, classi_destinatarie: null, n_tag: 0, trasporto: 'tus', esito_notificato: null, esito_notificato_il: null, pubblicazione_errore: null, minimizzato_il: null },
      ])
      expect(
        await righe(`
          SELECT count(*) FILTER (WHERE byte_dichiarati IS NOT NULL OR mime_dichiarato IS NOT NULL OR durata_dichiarata_s IS NOT NULL
                                   OR sha256_dichiarato IS NOT NULL OR rinnovo_token_hash IS NOT NULL OR output_delete_after IS NOT NULL
                                   OR output_deleted_at IS NOT NULL OR sorvegliato_da IS NOT NULL OR diagnosi_verifica IS NOT NULL
                                   OR arrivato_il IS NOT NULL OR sorgente_etag IS NOT NULL)::int AS con_valori
          FROM public.video_jobs
        `, conn),
      ).toEqual([{ con_valori: 0 }])

      // Il vincolo di durata ora è a 300: la durata che prima veniva rifiutata passa.
      await conn.exec(`UPDATE public.video_jobs SET probe_json = '{"durationSeconds":250}' WHERE id = '${news.jobId}'`)
    } finally {
      await conn.close()
    }
  }, 60_000)

  it('RETROCOMPATIBILE: dopo il file A il flusso vecchio funziona com’è (apre, converte, pubblica con finalize) e non accoda eventi nuovi', async () => {
    const conn = await costruisci()
    try {
      const vecchio = await rpc<RispostaApri>(
        `public.video_intent_open('${OWNER}', '${SEDE}', 'gallery', 'publish', '{"scope":"sede"}'::jsonb, 'g-vecchia', '${OWNER}/g-vecchia.mp4', NULL, NULL)`,
        conn,
      )
      expect(vecchio.ok).toBe(true)
      await portaAPronto(vecchio.job!.id, { conn })
      await rpc(`public.video_intent_confirm('${vecchio.intent!.id}', '${OWNER}', 1)`, conn)
      const media = '70000000-0000-4000-8000-000000000007'
      expect(
        await rpc(`public.video_intent_finalize('${vecchio.intent!.id}', '${OWNER}', 1, '${SEDE}', 'gallery', '${media}', 'gallery.published', '{}'::jsonb)`, conn),
      ).toMatchObject({ ok: true, intent: { status: 'published', pubblicazione_automatica: false } })
      // Un solo evento: quello di finalize. L'automatico non parte per il flusso vecchio.
      expect((await righe<{ event_type: string }>(`SELECT event_type FROM public.video_outbox`, conn)).map((e) => e.event_type)).toEqual(['gallery.published'])
    } finally {
      await conn.close()
    }
  }, 60_000)

  it('#23 — a tentativi esauriti video_job_retry scrive last_error_code (con il file A applicato: la REPLACE non serve)', async () => {
    const { jobId } = await inLavorazione('r23')
    const CODICE_PRIMA = 'BUILD_DOWNLOAD_FAILED'
    const CODICE_ULTIMO = 'SANDBOX_UNAVAILABLE'
    // Tre ritentativi con un codice, poi il quarto — l'ultimo — con un altro: `last_error_code` deve essere
    // quello dell'ULTIMO tentativo, non quello del ritentativo precedente.
    for (let n = 1; n <= 3; n++) {
      expect(
        await rpc(`public.video_job_retry('${jobId}', ${n}, '${LEASE_A}', '${CODICE_PRIMA}', 4, 300)`),
      ).toMatchObject({ ok: true, job: { status: 'queued', last_error_code: CODICE_PRIMA } })
      await db.exec(`UPDATE public.video_jobs SET next_attempt_at = clock_timestamp() - interval '1 second' WHERE id = '${jobId}'`)
      expect(await rpc(`public.video_job_claim('${jobId}', '${LEASE_A}', 300)`)).toMatchObject({ ok: true, job: { attempt: n + 1 } })
    }
    expect(
      await rpc(`public.video_job_retry('${jobId}', 4, '${LEASE_A}', '${CODICE_ULTIMO}', 4, 300)`),
    ).toMatchObject({ ok: true, job: { status: 'failed', error_code: CODICE_ULTIMO, last_error_code: CODICE_ULTIMO, attempt: 4 } })
    expect(
      (await unaRiga<{ l: string; e: string }>(`SELECT last_error_code AS l, error_code AS e FROM public.video_jobs WHERE id = '${jobId}'`)),
    ).toEqual({ l: CODICE_ULTIMO, e: CODICE_ULTIMO })
  })
})
