// @vitest-environment node

/**
 * LA CONSERVAZIONE DELLE USCITE — il file C della PR 2, provato sul file di migrazione VERO.
 *
 * Stesso impianto di `video-pubblicazione-automatica-rpc.test.ts`: PGlite, i ruoli di Supabase
 * ricostruiti a mano, e le migrazioni lette **dal disco**, nell'ordine in cui la produzione le
 * applica — le sette già applicate (PR 1 compresa), il file A, e il file C. Un test che ripete l'SQL
 * dentro di sé prova la propria copia, e resta verde il giorno in cui le due divergono.
 *
 * ─── COME SI TROVANO LE MIGRAZIONI DI QUESTA PR ───────────────────────────────────────────
 *
 * Per SUFFISSO del nome, non per nome intero: i file nascono con un timestamp provvisorio e T16 li
 * rinomina con l'istante vero. Un test che ne conoscesse il nome intero si romperebbe proprio in
 * quel momento.
 *
 * ─── COSA QUESTO FILE PROVA ───────────────────────────────────────────────────────────────
 *
 *  · la RETE DELLE USCITE di `video_retention_scadenze` (e che le tre reti di prima non sono cambiate);
 *  · il TIMBRO `video_retention_uscita_rimossa`, con i suoi rifiuti;
 *  · la scadenza dei convertiti non pubblicati, la revoca del flusso vecchio, la minimizzazione dei
 *    bambini, l'oblio di un alunno e la riconciliazione, tutte a due livelli: l'effetto sulle righe
 *    e il testo della migrazione (ordine dei lock, nessuna `DELETE`, nessun bambino nel log);
 *  · l'overload di `video_outbox_claim` col filtro per tipo, e che quello a tre argomenti non è cambiato;
 *  · il diff dei corpi sostituiti con la definizione più recente: SOLO le modifiche dichiarate;
 *  · il secondario #33 del file A (il vincolo di durata non torna indietro);
 *  · l'applicazione ripetuta e il database con le righe della produzione.
 *
 * ─── COSA QUESTO FILE **NON** DIMOSTRA, detto qui e non in fondo ──────────────────────────
 *
 * PGlite è a CONNESSIONE SINGOLA: due transazioni davvero simultanee qui non si possono avere. Che
 * due giri della purga non si pestino i piedi (SKIP LOCKED), che l'oblio di due alunni insieme non si
 * blocchi (ordine di id), o che la revoca e la pubblicazione di uno stesso intento si serializzino,
 * richiede due transazioni in volo. Si prova ciò che da una connessione sola si vede — la seconda
 * chiamata DOPO la prima trova lo stato nuovo — e la disciplina che regge il resto si verifica sul
 * TESTO della migrazione, con mutazioni viste rosse.
 *
 * L'OROLOGIO si muove con degli UPDATE sulle colonne, mai con uno `sleep`.
 */

import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { toccaLaRls, toccaLeFkUtenti, toccaUnUnico } from '../architecture/soglia-fotografia'

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

// Le migrazioni già in produzione, nell'ordine di applicazione.
const SCHEMA = leggi('20260916190000_video_jobs.sql')
const TRANSIZIONI = leggi('20260916190100_video_job_transitions.sql')
const INTENTI = leggi('20260916190200_video_intent_lifecycle.sql')
const NEXT = leggi('20260917210000_video_job_next.sql')
const RETENTION = leggi('20260918110000_video_retention_riconciliazione.sql')
const BUCKET = leggi(trovaPerSuffisso('_video_build_bucket.sql'))
const RITENTATIVI = leggi(trovaPerSuffisso('_video_job_ritentativi.sql'))
// Quelle di questa PR: il file A e il file C.
const FILE_C = trovaPerSuffisso('_video_conservazione_uscite.sql')
const MIGRAZIONE_A = leggi(trovaPerSuffisso('_video_pubblicazione_automatica.sql'))
const MIGRAZIONE_C = leggi(FILE_C)

const SEDE = '10000000-0000-4000-8000-000000000001'
const OWNER = '20000000-0000-4000-8000-000000000002'
const ALTRO_OWNER = '21000000-0000-4000-8000-000000000002'
const A1 = 'a1000000-0000-4000-8000-0000000000a1'
const A2 = 'a2000000-0000-4000-8000-0000000000a2'
const A3 = 'a3000000-0000-4000-8000-0000000000a3'
const A4 = 'a4000000-0000-4000-8000-0000000000a4'
const LEASE_A = '50000000-0000-4000-8000-000000000005'
const INESISTENTE = '99999999-9999-4999-8999-999999999999'

/** L'ACL che le funzioni video hanno in produzione: solo il proprietario e il service role. */
const ACL_FUNZIONI_VIDEO = '{postgres=X/postgres,service_role=X/postgres}'

/** Le funzioni NUOVE del file C, ciascuna con la firma dei suoi argomenti (per i privilegi e la testata). */
const FUNZIONI_NUOVE: ReadonlyArray<{ nome: string; firma: string }> = [
  { nome: 'video_retention_uscita_rimossa', firma: 'uuid' },
  { nome: 'video_intent_scadi_non_pubblicato', firma: 'integer, integer' },
  { nome: 'video_galleria_flusso_vecchio_revoca', firma: 'integer' },
  { nome: 'video_intenti_minimizza', firma: 'integer, integer' },
  { nome: 'video_intent_oblio_alunno', firma: 'uuid' },
  { nome: 'video_outbox_claim', firma: 'uuid, integer, integer, text[]' },
]

/** Le due funzioni SOSTITUITE (stessa firma) e quella a tre argomenti che NON cambia. */
const FUNZIONI_SOSTITUITE: ReadonlyArray<{ nome: string; firma: string }> = [
  { nome: 'video_retention_scadenze', firma: 'integer, integer, integer' },
  { nome: 'video_riconciliazione', firma: 'integer, integer, integer' },
]

type Riga = Record<string, unknown>
type Risposta = {
  ok: boolean
  code?: string
  [chiave: string]: unknown
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
const uuids = (xs: string[]): string =>
  xs.length === 0 ? `'{}'::uuid[]` : `ARRAY[${xs.map((x) => `'${x}'`).join(', ')}]::uuid[]`

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

    INSERT INTO public.schools(id) VALUES ('${SEDE}');
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

/** Un database completo: lo stub, la produzione, e (di default) il file A e il file C. */
async function costruisci(opzioni: { conA?: boolean; conC?: boolean } = {}): Promise<PGlite> {
  const conn = new PGlite()
  await preparaStub(conn)
  await applicaProduzione(conn)
  if (opzioni.conA ?? true) await conn.exec(MIGRAZIONE_A)
  if (opzioni.conC ?? true) await conn.exec(MIGRAZIONE_C)
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

type StatoIntento = 'pending' | 'confirmed' | 'action_required' | 'published' | 'cancelled' | 'superseded'
type StatoJob = 'awaiting_upload' | 'queued' | 'ready' | 'failed' | 'rejected' | 'cancelled'

type OpzioniSeme = {
  canale?: 'gallery' | 'news'
  stato?: StatoIntento
  automatico?: boolean
  tag?: string[]
  /** `n_tag` se diverso dal numero dei tag (dopo la minimizzazione resta il numero scelto). */
  nTag?: number
  broadcast?: boolean
  owner?: string
  /** Da quanti giorni l'intento non cambia: `updated_at`, e `revoked_at` / `published_at` se ci sono. */
  giorni?: number
  /** Il job dell'intento. Senza, l'intento non ne ha. */
  job?: {
    stato: StatoJob
    /** Ha un file convertito in `video_processing`. Per `ready` c'è sempre. */
    uscita?: boolean
    scadenzaUscita?: 'nessuna' | 'passata' | 'futura'
    /** L'uscita è già stata tolta e timbrata (`output_deleted_at`): richiede una scadenza. */
    uscitaTolta?: boolean
    /** Solo per `ready`: da quanti giorni è verificato. Di default come l'intento. */
    verificatoGiorniFa?: number
    /** `failed`, `rejected` e `cancelled` hanno di solito la scadenza dell'originale. */
    originaleSenzaScadenza?: boolean
  }
}

/**
 * Una riga di intento (e di job) scritta DIRETTAMENTE, rispettando i vincoli: per le prove che
 * guardano l'effetto di una funzione su uno stato, non il modo in cui ci si arriva (quello lo provano
 * i test delle RPC di transizione). Gli id sono casuali: nessun test ne dipende.
 */
async function semina(
  opz: OpzioniSeme = {},
  conn: PGlite = db,
): Promise<{ intentId: string; jobId: string | null }> {
  const canale = opz.canale ?? 'gallery'
  const stato = opz.stato ?? 'confirmed'
  const automatico = opz.automatico ?? false
  const tag = opz.tag ?? []
  const giorni = opz.giorni ?? 0
  const intentId = randomUUID()

  const confermato = ['confirmed', 'action_required', 'published'].includes(stato)
  const revocato = ['cancelled', 'superseded'].includes(stato)
  const pubblicato = stato === 'published'
  const fa = (g: number) => `now() - interval '${g} days'`

  await conn.exec(`
    INSERT INTO public.video_intents (
      id, owner_id, scuola_id, channel, requested_action, payload, status,
      confirmed_at, revoked_at, published_at, created_at, updated_at,
      pubblicazione_automatica, tag_alunni, broadcast, n_tag
    ) VALUES (
      '${intentId}', '${opz.owner ?? OWNER}', '${SEDE}', '${canale}', 'publish', '{"scope":"sede"}', '${stato}',
      ${confermato ? `${fa(giorni + 1)} + interval '1 minute'` : 'NULL'},
      ${revocato ? fa(giorni) : 'NULL'},
      ${pubblicato ? fa(giorni) : 'NULL'},
      ${fa(giorni + 1)}, ${fa(giorni)},
      ${automatico}, ${uuids(tag)}, ${opz.broadcast ?? false}, ${opz.nTag ?? tag.length}
    )
  `)

  if (!opz.job) return { intentId, jobId: null }

  const j = opz.job
  const jobId = randomUUID()
  const pronto = j.stato === 'ready'
  const conUscita = pronto || (j.uscita ?? false)
  const fallito = j.stato === 'failed' || j.stato === 'rejected'
  const conSorgente = j.stato !== 'awaiting_upload'
  const scadenza = j.scadenzaUscita ?? 'nessuna'
  const tolta = j.uscitaTolta ?? false
  const verificato = pronto ? fa(j.verificatoGiorniFa ?? giorni) : null
  const scadenzaOriginale = pronto
    ? `${verificato} + interval '7 days'`
    : ['failed', 'rejected', 'cancelled'].includes(j.stato) && !j.originaleSenzaScadenza
      ? `now() + interval '7 days'`
      : 'NULL'
  const scadenzaUscitaSql = tolta
    ? `now() - interval '1 hour'`
    : scadenza === 'passata'
      ? `now() - interval '1 hour'`
      : scadenza === 'futura'
        ? `now() + interval '3 days'`
        : 'NULL'

  await conn.exec(`
    INSERT INTO public.video_jobs (
      id, owner_id, scuola_id, channel, idempotency_key, intent_id, status,
      original_path, source_size, source_mime,
      output_bucket, output_path, output_size, probe_json,
      error_code, verified_at, original_delete_after, output_delete_after, output_deleted_at,
      created_at, updated_at
    ) VALUES (
      '${jobId}', '${opz.owner ?? OWNER}', '${SEDE}', '${canale}', 'k-${jobId}', '${intentId}', '${j.stato}',
      'originals/${jobId}/source', ${conSorgente ? 5000 : 'NULL'}, ${conSorgente ? `'video/mp4'` : 'NULL'},
      ${conUscita ? `'video_processing'` : 'NULL'}, ${conUscita ? `'outputs/${jobId}/final.mp4'` : 'NULL'},
      ${conUscita ? 900 : 'NULL'}, ${pronto ? `'{"durationSeconds":20}'::jsonb` : 'NULL'},
      ${fallito ? `'X'` : 'NULL'}, ${verificato ?? 'NULL'}, ${scadenzaOriginale},
      ${conUscita ? scadenzaUscitaSql : 'NULL'}, ${conUscita && tolta ? `now() - interval '30 minutes'` : 'NULL'},
      ${fa(giorni + 1)}, ${fa(giorni)}
    )
  `)
  return { intentId, jobId }
}

type StatoIntentoRiga = {
  status: string
  tag_alunni: string[]
  n_tag: number
  minimizzato_il: string | null
  revoked_at: string | null
  updated_at: string
}
const intento = (id: string, conn: PGlite = db) =>
  unaRiga<StatoIntentoRiga>(
    `SELECT status, tag_alunni, n_tag, minimizzato_il::text, revoked_at::text, updated_at::text
     FROM public.video_intents WHERE id = '${id}'`,
    conn,
  )

type StatoJobRiga = {
  status: string
  fence_epoch: number
  error_code: string | null
  output_delete_after: string | null
  output_deleted_at: string | null
  original_delete_after: string | null
  updated_at: string
}
const job = (id: string, conn: PGlite = db) =>
  unaRiga<StatoJobRiga>(
    `SELECT status, fence_epoch::int AS fence_epoch, error_code, output_delete_after::text,
            output_deleted_at::text, original_delete_after::text, updated_at::text
     FROM public.video_jobs WHERE id = '${id}'`,
    conn,
  )

/** Vero se la colonna di quella riga (tabella, id) è «adesso», entro due minuti da qualunque parte. */
async function vicinoAdesso(
  tabella: 'video_jobs' | 'video_intents',
  colonna: string,
  id: string,
  conn: PGlite = db,
): Promise<boolean> {
  const { v } = await unaRiga<{ v: boolean | null }>(
    `SELECT abs(extract(epoch FROM (${colonna} - clock_timestamp()))) < 120 AS v
     FROM public.${tabella} WHERE id = '${id}'`,
    conn,
  )
  return v === true
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

/** I livelli loggati dall'evento indicato, con il codice se c'è. */
async function livelliLoggati(
  evento: string,
  conn: PGlite = db,
): Promise<Array<{ livello: string; code: string | null }>> {
  return righe<{ livello: string; code: string | null }>(
    `SELECT payload -> 0 ->> 'livello' AS livello, payload -> 0 -> 'contesto' ->> 'code' AS code
     FROM public.log_migrazioni WHERE payload -> 0 ->> 'evento' = '${evento}' ORDER BY ctid`,
    conn,
  )
}

/** Tutto ciò che è stato loggato, come un testo solo: per cercarci dentro ciò che NON deve esserci. */
async function tuttoIlLog(conn: PGlite = db): Promise<string> {
  const { rows } = await conn.query<{ t: string }>(
    `SELECT coalesce(string_agg(payload::text, ' '), '') AS t FROM public.log_migrazioni`,
  )
  return rows[0].t
}

/** Da `CREATE OR REPLACE FUNCTION public.<nome>(` al `$$` che chiude il corpo. */
function corpoDi(sql: string, nome: string, firma = ''): string {
  const da = sql.search(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${nome}\\(${firma}`))
  if (da < 0) throw new Error(`non trovo la funzione ${nome}`)
  const apre = sql.indexOf('$$', da)
  const chiude = sql.indexOf('$$', apre + 2)
  return sql.slice(apre + 2, chiude)
}

const occorrenze = (testo: string, pezzo: string): number => testo.split(pezzo).length - 1

// Il database condiviso: si costruisce UNA volta per tutto il file e si svuota prima di ogni prova. Le
// prove che cambiano lo schema, o che vogliono ripartire da un database diverso, ne costruiscono uno loro.
beforeAll(async () => {
  db = await costruisci()
}, 60_000)

afterAll(async () => {
  await db.close()
})

beforeEach(async () => {
  await svuota()
})

// ─────────────────────────────────────────────────────────────────────────────
// 1 · I PRIVILEGI, e che il database si costruisce
// ─────────────────────────────────────────────────────────────────────────────

describe('il file C · funzioni e privilegi', () => {
  it('le sei funzioni nuove e le due sostituite sono SECURITY DEFINER, a search_path chiuso, del solo service role', async () => {
    const tutte = [...FUNZIONI_NUOVE, ...FUNZIONI_SOSTITUITE]
    for (const { nome, firma } of tutte) {
      const f = await unaRiga<{ definer: boolean; config: string[]; acl: string }>(`
        SELECT p.prosecdef AS definer, p.proconfig AS config, p.proacl::text AS acl
        FROM pg_proc p
        WHERE p.oid = 'public.${nome}(${firma})'::regprocedure
      `)
      expect(f.definer, `${nome} non è SECURITY DEFINER`).toBe(true)
      expect(f.config, `${nome} non chiude il search_path`).toContain('search_path=pg_catalog')
      expect(f.acl, `${nome} ha un'ACL diversa da quella delle altre funzioni video`).toBe(ACL_FUNZIONI_VIDEO)
      const permessi = await unaRiga<{ servizio: boolean; anonimo: boolean; autenticato: boolean }>(`
        SELECT has_function_privilege('service_role', 'public.${nome}(${firma})', 'EXECUTE') AS servizio,
               has_function_privilege('anon', 'public.${nome}(${firma})', 'EXECUTE') AS anonimo,
               has_function_privilege('authenticated', 'public.${nome}(${firma})', 'EXECUTE') AS autenticato
      `)
      expect(permessi, nome).toEqual({ servizio: true, anonimo: false, autenticato: false })
    }
  })

  it('un client anonimo o autenticato che PROVA a chiamarle prende «permission denied», funzione per funzione', async () => {
    const chiamate: Record<string, string> = {
      video_retention_uscita_rimossa: `NULL::uuid`,
      video_intent_scadi_non_pubblicato: `NULL::integer, NULL::integer`,
      video_galleria_flusso_vecchio_revoca: `NULL::integer`,
      video_intenti_minimizza: `NULL::integer, NULL::integer`,
      video_intent_oblio_alunno: `NULL::uuid`,
      video_outbox_claim: `NULL::uuid, NULL::integer, NULL::integer, NULL::text[]`,
      video_retention_scadenze: `NULL::integer, NULL::integer, NULL::integer`,
      video_riconciliazione: `NULL::integer, NULL::integer, NULL::integer`,
    }
    for (const ruolo of ['anon', 'authenticated']) {
      for (const { nome } of [...FUNZIONI_NUOVE, ...FUNZIONI_SOSTITUITE]) {
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

  it('video_outbox_claim ha DUE firme (tre e quattro argomenti) e quella a tre è com’era, con la sua ACL', async () => {
    const firme = await righe<{ args: string }>(`
      SELECT pg_get_function_identity_arguments(p.oid) AS args
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'video_outbox_claim' ORDER BY 1
    `)
    expect(firme.map((f) => f.args)).toEqual([
      'p_lease_owner uuid, p_lease_seconds integer, p_limite integer',
      'p_lease_owner uuid, p_lease_seconds integer, p_limite integer, p_tipi text[]',
    ])
    const acl = await unaRiga<{ acl: string }>(
      `SELECT proacl::text AS acl FROM pg_proc WHERE oid = 'public.video_outbox_claim(uuid, integer, integer)'::regprocedure`,
    )
    expect(acl.acl).toBe(ACL_FUNZIONI_VIDEO)
    // Nessun DEFAULT sul nuovo argomento: con un default una chiamata a tre argomenti combacerebbe con
    // entrambe le firme e PostgREST risponderebbe PGRST203 (funzione ambigua), anche al codice vecchio.
    const conDefault = await unaRiga<{ n: number }>(`
      SELECT p.pronargdefaults::int AS n FROM pg_proc p
      WHERE p.oid = 'public.video_outbox_claim(uuid, integer, integer, text[])'::regprocedure
    `)
    expect(conDefault.n, 'l’overload non deve avere argomenti con DEFAULT').toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2 · video_retention_scadenze — la rete delle USCITE
// ─────────────────────────────────────────────────────────────────────────────

describe('video_retention_scadenze · la rete delle uscite', () => {
  const giro = (limite = 100) => rpc(`public.video_retention_scadenze(48, 168, ${limite})`)

  it('dà la scadenza all’uscita di un job concluso (failed, rejected, cancelled) e di un intento pubblicato', async () => {
    const fallito = await semina({ canale: 'news', job: { stato: 'failed', uscita: true } })
    const respinto = await semina({ canale: 'news', job: { stato: 'rejected', uscita: true } })
    const annullato = await semina({ canale: 'news', stato: 'cancelled', job: { stato: 'cancelled', uscita: true } })
    // Il flusso VECCHIO: pubblicato col finalize, l'uscita non ha mai avuto una data.
    const pubblicato = await semina({ stato: 'published', job: { stato: 'ready', scadenzaUscita: 'nessuna' } })

    const esito = await giro()
    expect(esito).toMatchObject({ ok: true, uscite_senza_scadenza: 4, abbandonati: 0, incagliati: 0, senza_scadenza: 0 })

    for (const { jobId } of [fallito, respinto, annullato, pubblicato]) {
      const j = await job(jobId!)
      expect(j.output_delete_after, `il job ${jobId} non ha ricevuto la scadenza`).not.toBeNull()
      expect(await vicinoAdesso('video_jobs', 'output_delete_after', jobId!)).toBe(true)
      expect(j.output_deleted_at, 'la rete non timbra niente: lo fa la rimozione').toBeNull()
    }
  })

  it('NON tocca lo stato di nessuno: stato, fence, errore e scadenza dell’originale restano com’erano', async () => {
    const f = await semina({ canale: 'news', job: { stato: 'failed', uscita: true } })
    const p = await semina({ stato: 'published', job: { stato: 'ready' } })
    const prima = { f: await job(f.jobId!), p: await job(p.jobId!) }

    await giro()

    for (const [k, id] of [['f', f.jobId!], ['p', p.jobId!]] as const) {
      const dopo = await job(id)
      expect(dopo.status).toBe(prima[k].status)
      expect(dopo.fence_epoch).toBe(prima[k].fence_epoch)
      expect(dopo.error_code).toBe(prima[k].error_code)
      expect(dopo.original_delete_after).toBe(prima[k].original_delete_after)
    }
  })

  it('NON tocca un job `ready` il cui intento non è pubblicato: l’uscita serve ancora alla pubblicazione', async () => {
    const confermato = await semina({ stato: 'confirmed', automatico: true, tag: [A1], job: { stato: 'ready' } })
    const inAttesa = await semina({ stato: 'action_required', automatico: true, tag: [A1], job: { stato: 'ready' } })
    const esito = await giro()
    expect(esito).toMatchObject({ uscite_senza_scadenza: 0 })
    expect((await job(confermato.jobId!)).output_delete_after).toBeNull()
    expect((await job(inAttesa.jobId!)).output_delete_after).toBeNull()
  })

  it('non sposta una scadenza già presa (passata o futura), non guarda le uscite già tolte né i job senza uscita', async () => {
    const passata = await semina({ canale: 'news', job: { stato: 'failed', uscita: true, scadenzaUscita: 'passata' } })
    const futura = await semina({ canale: 'news', job: { stato: 'failed', uscita: true, scadenzaUscita: 'futura' } })
    const tolta = await semina({ canale: 'news', job: { stato: 'failed', uscita: true, uscitaTolta: true } })
    const senzaUscita = await semina({ canale: 'news', job: { stato: 'failed', uscita: false } })
    const prima = await Promise.all([passata, futura, tolta, senzaUscita].map((x) => job(x.jobId!)))

    const esito = await giro()
    expect(esito).toMatchObject({ ok: true, uscite_senza_scadenza: 0 })

    const dopo = await Promise.all([passata, futura, tolta, senzaUscita].map((x) => job(x.jobId!)))
    expect(dopo).toEqual(prima)
    expect(dopo[3].output_delete_after, 'senza uscita la colonna resta vuota').toBeNull()
  })

  it('è idempotente: il secondo giro non trova niente e non sposta le date', async () => {
    const a = await semina({ canale: 'news', job: { stato: 'failed', uscita: true } })
    expect(await giro()).toMatchObject({ uscite_senza_scadenza: 1 })
    const dopoPrimo = await job(a.jobId!)
    expect(await giro()).toMatchObject({ ok: true, uscite_senza_scadenza: 0 })
    expect(await job(a.jobId!)).toEqual(dopoPrimo)
  })

  it('rispetta il tetto del lotto: con limite 2 e cinque candidati ne prende due alla volta', async () => {
    for (let i = 0; i < 5; i++) await semina({ canale: 'news', job: { stato: 'failed', uscita: true } })
    expect(await giro(2)).toMatchObject({ uscite_senza_scadenza: 2 })
    expect(await giro(2)).toMatchObject({ uscite_senza_scadenza: 2 })
    expect(await giro(2)).toMatchObject({ uscite_senza_scadenza: 1 })
    expect(await giro(2)).toMatchObject({ uscite_senza_scadenza: 0 })
  })

  it('il numero esce nel log (sempre, anche a zero) e un giro che pesca le uscite NON è un errore', async () => {
    await semina({ canale: 'news', job: { stato: 'failed', uscita: true } })
    await giro()
    const [contesto] = await contestiLoggati('video-retention-scadenze')
    expect(contesto).toMatchObject({ uscite_senza_scadenza: 1 })
    expect((await livelliLoggati('video-retention-scadenze')).map((l) => l.livello)).toEqual(['info'])

    // A zero il log c'è lo stesso: «niente da fare» e «la funzione non gira più» non devono somigliarsi.
    await svuota()
    await giro()
    expect(await livelliLoggati('video-retention-scadenze')).toHaveLength(1)
  })

  it('i passi (a) e (b) concludono job che non hanno un’uscita (la colonna resta vuota); se uno ce l’ha, la rete (d) la data subito dopo, nello stesso giro', async () => {
    // Un upload abbandonato e una coda incagliata portano a `failed` un job che non è mai arrivato a `ready`:
    // `output_path` lo scrive solo `video_job_ready`, quindi di norma un'uscita non c'è e nessuna data si scrive.
    const incagliatoSenzaUscita = await semina({ canale: 'news', job: { stato: 'queued', uscita: false }, giorni: 10 })
    const abbandonato = await semina({ canale: 'news', job: { stato: 'awaiting_upload', uscita: false }, giorni: 5 })
    // Un job in coda, fermo da dieci giorni, che — contro le regole — ha già un'uscita scritta: il passo (b) lo
    // dichiara fallito e il passo (d), nello STESSO giro, vede un concluso con un'uscita e senza data.
    const incagliatoConUscita = await semina({ canale: 'news', job: { stato: 'queued', uscita: true }, giorni: 10 })

    const esito = await giro()
    expect(esito).toMatchObject({ ok: true, abbandonati: 1, incagliati: 2, uscite_senza_scadenza: 1 })

    expect((await job(incagliatoSenzaUscita.jobId!)).output_delete_after, 'senza uscita la colonna non si inventa').toBeNull()
    expect((await job(abbandonato.jobId!)).output_delete_after).toBeNull()
    expect((await job(abbandonato.jobId!)).error_code).toBe('UPLOAD_ABBANDONATO')
    const a = await job(incagliatoConUscita.jobId!)
    expect(a.status).toBe('failed')
    expect(a.error_code).toBe('CONVERSIONE_INCAGLIATA')
    expect(await vicinoAdesso('video_jobs', 'output_delete_after', incagliatoConUscita.jobId!)).toBe(true)
  })

  it('le tre reti di prima non sono cambiate: abbandonati, incagliati, il worker vivo e la rete degli originali', async () => {
    const abbandonato = await semina({ canale: 'news', job: { stato: 'awaiting_upload' }, giorni: 5 })
    const giovane = await semina({ canale: 'news', job: { stato: 'awaiting_upload' }, giorni: 0 })
    const incagliato = await semina({ canale: 'news', job: { stato: 'queued' }, giorni: 10 })
    const vivo = await semina({ canale: 'news', job: { stato: 'queued' }, giorni: 10 })
    await db.exec(`
      UPDATE public.video_jobs
      SET status = 'processing', lease_owner = '${LEASE_A}', lease_expires_at = now() + interval '10 minutes'
      WHERE id = '${vivo.jobId}'
    `)
    const concluso = await semina({ canale: 'news', job: { stato: 'failed', originaleSenzaScadenza: true } })

    const esito = await giro()
    expect(esito).toMatchObject({ ok: true, abbandonati: 1, incagliati: 1, senza_scadenza: 1 })

    expect((await job(abbandonato.jobId!)).status).toBe('failed')
    expect((await job(abbandonato.jobId!)).fence_epoch).toBe(1)
    expect((await job(giovane.jobId!)).status).toBe('awaiting_upload')
    expect((await job(incagliato.jobId!)).error_code).toBe('CONVERSIONE_INCAGLIATA')
    expect((await job(vivo.jobId!)).status, 'il worker vivo non è incagliato').toBe('processing')
    expect((await job(concluso.jobId!)).original_delete_after).not.toBeNull()
    // E il livello del log di prima: la rete degli originali che pesca è un errore, quella delle uscite no.
    expect((await livelliLoggati('video-retention-scadenze')).map((l) => l.livello)).toEqual(['error'])
  })

  it('rifiuta gli argomenti impossibili, come prima', async () => {
    for (const args of ['NULL, 168, 100', '0, 168, 100', '48, 168, 0', '48, 168, 100000']) {
      expect(await rpc(`public.video_retention_scadenze(${args})`), args).toEqual({ ok: false, code: 'BAD_INPUT' })
    }
  })

  it('il corpo non prende MAI il lock dell’intento: la rete delle uscite lo legge soltanto, e blocca i job con SKIP LOCKED', () => {
    const corpo = soloCodice(corpoDi(MIGRAZIONE_C, 'video_retention_scadenze'))
    expect(corpo).not.toMatch(/FOR UPDATE[^;]*\bvideo_intents\b/)
    expect(corpo).not.toMatch(/FOR UPDATE OF i\b/)
    expect(occorrenze(corpo, 'FOR UPDATE OF j SKIP LOCKED')).toBe(1)
    expect(occorrenze(corpo, 'FOR UPDATE SKIP LOCKED')).toBe(3)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3 · video_retention_uscita_rimossa — il timbro dopo la rimozione
// ─────────────────────────────────────────────────────────────────────────────

describe('video_retention_uscita_rimossa', () => {
  const timbra = (id: string) => rpc(`public.video_retention_uscita_rimossa('${id}')`)

  it('timbra l’uscita solo quando la scadenza è passata, e il timbro non precede la scadenza', async () => {
    const { jobId } = await semina({ canale: 'news', job: { stato: 'failed', uscita: true, scadenzaUscita: 'passata' } })
    const prima = await job(jobId!)
    expect(prima.output_deleted_at).toBeNull()

    expect(await timbra(jobId!)).toEqual({ ok: true })

    const dopo = await job(jobId!)
    expect(dopo.output_deleted_at).not.toBeNull()
    const { ordine } = await unaRiga<{ ordine: boolean }>(
      `SELECT output_deleted_at >= output_delete_after AS ordine FROM public.video_jobs WHERE id = '${jobId}'`,
    )
    expect(ordine, 'il timbro non può precedere la scadenza: lo vieta anche il vincolo del file A').toBe(true)
    // L'indice parziale delle uscite non la vede più: il lavoro è finito, non ripetuto.
    expect(
      await conta(`public.video_jobs WHERE output_deleted_at IS NULL AND output_delete_after IS NOT NULL`),
    ).toBe(0)
  })

  it('non cambia lo stato né l’originale: scrive solo il timbro dell’uscita (e updated_at)', async () => {
    const { jobId } = await semina({ canale: 'news', job: { stato: 'failed', uscita: true, scadenzaUscita: 'passata' } })
    const prima = await job(jobId!)
    await timbra(jobId!)
    const dopo = await job(jobId!)
    expect(dopo.status).toBe(prima.status)
    expect(dopo.fence_epoch).toBe(prima.fence_epoch)
    expect(dopo.error_code).toBe(prima.error_code)
    expect(dopo.original_delete_after).toBe(prima.original_delete_after)
    expect(dopo.output_delete_after).toBe(prima.output_delete_after)
    expect((await unaRiga<{ n: string | null }>(`SELECT original_deleted_at::text AS n FROM public.video_jobs WHERE id = '${jobId}'`)).n).toBeNull()
  })

  it('è idempotente: il secondo timbro risponde «già fatto» e non sposta niente', async () => {
    const { jobId } = await semina({ canale: 'news', job: { stato: 'failed', uscita: true, scadenzaUscita: 'passata' } })
    await timbra(jobId!)
    const primo = await job(jobId!)
    expect(await timbra(jobId!)).toEqual({ ok: true, idempotente: true })
    expect(await job(jobId!)).toEqual(primo)
  })

  it('rifiuta di timbrare un’uscita la cui scadenza NON è ancora arrivata (NON_ANCORA_SCADUTO)', async () => {
    const { jobId } = await semina({ canale: 'news', job: { stato: 'failed', uscita: true, scadenzaUscita: 'futura' } })
    expect(await timbra(jobId!)).toEqual({ ok: false, code: 'NON_ANCORA_SCADUTO' })
    expect((await job(jobId!)).output_deleted_at).toBeNull()
  })

  it('una riga SENZA scadenza non si timbra: prima le si dà una data, poi la si cancella (SENZA_SCADENZA)', async () => {
    const { jobId } = await semina({ stato: 'confirmed', automatico: true, tag: [A1], job: { stato: 'ready' } })
    expect(await timbra(jobId!)).toEqual({ ok: false, code: 'SENZA_SCADENZA' })
    expect((await job(jobId!)).output_deleted_at).toBeNull()
  })

  it('un job che non esiste e un argomento nullo non passano in silenzio', async () => {
    expect(await rpc(`public.video_retention_uscita_rimossa(NULL)`)).toEqual({ ok: false, code: 'BAD_INPUT' })
    expect(await timbra(INESISTENTE)).toEqual({ ok: false, code: 'NOT_FOUND' })
  })

  it('la scadenza si rilegge SOTTO LOCK: il lock del job viene prima dell’orologio, e dell’intento non se ne prende', () => {
    const corpo = soloCodice(corpoDi(MIGRAZIONE_C, 'video_retention_uscita_rimossa'))
    const lock = corpo.indexOf('FOR UPDATE')
    const orologio = corpo.indexOf('v_now := pg_catalog.clock_timestamp()')
    const confronto = corpo.indexOf('v_job.output_delete_after > v_now')
    expect(lock).toBeGreaterThan(-1)
    expect(orologio).toBeGreaterThan(lock)
    expect(confronto).toBeGreaterThan(orologio)
    expect(corpo).not.toMatch(/video_intents/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4 · video_intent_scadi_non_pubblicato — un convertito non pubblicato si tiene sette giorni
// ─────────────────────────────────────────────────────────────────────────────

describe('video_intent_scadi_non_pubblicato', () => {
  const scadi = (giorni = 7, limite = 100, conn: PGlite = db) =>
    rpc(`public.video_intent_scadi_non_pubblicato(${giorni}, ${limite})`, conn)

  it('revoca un intento confermato con il job pronto da otto giorni: intento e job annullati, fence alzato, uscita e originale con la scadenza', async () => {
    const { intentId, jobId } = await semina({
      stato: 'confirmed', automatico: true, tag: [A1, A2], job: { stato: 'ready', verificatoGiorniFa: 8 }, giorni: 8,
    })
    expect((await job(jobId!)).output_delete_after).toBeNull()

    expect(await scadi()).toEqual({ ok: true, scaduti: 1, rifiutati: 0 })

    const i = await intento(intentId)
    expect(i.status).toBe('cancelled')
    expect(i.revoked_at).not.toBeNull()
    const j = await job(jobId!)
    expect(j.status).toBe('cancelled')
    expect(j.fence_epoch, 'un worker che stesse ancora lavorando non può più chiudere il job').toBe(1)
    expect(await vicinoAdesso('video_jobs', 'output_delete_after', jobId!)).toBe(true)
    // `video_intent_revoke` ha già fissato la scadenza dell'originale: era `verified_at + 7 giorni`, nel passato.
    const { passato } = await unaRiga<{ passato: boolean }>(
      `SELECT original_delete_after <= clock_timestamp() AS passato FROM public.video_jobs WHERE id = '${jobId}'`,
    )
    expect(passato).toBe(true)
    // E la revoca ha accodato il suo evento.
    expect(
      (await righe<{ event_type: string }>(`SELECT event_type FROM public.video_outbox WHERE intent_id = '${intentId}'`)).map((e) => e.event_type),
    ).toEqual(['intent.revoked'])
  })

  it('anche un intento con la pubblicazione fallita (action_required) scade, e il suo originale e la sua uscita vanno con lui', async () => {
    const { intentId, jobId } = await semina({
      stato: 'action_required', automatico: true, tag: [A1], job: { stato: 'ready', verificatoGiorniFa: 9 }, giorni: 9,
    })
    expect(await scadi()).toMatchObject({ scaduti: 1 })
    expect((await intento(intentId)).status).toBe('cancelled')
    expect(await vicinoAdesso('video_jobs', 'output_delete_after', jobId!)).toBe(true)
  })

  it('il confine: sei giorni e 23 ore NO, sette giorni e un’ora SÌ; con 3 giorni scade anche uno di quattro', async () => {
    const quasi = await semina({ stato: 'confirmed', automatico: true, tag: [A1], job: { stato: 'ready', verificatoGiorniFa: 6 }, giorni: 6 })
    await db.exec(`
      UPDATE public.video_jobs
      SET verified_at = now() - interval '6 days 23 hours', original_delete_after = now() - interval '6 days 23 hours' + interval '7 days'
      WHERE id = '${quasi.jobId}'
    `)
    const giusto = await semina({ stato: 'confirmed', automatico: true, tag: [A1], job: { stato: 'ready', verificatoGiorniFa: 7 }, giorni: 7 })
    await db.exec(`
      UPDATE public.video_jobs
      SET verified_at = now() - interval '7 days 1 hour', original_delete_after = now() - interval '7 days 1 hour' + interval '7 days'
      WHERE id = '${giusto.jobId}'
    `)
    expect(await scadi(7)).toMatchObject({ scaduti: 1 })
    expect((await intento(quasi.intentId)).status).toBe('confirmed')
    expect((await intento(giusto.intentId)).status).toBe('cancelled')

    const quattro = await semina({ stato: 'confirmed', automatico: true, tag: [A1], job: { stato: 'ready', verificatoGiorniFa: 4 }, giorni: 4 })
    expect(await scadi(7)).toMatchObject({ scaduti: 0 })
    expect(await scadi(3)).toMatchObject({ scaduti: 2 })
    expect((await intento(quattro.intentId)).status).toBe('cancelled')
    expect((await intento(quasi.intentId)).status, 'con 3 giorni scade anche quello di sei giorni e 23 ore').toBe('cancelled')
  })

  it('non tocca ciò che non è un convertito non pubblicato: pubblicato, annullato, job non pronto, News, già ritirato', async () => {
    const pubblicato = await semina({ stato: 'published', automatico: true, job: { stato: 'ready', verificatoGiorniFa: 20 }, giorni: 20 })
    const annullato = await semina({ stato: 'cancelled', automatico: true, job: { stato: 'cancelled', uscita: true }, giorni: 20 })
    const fallito = await semina({ stato: 'confirmed', automatico: true, tag: [A1], job: { stato: 'failed', uscita: true }, giorni: 20 })
    const inCoda = await semina({ stato: 'confirmed', automatico: true, tag: [A1], job: { stato: 'queued' }, giorni: 20 })
    const senzaJob = await semina({ stato: 'confirmed', automatico: true, tag: [A1], giorni: 20 })
    // Una News: stessa età, job pronto, intento confermato. Il canale è nel filtro.
    const news = await semina({ canale: 'news', stato: 'confirmed', job: { stato: 'ready', verificatoGiorniFa: 20 }, giorni: 20 })

    const prima = await Promise.all(
      [pubblicato, annullato, fallito, inCoda, senzaJob, news].map(async (x) => ({
        i: await intento(x.intentId),
        j: x.jobId ? await job(x.jobId) : null,
      })),
    )
    expect(await scadi()).toEqual({ ok: true, scaduti: 0, rifiutati: 0 })
    const dopo = await Promise.all(
      [pubblicato, annullato, fallito, inCoda, senzaJob, news].map(async (x) => ({
        i: await intento(x.intentId),
        j: x.jobId ? await job(x.jobId) : null,
      })),
    )
    expect(dopo).toEqual(prima)
  })

  it('un’uscita già tolta non si tocca, e la revoca non esplode sul vincolo della scadenza', async () => {
    const { jobId, intentId } = await semina({
      stato: 'confirmed', automatico: true, tag: [A1],
      job: { stato: 'ready', verificatoGiorniFa: 9, scadenzaUscita: 'passata', uscitaTolta: true }, giorni: 9,
    })
    const prima = await job(jobId!)
    expect(await scadi()).toMatchObject({ ok: true, scaduti: 1 })
    expect((await intento(intentId)).status).toBe('cancelled')
    const dopo = await job(jobId!)
    expect(dopo.output_delete_after).toBe(prima.output_delete_after)
    expect(dopo.output_deleted_at).toBe(prima.output_deleted_at)
  })

  it('non sposta in avanti una scadenza dell’uscita già presa nel passato, e porta a «adesso» una nel futuro', async () => {
    const passata = await semina({
      stato: 'confirmed', automatico: true, tag: [A1], job: { stato: 'ready', verificatoGiorniFa: 9, scadenzaUscita: 'passata' }, giorni: 9,
    })
    const futura = await semina({
      stato: 'confirmed', automatico: true, tag: [A1], job: { stato: 'ready', verificatoGiorniFa: 9, scadenzaUscita: 'futura' }, giorni: 9,
    })
    const dataPassata = (await job(passata.jobId!)).output_delete_after
    await scadi()
    expect((await job(passata.jobId!)).output_delete_after, 'LEAST: la data passata resta').toBe(dataPassata)
    expect(await vicinoAdesso('video_jobs', 'output_delete_after', futura.jobId!), 'una data futura diventa adesso').toBe(true)
  })

  it('rispetta il tetto del lotto e il secondo giro non trova più niente', async () => {
    for (let i = 0; i < 3; i++) {
      await semina({ stato: 'confirmed', automatico: true, tag: [A1], job: { stato: 'ready', verificatoGiorniFa: 9 }, giorni: 9 })
    }
    expect(await scadi(7, 2)).toMatchObject({ scaduti: 2 })
    expect(await scadi(7, 2)).toMatchObject({ scaduti: 1 })
    expect(await scadi(7, 2)).toMatchObject({ scaduti: 0 })
  })

  it('il successo si logga sempre, anche a zero, con numeri e senza nomi', async () => {
    await scadi()
    expect(await contestiLoggati('video-intent-scadi-non-pubblicato')).toEqual([{ giorni: 7, scaduti: 0, rifiutati: 0 }])
  })

  it('rifiuta argomenti nulli o fuori misura', async () => {
    for (const args of ['NULL, 100', '7, NULL', '0, 100', '366, 100', '7, 0', '7, 1001']) {
      expect(await rpc(`public.video_intent_scadi_non_pubblicato(${args})`), args).toEqual({ ok: false, code: 'BAD_INPUT' })
    }
  })

  describe('con una spia al posto di video_intent_revoke (la delega è vera, e un rifiuto non scrive niente)', () => {
    let spia: PGlite

    beforeAll(async () => {
      spia = await costruisci()
      await spia.exec(`
        CREATE TABLE public.chiamate_spia (intento uuid NOT NULL, proprietario uuid NOT NULL, revisione integer NOT NULL);
        CREATE TABLE public.risposta_spia (codice text);
        CREATE OR REPLACE FUNCTION public.video_intent_revoke(p_intent_id uuid, p_owner_id uuid, p_revision integer)
        RETURNS jsonb LANGUAGE plpgsql AS $$
        DECLARE v_codice text;
        BEGIN
          INSERT INTO public.chiamate_spia VALUES (p_intent_id, p_owner_id, p_revision);
          SELECT codice INTO v_codice FROM public.risposta_spia LIMIT 1;
          IF v_codice IS NULL THEN
            RETURN jsonb_build_object('ok', true);
          END IF;
          RETURN jsonb_build_object('ok', false, 'code', v_codice);
        END $$;
      `)
    }, 60_000)

    afterAll(async () => {
      await spia.close()
    })

    beforeEach(async () => {
      await svuota(spia)
      await spia.exec('TRUNCATE public.chiamate_spia; TRUNCATE public.risposta_spia')
    })

    it('chiama la revoca con (intento, proprietario, revisione) e scrive la scadenza solo dopo che ha detto sì', async () => {
      const { intentId, jobId } = await semina(
        { stato: 'confirmed', automatico: true, tag: [A1], owner: ALTRO_OWNER, job: { stato: 'ready', verificatoGiorniFa: 9 }, giorni: 9 },
        spia,
      )
      expect(await scadi(7, 100, spia)).toEqual({ ok: true, scaduti: 1, rifiutati: 0 })
      expect(await righe(`SELECT intento, proprietario, revisione FROM public.chiamate_spia`, spia)).toEqual([
        { intento: intentId, proprietario: ALTRO_OWNER, revisione: 1 },
      ])
      expect(await vicinoAdesso('video_jobs', 'output_delete_after', jobId!, spia)).toBe(true)
      // La funzione NON annulla niente da sé: l'intento e il job sono com'erano (la spia non li tocca).
      expect((await intento(intentId, spia)).status).toBe('confirmed')
      expect((await job(jobId!, spia)).status).toBe('ready')
    })

    it('una revoca rifiutata (es. l’intento si è pubblicato un attimo fa) si conta, si logga col suo codice e non scrive l’uscita', async () => {
      await spia.exec(`INSERT INTO public.risposta_spia VALUES ('INTENT_PUBLISHED')`)
      const { jobId } = await semina(
        { stato: 'confirmed', automatico: true, tag: [A1], job: { stato: 'ready', verificatoGiorniFa: 9 }, giorni: 9 },
        spia,
      )
      expect(await scadi(7, 100, spia)).toEqual({ ok: true, scaduti: 0, rifiutati: 1 })
      expect((await job(jobId!, spia)).output_delete_after).toBeNull()
      expect(await livelliLoggati('video-intent-scadi-non-pubblicato', spia)).toEqual([
        { livello: 'warn', code: 'INTENT_PUBLISHED' },
        { livello: 'info', code: null },
      ])
    })
  })

  it('il testo: il ciclo prende il lock con SKIP LOCKED e chiama la revoca una volta sola; il filtro del canale c’è', () => {
    const corpo = soloCodice(corpoDi(MIGRAZIONE_C, 'video_intent_scadi_non_pubblicato'))
    expect(corpo).toContain('FOR UPDATE OF i SKIP LOCKED')
    expect(occorrenze(corpo, 'public.video_intent_revoke(')).toBe(1)
    expect(corpo).toContain("i.channel = 'gallery'")
    expect(corpo).toMatch(/i\.status IN \('confirmed', 'action_required'\)/)
    // L'orologio della scrittura si prende DOPO la revoca: `updated_at` non torna indietro.
    expect(corpo.indexOf('v_ora := pg_catalog.clock_timestamp()')).toBeGreaterThan(corpo.indexOf('public.video_intent_revoke('))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5 · video_galleria_flusso_vecchio_revoca
// ─────────────────────────────────────────────────────────────────────────────

describe('video_galleria_flusso_vecchio_revoca', () => {
  const revoca = (limite = 100, conn: PGlite = db) => rpc(`public.video_galleria_flusso_vecchio_revoca(${limite})`, conn)

  it('revoca ogni intento di galleria non terminale e non automatico, e dà la scadenza alle loro uscite', async () => {
    const inVolo = await semina({ stato: 'pending', job: { stato: 'awaiting_upload' } })
    const inCoda = await semina({ stato: 'confirmed', job: { stato: 'queued' } })
    const pronto = await semina({ stato: 'confirmed', job: { stato: 'ready', verificatoGiorniFa: 3 }, giorni: 3 })
    const aspetta = await semina({ stato: 'action_required', job: { stato: 'ready' } })

    expect(await revoca()).toEqual({ ok: true, revocati: 4, rifiutati: 0 })

    for (const { intentId, jobId } of [inVolo, inCoda, pronto, aspetta]) {
      expect((await intento(intentId)).status).toBe('cancelled')
      expect((await job(jobId!)).status).toBe('cancelled')
    }
    // Gli «11 convertiti mai pubblicati» di produzione: l'uscita riceve la scadenza adesso, e la purga la toglie.
    expect(await vicinoAdesso('video_jobs', 'output_delete_after', pronto.jobId!)).toBe(true)
    expect(await vicinoAdesso('video_jobs', 'output_delete_after', aspetta.jobId!)).toBe(true)
    // Chi non aveva ancora un'uscita non la riceve.
    expect((await job(inCoda.jobId!)).output_delete_after).toBeNull()
    // Gli originali partono subito: `video_intent_revoke` li ha già fissati a «adesso».
    expect(
      await conta(`public.video_jobs WHERE status = 'cancelled' AND original_delete_after IS NOT NULL`),
    ).toBe(4)
  })

  it('gli intenti vivi con un job GIÀ finito male (le forme che la produzione ha oggi) si revocano, e il job resta com’è', async () => {
    // Misurato in produzione il 02/10 (solo conteggi): quattro intenti `pending` con un job `failed`, quattro
    // `confirmed` con un job `failed` e tre `confirmed` con un job `rejected`. Nessuno li chiuderà mai.
    const pendingFallito = await semina({ stato: 'pending', job: { stato: 'failed' } })
    const confermatoFallito = await semina({ stato: 'confirmed', job: { stato: 'failed' } })
    const confermatoRespinto = await semina({ stato: 'confirmed', job: { stato: 'rejected' } })
    const prima = await Promise.all([pendingFallito, confermatoFallito, confermatoRespinto].map((x) => job(x.jobId!)))

    expect(await revoca()).toEqual({ ok: true, revocati: 3, rifiutati: 0 })

    for (const x of [pendingFallito, confermatoFallito, confermatoRespinto]) {
      expect((await intento(x.intentId)).status).toBe('cancelled')
    }
    // `video_intent_revoke` lascia `failed` e `rejected` dove sono: portano il proprio errore e la propria scadenza.
    const dopo = await Promise.all([pendingFallito, confermatoFallito, confermatoRespinto].map((x) => job(x.jobId!)))
    expect(dopo).toEqual(prima)
    expect(dopo.map((j) => j.status)).toEqual(['failed', 'failed', 'rejected'])
  })

  it('NON tocca il flusso nuovo, né le News, né ciò che è già terminale', async () => {
    const automatico = await semina({ stato: 'confirmed', automatico: true, tag: [A1], job: { stato: 'ready' } })
    // La News con la stessa forma di un intento «vecchio»: pubblicazione_automatica = false, confermata,
    // con il job pronto. Revocarla porterebbe via l'allegato di una notizia viva.
    const news = await semina({ canale: 'news', stato: 'confirmed', job: { stato: 'ready' } })
    const pubblicato = await semina({ stato: 'published', job: { stato: 'ready' } })
    const annullato = await semina({ stato: 'cancelled', job: { stato: 'cancelled', uscita: true } })
    const superato = await semina({ stato: 'superseded', job: { stato: 'ready' } })
    const tutti = [automatico, news, pubblicato, annullato, superato]

    const prima = await Promise.all(tutti.map(async (x) => ({ i: await intento(x.intentId), j: await job(x.jobId!) })))
    expect(await revoca()).toEqual({ ok: true, revocati: 0, rifiutati: 0 })
    expect(await Promise.all(tutti.map(async (x) => ({ i: await intento(x.intentId), j: await job(x.jobId!) })))).toEqual(prima)
  })

  it('è idempotente e rispetta il tetto del lotto', async () => {
    for (let i = 0; i < 3; i++) await semina({ stato: 'confirmed', job: { stato: 'queued' } })
    expect(await revoca(2)).toMatchObject({ revocati: 2 })
    expect(await revoca(2)).toMatchObject({ revocati: 1 })
    expect(await revoca(2)).toEqual({ ok: true, revocati: 0, rifiutati: 0 })
  })

  it('il successo si logga sempre, anche a zero, con numeri', async () => {
    await revoca()
    expect(await contestiLoggati('video-galleria-flusso-vecchio-revoca')).toEqual([{ revocati: 0, rifiutati: 0 }])
  })

  it('rifiuta un tetto nullo o fuori misura', async () => {
    for (const a of ['NULL', '0', '1001']) {
      expect(await rpc(`public.video_galleria_flusso_vecchio_revoca(${a})`), a).toEqual({ ok: false, code: 'BAD_INPUT' })
    }
  })

  it('una revoca rifiutata (spia) si conta e non scrive la scadenza dell’uscita', async () => {
    const spia = await costruisci()
    try {
      await spia.exec(`
        CREATE OR REPLACE FUNCTION public.video_intent_revoke(p_intent_id uuid, p_owner_id uuid, p_revision integer)
        RETURNS jsonb LANGUAGE sql AS $$ SELECT jsonb_build_object('ok', false, 'code', 'ALREADY_SUPERSEDED') $$;
      `)
      const { jobId } = await semina({ stato: 'confirmed', job: { stato: 'ready' } }, spia)
      expect(await revoca(100, spia)).toEqual({ ok: true, revocati: 0, rifiutati: 1 })
      expect((await job(jobId!, spia)).output_delete_after).toBeNull()
      expect((await livelliLoggati('video-galleria-flusso-vecchio-revoca', spia)).map((l) => l.code)).toEqual(['ALREADY_SUPERSEDED', null])
    } finally {
      await spia.close()
    }
  }, 60_000)

  it('il testo: il filtro del canale e quello dell’automatico stanno nella SELECT, il lock è SKIP LOCKED', () => {
    const corpo = soloCodice(corpoDi(MIGRAZIONE_C, 'video_galleria_flusso_vecchio_revoca'))
    expect(corpo).toContain("i.channel = 'gallery'")
    expect(corpo).toContain('NOT i.pubblicazione_automatica')
    expect(corpo).toMatch(/i\.status IN \('pending', 'confirmed', 'action_required'\)/)
    expect(corpo).toContain('FOR UPDATE OF i SKIP LOCKED')
    expect(occorrenze(corpo, 'public.video_intent_revoke(')).toBe(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 6 · video_intenti_minimizza — i bambini non restano sull'intento oltre sette giorni
// ─────────────────────────────────────────────────────────────────────────────

describe('video_intenti_minimizza', () => {
  const minimizza = (giorni = 7, limite = 100) => rpc(`public.video_intenti_minimizza(${giorni}, ${limite})`)

  it('svuota i bambini di un intento annullato da otto giorni, scrive minimizzato_il, conserva n_tag e NON tocca updated_at', async () => {
    const { intentId } = await semina({ stato: 'cancelled', automatico: true, tag: [A1, A2], giorni: 8, job: { stato: 'cancelled' } })
    const prima = await intento(intentId)
    expect(prima.tag_alunni.sort()).toEqual([A1, A2])

    expect(await minimizza()).toEqual({ ok: true, minimizzati: 1 })

    const dopo = await intento(intentId)
    expect(dopo.tag_alunni).toEqual([])
    expect(dopo.n_tag, 'il numero scelto sopravvive: serve all’elenco e agli avvisi').toBe(2)
    expect(dopo.minimizzato_il).not.toBeNull()
    expect(
      (await unaRiga<{ v: boolean }>(`SELECT abs(extract(epoch FROM (minimizzato_il - clock_timestamp()))) < 120 AS v FROM public.video_intents WHERE id = '${intentId}'`)).v,
    ).toBe(true)
    expect(dopo.updated_at, 'l’elenco dell’insegnante ordina per updated_at: non deve riapparire in cima').toBe(prima.updated_at)
    expect(dopo.status).toBe('cancelled')
  })

  it('il confine: sei giorni NO, otto giorni SÌ; con 3 giorni anche quello di sei', async () => {
    const sei = await semina({ stato: 'cancelled', automatico: true, tag: [A1], giorni: 6, job: { stato: 'cancelled' } })
    const otto = await semina({ stato: 'cancelled', automatico: true, tag: [A1], giorni: 8, job: { stato: 'cancelled' } })
    expect(await minimizza(7)).toMatchObject({ minimizzati: 1 })
    expect((await intento(sei.intentId)).tag_alunni).toEqual([A1])
    expect((await intento(otto.intentId)).tag_alunni).toEqual([])
    expect(await minimizza(3)).toMatchObject({ minimizzati: 1 })
    expect((await intento(sei.intentId)).tag_alunni).toEqual([])
  })

  it('«concluso» include il pubblicato (con i bambini rimasti), il superato e l’intento vivo i cui job sono TUTTI finiti male', async () => {
    const pubblicato = await semina({ stato: 'published', automatico: true, tag: [A1], giorni: 9, job: { stato: 'ready' } })
    const superato = await semina({ stato: 'superseded', automatico: true, tag: [A2], giorni: 9, job: { stato: 'cancelled' } })
    // Un caricamento caduto e una conversione fallita non portano mai l'intento a uno stato terminale:
    // restano `confirmed` con un job `failed`. Lasciargli i bambini per sempre è il difetto.
    const caduto = await semina({ stato: 'confirmed', automatico: true, tag: [A3], giorni: 9, job: { stato: 'failed', uscita: true } })
    const respinto = await semina({ stato: 'action_required', automatico: true, tag: [A4], giorni: 9, job: { stato: 'rejected' } })

    expect(await minimizza()).toEqual({ ok: true, minimizzati: 4 })
    for (const x of [pubblicato, superato, caduto, respinto]) {
      expect((await intento(x.intentId)).tag_alunni, x.intentId).toEqual([])
      expect((await intento(x.intentId)).minimizzato_il, x.intentId).not.toBeNull()
    }
    expect((await intento(caduto.intentId)).status, 'lo stato non si tocca').toBe('confirmed')
  })

  it('NON tocca un intento che può ancora pubblicare: job pronto, in coda, in attesa del file, o senza job', async () => {
    const pronto = await semina({ stato: 'confirmed', automatico: true, tag: [A1], giorni: 30, job: { stato: 'ready', verificatoGiorniFa: 30 } })
    const inCoda = await semina({ stato: 'confirmed', automatico: true, tag: [A1], giorni: 30, job: { stato: 'queued' } })
    const aspetta = await semina({ stato: 'confirmed', automatico: true, tag: [A1], giorni: 30, job: { stato: 'awaiting_upload' } })
    const senzaJob = await semina({ stato: 'confirmed', automatico: true, tag: [A1], giorni: 30 })
    const fallitaMaPronto = await semina({ stato: 'action_required', automatico: true, tag: [A1], giorni: 30, job: { stato: 'ready', verificatoGiorniFa: 30 } })
    // E uno recente, concluso da due giorni.
    const recente = await semina({ stato: 'cancelled', automatico: true, tag: [A1], giorni: 2, job: { stato: 'cancelled' } })

    expect(await minimizza()).toEqual({ ok: true, minimizzati: 0 })
    for (const x of [pronto, inCoda, aspetta, senzaJob, fallitaMaPronto, recente]) {
      expect((await intento(x.intentId)).tag_alunni, x.intentId).toEqual([A1])
    }
  })

  it('non tocca un broadcast (nessun bambino) né un intento già minimizzato; il secondo giro non trova niente', async () => {
    const broadcast = await semina({ stato: 'cancelled', automatico: true, broadcast: true, giorni: 9, job: { stato: 'cancelled' } })
    const gia = await semina({ stato: 'published', automatico: true, nTag: 3, giorni: 9, job: { stato: 'ready' } })
    const veri = await semina({ stato: 'cancelled', automatico: true, tag: [A1], giorni: 9, job: { stato: 'cancelled' } })
    expect(await minimizza()).toMatchObject({ minimizzati: 1 })
    expect((await intento(broadcast.intentId)).minimizzato_il).toBeNull()
    expect((await intento(gia.intentId)).minimizzato_il, 'senza bambini non c’è niente da minimizzare').toBeNull()
    expect((await intento(gia.intentId)).n_tag).toBe(3)
    const dopo = await intento(veri.intentId)
    expect(await minimizza()).toEqual({ ok: true, minimizzati: 0 })
    expect(await intento(veri.intentId)).toEqual(dopo)
  })

  it('rispetta il tetto del lotto', async () => {
    for (let i = 0; i < 3; i++) await semina({ stato: 'cancelled', automatico: true, tag: [A1], giorni: 9, job: { stato: 'cancelled' } })
    expect(await minimizza(7, 2)).toMatchObject({ minimizzati: 2 })
    expect(await minimizza(7, 2)).toMatchObject({ minimizzati: 1 })
    expect(await minimizza(7, 2)).toMatchObject({ minimizzati: 0 })
  })

  it('il successo si logga con numeri, e mai un bambino', async () => {
    await semina({ stato: 'cancelled', automatico: true, tag: [A1], giorni: 9, job: { stato: 'cancelled' } })
    await minimizza()
    expect(await contestiLoggati('video-intenti-minimizza')).toEqual([{ giorni: 7, minimizzati: 1 }])
    expect(await tuttoIlLog()).not.toContain(A1)
  })

  it('rifiuta argomenti nulli o fuori misura', async () => {
    for (const args of ['NULL, 100', '7, NULL', '0, 100', '366, 100', '7, 0', '7, 1001']) {
      expect(await rpc(`public.video_intenti_minimizza(${args})`), args).toEqual({ ok: false, code: 'BAD_INPUT' })
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 7 · video_intent_oblio_alunno — l'oblio di un alunno arriva anche sugli intenti
// ─────────────────────────────────────────────────────────────────────────────

describe('video_intent_oblio_alunno', () => {
  const oblio = (alunno: string, conn: PGlite = db) => rpc(`public.video_intent_oblio_alunno('${alunno}')`, conn)

  it('toglie l’alunno da TUTTI gli intenti, qualunque sia lo stato, e lascia gli altri bambini e n_tag', async () => {
    const vivo = await semina({ stato: 'confirmed', automatico: true, tag: [A1, A2], job: { stato: 'ready' } })
    const concluso = await semina({ stato: 'cancelled', automatico: true, tag: [A1, A3], job: { stato: 'cancelled' }, giorni: 2 })
    const pubblicato = await semina({ stato: 'published', automatico: true, tag: [A1], job: { stato: 'ready' }, giorni: 2 })
    const estraneo = await semina({ stato: 'confirmed', automatico: true, tag: [A2, A3], job: { stato: 'ready' } })
    const prima = {
      vivo: await intento(vivo.intentId),
      concluso: await intento(concluso.intentId),
      pubblicato: await intento(pubblicato.intentId),
      estraneo: await intento(estraneo.intentId),
    }

    // Il pubblicato resta senza bambini e NON si revoca (non si può e non serve); il vivo ne ha ancora uno.
    expect(await oblio(A1)).toEqual({ ok: true, intenti: 3, revocati: 0 })

    expect((await intento(vivo.intentId)).tag_alunni).toEqual([A2])
    expect((await intento(concluso.intentId)).tag_alunni).toEqual([A3])
    expect((await intento(pubblicato.intentId)).tag_alunni).toEqual([])
    expect(await intento(estraneo.intentId)).toEqual(prima.estraneo)
    for (const k of ['vivo', 'concluso', 'pubblicato'] as const) {
      const id = { vivo, concluso, pubblicato }[k].intentId
      const dopo = await intento(id)
      expect(dopo.n_tag, `${k}: n_tag è un numero, non identifica nessuno`).toBe(prima[k].n_tag)
      expect(dopo.status, `${k}: lo stato non cambia`).toBe(prima[k].status)
      expect(dopo.updated_at, `${k}: updated_at non si sposta`).toBe(prima[k].updated_at)
    }
  })

  it('un intento non terminale che resta senza bambini e non è broadcast si REVOCA, e la sua uscita riceve la scadenza', async () => {
    const solo = await semina({ stato: 'confirmed', automatico: true, tag: [A1], job: { stato: 'ready' } })
    const conAltri = await semina({ stato: 'confirmed', automatico: true, tag: [A1, A2], job: { stato: 'ready' } })

    expect(await oblio(A1)).toEqual({ ok: true, intenti: 2, revocati: 1 })

    expect((await intento(solo.intentId)).status).toBe('cancelled')
    expect((await intento(solo.intentId)).tag_alunni).toEqual([])
    expect((await job(solo.jobId!)).status).toBe('cancelled')
    expect(await vicinoAdesso('video_jobs', 'output_delete_after', solo.jobId!)).toBe(true)
    expect((await intento(conAltri.intentId)).status, 'ha ancora un bambino: resta in piedi').toBe('confirmed')
    expect((await job(conAltri.jobId!)).output_delete_after).toBeNull()
  })

  it('un alunno che non è su nessun intento non cambia niente; un argomento nullo è BAD_INPUT', async () => {
    const x = await semina({ stato: 'confirmed', automatico: true, tag: [A2], job: { stato: 'ready' } })
    const prima = await intento(x.intentId)
    expect(await oblio(A1)).toEqual({ ok: true, intenti: 0, revocati: 0 })
    expect(await intento(x.intentId)).toEqual(prima)
    expect(await rpc(`public.video_intent_oblio_alunno(NULL)`)).toEqual({ ok: false, code: 'BAD_INPUT' })
  })

  it('non lascia l’alunno nel log: l’oblio non deve conservare l’identificativo che cancella', async () => {
    await semina({ stato: 'confirmed', automatico: true, tag: [A1], job: { stato: 'ready' } })
    await oblio(A1)
    expect(await tuttoIlLog()).not.toContain(A1)
    expect(await contestiLoggati('video-intent-oblio-alunno')).toEqual([{ intenti: 1, revocati: 1 }])
  })

  it('è idempotente: la seconda richiesta per lo stesso alunno non trova più niente', async () => {
    await semina({ stato: 'confirmed', automatico: true, tag: [A1, A2], job: { stato: 'ready' } })
    expect(await oblio(A1)).toMatchObject({ intenti: 1 })
    expect(await oblio(A1)).toEqual({ ok: true, intenti: 0, revocati: 0 })
  })

  it('il testo: toglie con array_remove su TUTTI gli intenti (nessuna condizione di stato nella SELECT), e il ciclo non salta righe', () => {
    const corpo = soloCodice(corpoDi(MIGRAZIONE_C, 'video_intent_oblio_alunno'))
    expect(corpo).toContain('pg_catalog.array_remove(tag_alunni, p_alunno)')
    expect(corpo).toContain('FOR UPDATE OF i')
    // L'oblio non salta niente: il ciclo non può avere SKIP LOCKED.
    expect(corpo).not.toMatch(/SKIP LOCKED/)
    expect(corpo).toMatch(/ORDER BY i\.id\s+FOR UPDATE OF i/)
    // La WHERE non filtra per stato: l'alunno si toglie da ogni intento che lo nomina.
    const dove = corpo.slice(corpo.indexOf('WHERE p_alunno'), corpo.indexOf('ORDER BY i.id'))
    expect(dove).toContain('p_alunno = ANY(i.tag_alunni)')
    expect(dove).not.toMatch(/status|channel|pubblicazione/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 8 · video_riconciliazione — i sei conteggi nuovi, in sola lettura
// ─────────────────────────────────────────────────────────────────────────────

describe('video_riconciliazione · i conteggi della PR 2', () => {
  const conti = () => rpc<Risposta>('public.video_riconciliazione(48, 168, 1)')

  it('conta le uscite da togliere e quelle senza scadenza (concluse o pubblicate), e non confonde chi serve ancora', async () => {
    await semina({ canale: 'news', job: { stato: 'failed', uscita: true, scadenzaUscita: 'passata' } }) // da togliere
    await semina({ canale: 'news', job: { stato: 'failed', uscita: true, scadenzaUscita: 'futura' } }) // non ancora
    await semina({ canale: 'news', job: { stato: 'failed', uscita: true, uscitaTolta: true } }) // già tolta
    await semina({ canale: 'news', job: { stato: 'failed', uscita: true } }) // senza scadenza
    await semina({ stato: 'published', job: { stato: 'ready' } }) // senza scadenza (pubblicato)
    await semina({ stato: 'confirmed', automatico: true, tag: [A1], job: { stato: 'ready' } }) // serve ancora: NO
    await semina({ canale: 'news', job: { stato: 'failed', uscita: false } }) // senza uscita: NO

    expect(await conti()).toMatchObject({ uscite_da_togliere: 1, uscite_senza_scadenza: 2 })
  })

  it('conta le pubblicazioni in attesa, gli esiti da notificare e il flusso vecchio in volo', async () => {
    // Pubblicazioni in attesa: automatici confermati con tutti i job pronti.
    await semina({ stato: 'confirmed', automatico: true, tag: [A1], job: { stato: 'ready' } })
    await semina({ stato: 'confirmed', automatico: true, tag: [A1], job: { stato: 'ready' } })
    await semina({ stato: 'confirmed', automatico: true, tag: [A1], job: { stato: 'queued' } }) // ancora in conversione
    await semina({ stato: 'confirmed', automatico: true, tag: [A1] }) // senza job
    // Esiti da notificare: pubblicato, pubblicazione fallita, job fallito — tutti senza marca.
    await semina({ stato: 'published', automatico: true, job: { stato: 'ready' } })
    await semina({ stato: 'action_required', automatico: true, tag: [A1], job: { stato: 'ready' } })
    await semina({ stato: 'confirmed', automatico: true, tag: [A1], job: { stato: 'failed' } })
    const marcato = await semina({ stato: 'published', automatico: true, job: { stato: 'ready' } })
    await db.exec(`UPDATE public.video_intents SET esito_notificato = 'pubblicato', esito_notificato_il = now() WHERE id = '${marcato.intentId}'`)
    // Il flusso vecchio ancora in volo: galleria, non automatico, non terminale. Non una News, non un terminale.
    await semina({ stato: 'pending', job: { stato: 'awaiting_upload' } })
    await semina({ stato: 'confirmed', job: { stato: 'ready' } })
    await semina({ canale: 'news', stato: 'confirmed', job: { stato: 'ready' } })
    await semina({ stato: 'published', job: { stato: 'ready' } })

    expect(await conti()).toMatchObject({
      pubblicazioni_in_attesa: 2,
      esiti_da_notificare: 3,
      flusso_vecchio_in_volo: 2,
    })
  })

  it('i conteggi di prima restano quelli di prima (stesse chiavi, stessi valori)', async () => {
    await semina({ canale: 'news', job: { stato: 'awaiting_upload' }, giorni: 0 })
    await semina({ canale: 'news', job: { stato: 'queued' }, giorni: 1 })
    await semina({ canale: 'news', stato: 'cancelled', job: { stato: 'cancelled' } })
    const lease = await semina({ canale: 'news', job: { stato: 'queued' } })
    await db.exec(`
      UPDATE public.video_jobs SET status = 'processing', lease_owner = '${LEASE_A}', lease_expires_at = now() - interval '30 minutes'
      WHERE id = '${lease.jobId}'
    `)
    const r = await conti()
    expect(r).toMatchObject({
      ok: true,
      upload_in_sospeso: 1,
      in_coda: 1,
      in_coda_in_ritardo: 1,
      in_lavorazione: 1,
      lease_scadute: 1,
      conclusi_senza_scadenza: 0,
      outbox_in_attesa: 0,
      outbox_in_quarantena: 0,
    })
    for (const chiave of [
      'upload_in_sospeso', 'upload_abbandonati', 'in_coda', 'in_coda_in_ritardo', 'in_lavorazione', 'lease_scadute',
      'incagliati', 'pronti', 'originali_da_togliere', 'originali_gia_tolti', 'output_di_job_conclusi',
      'conclusi_senza_scadenza', 'outbox_in_attesa', 'outbox_in_ritardo', 'outbox_in_quarantena',
    ]) {
      expect(r, chiave).toHaveProperty(chiave)
    }
  })

  it('è una LETTURA: nessuna riga toccata, in nessuna delle tre tabelle', async () => {
    await semina({ canale: 'news', job: { stato: 'failed', uscita: true } })
    await semina({ stato: 'confirmed', automatico: true, tag: [A1], job: { stato: 'ready' } })
    await semina({ stato: 'pending', job: { stato: 'awaiting_upload' } })
    const istantanea = async () => ({
      intenti: await righe(`SELECT * FROM public.video_intents ORDER BY id`),
      job: await righe(`SELECT * FROM public.video_jobs ORDER BY id`),
      outbox: await righe(`SELECT * FROM public.video_outbox ORDER BY id`),
    })
    const prima = await istantanea()
    await conti()
    await conti()
    expect(await istantanea()).toEqual(prima)

    // E il testo non contiene nessuna scrittura: una riconciliazione che «sistema» quel che conta è
    // indistinguibile da una che non conta niente.
    const corpo = soloCodice(corpoDi(MIGRAZIONE_C, 'video_riconciliazione'))
    expect(corpo).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/i)
  })

  it('arrivi_mancati è NULL, non 0, quando storage.objects non si può leggere («non so» e «zero» sono due fatti diversi)', async () => {
    const r = await conti()
    expect(r).toHaveProperty('arrivi_mancati')
    expect(r.arrivi_mancati).toBeNull()
  })

  describe('con uno schema storage che ha storage.objects', () => {
    let conn: PGlite

    beforeAll(async () => {
      conn = await costruisci()
    }, 60_000)

    afterAll(async () => {
      await conn.close()
    })

    beforeEach(async () => {
      await svuota(conn)
      // La tabella si ricrea a ogni prova: una prova può romperla di proposito.
      await conn.exec(`
        DROP TABLE IF EXISTS storage.objects;
        CREATE TABLE storage.objects (bucket_id text NOT NULL, name text NOT NULL)
      `)
    })

    const contiCon = () => rpc<Risposta>('public.video_riconciliazione(48, 168, 1)', conn)

    it('conta i job che aspettano ancora il file quando l’oggetto in video_originals esiste già', async () => {
      const manca = await semina({ canale: 'news', job: { stato: 'awaiting_upload' } }, conn)
      const arrivato = await semina({ canale: 'news', job: { stato: 'awaiting_upload' } }, conn)
      const gia = await semina({ canale: 'news', job: { stato: 'queued' } }, conn)
      const paths = await righe<{ id: string; original_path: string }>(`SELECT id, original_path FROM public.video_jobs`, conn)
      const percorso = (id: string) => paths.find((p) => p.id === id)!.original_path
      await conn.exec(`
        INSERT INTO storage.objects(bucket_id, name) VALUES
          ('video_originals', '${percorso(arrivato.jobId!)}'),
          ('video_originals', '${percorso(gia.jobId!)}'),
          ('un_altro_bucket', '${percorso(manca.jobId!)}')
      `)
      // Arrivato e ancora «awaiting_upload»: il trigger non l'ha visto. Quello già in coda no, e il file
      // di un altro bucket con lo stesso nome non c'entra.
      expect(await contiCon()).toMatchObject({ arrivi_mancati: 1 })
    })

    it('a zero è ZERO (un numero), non NULL: lo schema c’è e si legge', async () => {
      await semina({ canale: 'news', job: { stato: 'awaiting_upload' } }, conn)
      const r = await contiCon()
      expect(r.arrivi_mancati).toBe(0)
    })

    it('se storage.objects esiste ma non si legge (colonne diverse, privilegi) il conteggio è NULL e il resto risponde', async () => {
      await conn.exec(`DROP TABLE storage.objects; CREATE TABLE storage.objects (altra_colonna text)`)
      await semina({ canale: 'news', job: { stato: 'awaiting_upload' } }, conn)
      const r = await contiCon()
      expect(r.ok).toBe(true)
      expect(r.arrivi_mancati).toBeNull()
      expect(r).toMatchObject({ upload_in_sospeso: 1 })
    })
  })

  it('il livello del log: error se un concluso è senza scadenza dell’originale o c’è una quarantena, info altrimenti', async () => {
    await conti()
    expect((await livelliLoggati('video-riconciliazione')).map((l) => l.livello)).toEqual(['info'])
    await svuota()
    await semina({ canale: 'news', job: { stato: 'failed', originaleSenzaScadenza: true } })
    await conti()
    expect((await livelliLoggati('video-riconciliazione')).map((l) => l.livello)).toEqual(['error'])
  })

  it('rifiuta argomenti nulli o fuori misura, come prima', async () => {
    for (const args of ['NULL, 168, 1', '48, 0, 1', '48, 168, 8761']) {
      expect(await rpc(`public.video_riconciliazione(${args})`), args).toEqual({ ok: false, code: 'BAD_INPUT' })
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 9 · video_outbox_claim(…, p_tipi) — il filtro per tipo sta NEL claim
// ─────────────────────────────────────────────────────────────────────────────

describe('video_outbox_claim · l’overload con i tipi', () => {
  type Evento = { id: string; event_type: string; attempts: number; lease_owner: string | null }
  const LEASE_B = '51000000-0000-4000-8000-000000000005'

  /** Un evento accodato per un intento nuovo, col suo tipo; `minutiFa` lo rende più vecchio. */
  async function evento(tipo: string, minutiFa = 0): Promise<string> {
    const { intentId } = await semina({ stato: 'confirmed', automatico: true, tag: [A1] })
    const { id } = await unaRiga<{ id: string }>(`
      INSERT INTO public.video_outbox (intent_id, revision, event_type, payload, created_at, updated_at)
      VALUES ('${intentId}', 1, '${tipo}', '{}'::jsonb, now() - interval '${minutiFa} minutes', now() - interval '${minutiFa} minutes')
      RETURNING id
    `)
    return id
  }
  const stato = (id: string) =>
    unaRiga<Evento>(`SELECT id, event_type, attempts, lease_owner FROM public.video_outbox WHERE id = '${id}'`)
  const prendi = (limite: number, tipi: string, lease = LEASE_A) =>
    rpc<{ ok: boolean; eventi?: Array<{ id: string; event_type: string; attempts: number }>; code?: string }>(
      `public.video_outbox_claim('${lease}', 120, ${limite}, ${tipi})`,
    )

  it('prende SOLO gli eventi dei tipi richiesti: gli altri restano liberi e con i tentativi invariati', async () => {
    const mio = await evento('gallery.auto_publish')
    const altro = await evento('intent.revoked')
    const ancora = await evento('gallery.published')

    const r = await prendi(10, `ARRAY['gallery.auto_publish']`)
    expect(r.ok).toBe(true)
    expect(r.eventi?.map((e) => e.id)).toEqual([mio])
    expect(await stato(mio)).toMatchObject({ attempts: 1, lease_owner: LEASE_A })
    for (const id of [altro, ancora]) {
      expect(await stato(id), 'un evento di un altro tipo non si tocca').toMatchObject({ attempts: 0, lease_owner: null })
    }
  })

  it('più tipi insieme, e un tipo che non c’è non prende niente', async () => {
    const a = await evento('gallery.auto_publish')
    const b = await evento('intent.revoked')
    await evento('gallery.published')
    const due = await prendi(10, `ARRAY['gallery.auto_publish', 'intent.revoked']`)
    expect(due.eventi?.map((e) => e.id).sort()).toEqual([a, b].sort())

    const nessuno = await prendi(10, `ARRAY['tipo.inesistente']`, LEASE_B)
    expect(nessuno).toEqual({ ok: true, eventi: [] })
  })

  it('un gallery.auto_publish NON resta dietro gli eventi altrui: il tetto del lotto vale sul filtrato', async () => {
    // Sei eventi di un altro tipo, tutti più vecchi: senza il filtro nel claim, un lotto da cinque li
    // prenderebbe tutti e cinque e il nostro resterebbe fuori (e gli altri in lease, senza consegna).
    const altri: string[] = []
    for (let i = 0; i < 6; i++) altri.push(await evento('intent.revoked', 60 + i))
    const mio = await evento('gallery.auto_publish', 1)

    const r = await prendi(5, `ARRAY['gallery.auto_publish']`)
    expect(r.eventi?.map((e) => e.id)).toEqual([mio])
    for (const id of altri) expect(await stato(id)).toMatchObject({ attempts: 0, lease_owner: null })
  })

  it('il lotto è rispettato anche sul filtrato, in ordine di arrivo, e una lease viva non si riprende', async () => {
    const primo = await evento('gallery.auto_publish', 30)
    const secondo = await evento('gallery.auto_publish', 20)
    await evento('gallery.auto_publish', 10)
    const r = await prendi(2, `ARRAY['gallery.auto_publish']`)
    expect(r.eventi?.map((e) => e.id)).toEqual([primo, secondo])
    // Gli stessi due con la lease viva: non si riprendono, ne resta uno.
    const dopo = await prendi(10, `ARRAY['gallery.auto_publish']`, LEASE_B)
    expect(dopo.eventi).toHaveLength(1)
  })

  it('un evento che ha esaurito i 25 tentativi, o già consegnato, non si riprende (come a tre argomenti)', async () => {
    const quarantena = await evento('gallery.auto_publish')
    await db.exec(`UPDATE public.video_outbox SET attempts = 25 WHERE id = '${quarantena}'`)
    const inviato = await evento('gallery.auto_publish')
    await db.exec(`UPDATE public.video_outbox SET sent_at = now() WHERE id = '${inviato}'`)
    expect(await prendi(10, `ARRAY['gallery.auto_publish']`)).toEqual({ ok: true, eventi: [] })
  })

  it('rifiuta un filtro nullo, vuoto, con un elemento nullo, malformato, troppo lungo o con più di 20 tipi — senza prendere niente', async () => {
    const mio = await evento('gallery.auto_publish')
    const lungo = `'a${'b'.repeat(80)}'`
    const ventuno = `ARRAY[${Array.from({ length: 21 }, (_, i) => `'tipo.${i}'`).join(', ')}]`
    for (const tipi of [
      'NULL::text[]',
      `ARRAY[]::text[]`,
      `ARRAY['gallery.auto_publish', NULL]`,
      `ARRAY['Gallery.Auto']`,
      `ARRAY['1gallery']`,
      `ARRAY['con spazio']`,
      `ARRAY[${lungo}]`,
      ventuno,
    ]) {
      expect(await prendi(10, tipi), tipi).toEqual({ ok: false, code: 'BAD_INPUT' })
    }
    expect(await stato(mio), 'un rifiuto non prende niente').toMatchObject({ attempts: 0, lease_owner: null })
    // I rifiuti di prima restano.
    expect(await rpc(`public.video_outbox_claim(NULL, 120, 10, ARRAY['a'])`)).toEqual({ ok: false, code: 'BAD_INPUT' })
    expect(await rpc(`public.video_outbox_claim('${LEASE_A}', 0, 10, ARRAY['a'])`)).toEqual({ ok: false, code: 'BAD_INPUT' })
    expect(await rpc(`public.video_outbox_claim('${LEASE_A}', 120, 101, ARRAY['a'])`)).toEqual({ ok: false, code: 'BAD_INPUT' })
  })

  it('accetta il tipo di 80 caratteri (il limite della colonna) e 20 tipi insieme', async () => {
    const limite = `a${'b'.repeat(79)}`
    expect(limite).toHaveLength(80)
    expect(await prendi(10, `ARRAY['${limite}']`)).toEqual({ ok: true, eventi: [] })
    const venti = `ARRAY[${Array.from({ length: 20 }, (_, i) => `'tipo.${i}'`).join(', ')}]`
    expect(await prendi(10, venti)).toEqual({ ok: true, eventi: [] })
  })

  it('NON è ambigua: una chiamata a tre argomenti per nome sceglie la versione a tre, una a quattro quella a quattro', async () => {
    const a = await evento('gallery.auto_publish')
    const b = await evento('intent.revoked')
    // Come lo chiama PostgREST: argomenti per nome. Con un DEFAULT su p_tipi questa chiamata sarebbe stata ambigua.
    const tre = await rpc<{ ok: boolean; eventi: Array<{ id: string }> }>(
      `public.video_outbox_claim(p_lease_owner => '${LEASE_A}', p_lease_seconds => 120, p_limite => 10)`,
    )
    expect(tre.eventi.map((e) => e.id).sort(), 'la versione a tre argomenti prende TUTTI i tipi').toEqual([a, b].sort())
    const quattro = await rpc<{ ok: boolean; eventi: Array<{ id: string }> }>(
      `public.video_outbox_claim(p_lease_owner => '${LEASE_B}', p_lease_seconds => 120, p_limite => 10, p_tipi => ARRAY['gallery.auto_publish'])`,
    )
    expect(quattro.eventi).toEqual([]) // già in lease alla chiamata precedente
  })

  it('il corpo è quello della versione a tre argomenti più SOLO le due aggiunte dichiarate, byte per byte (commenti esclusi)', () => {
    const originale = soloCodice(corpoDi(INTENTI, 'video_outbox_claim'))
    const nuovo = soloCodice(corpoDi(MIGRAZIONE_C, 'video_outbox_claim'))
    expect(originale.length).toBeGreaterThan(900)

    const CONTROLLO = [
      '    OR p_tipi IS NULL',
      '    OR pg_catalog.cardinality(p_tipi) NOT BETWEEN 1 AND 20',
      '    OR pg_catalog.array_position(p_tipi, NULL) IS NOT NULL',
      '    OR EXISTS (',
      '      SELECT 1',
      '      FROM pg_catalog.unnest(p_tipi) AS t(tipo)',
      "      WHERE pg_catalog.char_length(t.tipo) > 80 OR t.tipo !~ '^[a-z][a-z0-9_.-]*$'",
      '    )',
    ].join('\n') + '\n'
    const FILTRO = '      AND event_type = ANY(p_tipi)\n'
    expect(occorrenze(nuovo, CONTROLLO), 'il controllo di p_tipi deve esserci, una volta sola').toBe(1)
    expect(occorrenze(nuovo, FILTRO), 'il filtro per tipo deve esserci, una volta sola').toBe(1)
    expect(nuovo.replace(CONTROLLO, '').replace(FILTRO, '')).toBe(originale)
    // Il filtro sta DENTRO la scelta degli eventi (la CTE `presi`), prima del lock: non dopo il claim.
    expect(nuovo.indexOf(FILTRO)).toBeLessThan(nuovo.indexOf('FOR UPDATE SKIP LOCKED'))
    expect(nuovo.indexOf(FILTRO)).toBeGreaterThan(nuovo.indexOf('WITH presi AS'))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 10 · IL TESTO DEL FILE C — il diff dei corpi sostituiti e le dichiarazioni della testata
// ─────────────────────────────────────────────────────────────────────────────

describe('il testo del file C', () => {
  it('la testata dichiara la firma ESATTA di ogni funzione: stessi nomi e stessi tipi degli argomenti del catalogo', async () => {
    const testata = MIGRAZIONE_C.split('\n')
      .filter((r) => r.startsWith('--'))
      .map((r) => r.replace(/^--\s?/, ''))
      .join('\n')

    const tutte = [...FUNZIONI_NUOVE, ...FUNZIONI_SOSTITUITE]
    expect(tutte).toHaveLength(8)
    for (const { nome, firma } of tutte) {
      const dichiarata = new RegExp(`\\b${nome}\\(\\s*((?:p_[a-z0-9_]+ [a-z\\[\\] ]+,?\\s*)+)\\)`).exec(testata)
      expect(dichiarata, `la testata non dichiara la firma di ${nome}`).not.toBeNull()
      const attesa = dichiarata![1].replace(/\s+/g, ' ').trim().replace(/,$/, '')
      const { reale } = await unaRiga<{ reale: string }>(`
        SELECT pg_get_function_identity_arguments(p.oid) AS reale
        FROM pg_proc p WHERE p.oid = 'public.${nome}(${firma})'::regprocedure
      `)
      expect(attesa, `la firma di ${nome} nella testata diverge da quella della funzione`).toBe(reale)
    }
  })

  it('video_retention_scadenze differisce dalla definizione più recente SOLO per le modifiche dichiarate, byte per byte (commenti esclusi)', () => {
    const originale = soloCodice(corpoDi(RETENTION, 'video_retention_scadenze'))
    const nuovo = soloCodice(corpoDi(MIGRAZIONE_C, 'video_retention_scadenze'))
    expect(originale).toContain('v_senza_scadenza')
    expect(originale.length).toBeGreaterThan(3000)

    const M1 = '  v_uscite_senza_scadenza integer := 0;\n'
    const M3 = /  WITH candidati AS \(\n    SELECT j\.id\n    FROM public\.video_jobs AS j\n    INNER JOIN public\.video_intents AS i[\s\S]*?INTO v_uscite_senza_scadenza FROM aggiornati;\n\n/g
    const M4A = ",\n      'uscite_senza_scadenza', v_uscite_senza_scadenza"
    const M4B = ",\n    'uscite_senza_scadenza', v_uscite_senza_scadenza"

    expect(occorrenze(nuovo, M1), 'la variabile del conteggio, una volta').toBe(1)
    expect(nuovo.match(M3), 'il passo (d), una volta').toHaveLength(1)
    expect(occorrenze(nuovo, M4A), 'il conteggio nel log').toBe(1)
    expect(occorrenze(nuovo, M4B), 'il conteggio nella risposta').toBe(1)

    const ripristinato = nuovo
      .replace(M1, '')
      .replace(M3, '')
      .replace(M4A, '')
      .replace(M4B, '')
    expect(ripristinato).toBe(originale)
  })

  it('video_riconciliazione differisce dalla definizione più recente SOLO per le modifiche dichiarate, byte per byte (commenti esclusi)', () => {
    const originale = soloCodice(corpoDi(RETENTION, 'video_riconciliazione'))
    const nuovo = soloCodice(corpoDi(MIGRAZIONE_C, 'video_riconciliazione'))
    expect(originale).toContain('outbox_in_quarantena')
    expect(originale.length).toBeGreaterThan(2500)

    const M1 = '  v_nuovi jsonb;\n  v_arrivi_mancati integer;\n'
    const M2 = /  SELECT pg_catalog\.jsonb_build_object\(\n    'uscite_da_togliere'[\s\S]*?v_nuovi := v_nuovi \|\| pg_catalog\.jsonb_build_object\('arrivi_mancati', v_arrivi_mancati\);\n\n/g
    const M3A = 'NULL, NULL, NULL, v_conti || v_outbox || v_nuovi'
    const M3B = "RETURN pg_catalog.jsonb_build_object('ok', true) || v_conti || v_outbox || v_nuovi;"

    expect(occorrenze(nuovo, M1)).toBe(1)
    expect(nuovo.match(M2), 'il blocco dei sei conteggi, una volta').toHaveLength(1)
    expect(occorrenze(nuovo, M3A)).toBe(1)
    expect(occorrenze(nuovo, M3B)).toBe(1)

    const ripristinato = nuovo
      .replace(M1, '')
      .replace(M2, '')
      .replace(M3A, 'NULL, NULL, NULL, v_conti || v_outbox')
      .replace(M3B, "RETURN pg_catalog.jsonb_build_object('ok', true) || v_conti || v_outbox;")
    expect(ripristinato).toBe(originale)
  })

  it('le tre funzioni che revocano scrivono la scadenza dell’uscita con LO STESSO UPDATE (nessuna delle tre può divergere in silenzio)', () => {
    const UPDATE_USCITA =
      /UPDATE public\.video_jobs\n\s+SET output_delete_after = LEAST\(COALESCE\(output_delete_after, v_ora\), v_ora\),\n\s+updated_at = v_ora\n\s+WHERE intent_id = v_intento\.id\n\s+AND output_path IS NOT NULL\n\s+AND output_deleted_at IS NULL;/
    for (const nome of ['video_intent_scadi_non_pubblicato', 'video_galleria_flusso_vecchio_revoca', 'video_intent_oblio_alunno']) {
      const corpo = soloCodice(corpoDi(MIGRAZIONE_C, nome))
      expect(UPDATE_USCITA.test(corpo), `${nome} non scrive la scadenza dell'uscita nella forma attesa`).toBe(true)
      // La scrittura viene DOPO la revoca riuscita, mai prima: un rifiuto non lascia una scadenza orfana.
      expect(corpo.search(UPDATE_USCITA), nome).toBeGreaterThan(corpo.indexOf('public.video_intent_revoke('))
    }
  })

  it('nessuna funzione del file cancella un file o scrive su storage: i file si tolgono solo dalla Storage API', () => {
    const codice = soloCodice(MIGRAZIONE_C)
    expect(codice).not.toMatch(/\bDELETE\b/i)
    expect(codice).not.toMatch(/(INSERT\s+INTO|UPDATE|ALTER|DROP|TRUNCATE)\s+storage\./i)
    // L'unica funzione che nomina lo Storage è la riconciliazione: due volte (il to_regclass e la SELECT), in
    // sola lettura e in un blocco che non fa fallire il resto.
    for (const { nome } of [...FUNZIONI_NUOVE, ...FUNZIONI_SOSTITUITE]) {
      if (nome === 'video_riconciliazione') continue
      expect(soloCodice(corpoDi(MIGRAZIONE_C, nome)), `${nome} non deve nominare lo Storage`).not.toMatch(/storage\./)
    }
    const riconciliazione = soloCodice(corpoDi(MIGRAZIONE_C, 'video_riconciliazione'))
    expect(occorrenze(riconciliazione, 'storage.objects')).toBe(2)
    expect(riconciliazione).toMatch(
      /BEGIN\s+SELECT pg_catalog\.count\(\*\)::integer\s+INTO v_arrivi_mancati[\s\S]*?EXCEPTION WHEN OTHERS THEN\s+v_arrivi_mancati := NULL;/,
    )
  })

  it('nessuna chiamata di log nomina un campo vietato (bambini, alunno, hash, percorsi, segreti)', () => {
    const codice = soloCodice(MIGRAZIONE_C)
    const chiamate = [...codice.matchAll(/_video_job_transition_log\(/g)].map((m) => {
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
    expect(chiamate.length, 'lo scanner non trova le chiamate di log').toBeGreaterThanOrEqual(22)
    const valori = (c: string) => c.replace(/'[^']*'/g, "''")
    const vietato =
      /\b(tag_alunni|p_alunno|v_tag|v_intento\.tag_alunni|rinnovo_token_hash|original_path|output_path|file_url|sha256_dichiarato)\b/
    expect(chiamate.filter((c) => vietato.test(valori(c)))).toEqual([])
    // Il controllo positivo: lo stesso filtro SEGNALA un log che nomina davvero un valore vietato.
    expect(vietato.test(valori("_video_job_transition_log('x', 'info', NULL, NULL, NULL, jsonb_build_object('a', p_alunno))"))).toBe(true)
    expect(vietato.test(valori("_video_job_transition_log('x', 'info', NULL, NULL, NULL, jsonb_build_object('n', v_toccati))"))).toBe(false)
  })

  it('ogni funzione del file ha il suo REVOKE da PUBLIC, anon e authenticated e il suo GRANT al solo service_role', () => {
    const codice = soloCodice(MIGRAZIONE_C)
    const definite = [...codice.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)\(([^)]*)\)/g)].map((m) => [m[1], m[2].replace(/\s+/g, ' ').trim()])
    expect(definite).toHaveLength(8)
    for (const [nome] of definite) {
      expect(codice, `manca il REVOKE di ${nome}`).toMatch(
        new RegExp(`REVOKE ALL ON FUNCTION public\\.${nome}\\([^)]*\\)\\s+FROM PUBLIC, anon, authenticated;`),
      )
      expect(codice, `manca il GRANT di ${nome}`).toMatch(
        new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${nome}\\([^)]*\\)\\s+TO service_role;`),
      )
    }
    expect(codice).not.toMatch(/GRANT[^;]*(anon|authenticated|PUBLIC)/)
  })

  it('l’ordine dei lock è INTENTO → JOB: nessuna funzione prende da sé i due lock, e chi blocca gli intenti lascia i job alla revoca', () => {
    // Le quattro funzioni che bloccano gli INTENTI (il ciclo) NON bloccano mai un job da sé: i job li prende
    // `video_intent_revoke`, nell'ordine giusto (intento, poi job), dentro la stessa transazione.
    for (const nome of [
      'video_intent_scadi_non_pubblicato',
      'video_galleria_flusso_vecchio_revoca',
      'video_intenti_minimizza',
      'video_intent_oblio_alunno',
    ]) {
      const corpo = soloCodice(corpoDi(MIGRAZIONE_C, nome))
      expect(corpo, `${nome} deve bloccare gli intenti`).toMatch(/FOR UPDATE OF i\b/)
      // Ogni `FOR UPDATE` del corpo è quello degli intenti: nessuno è dei job.
      expect(
        [...corpo.matchAll(/FOR UPDATE(?! OF i\b)/g)],
        `${nome} non deve bloccare i job da sé`,
      ).toEqual([])
    }
    // E quelle che bloccano i JOB non toccano mai il lock di un intento: non possono invertire l'ordine.
    for (const nome of ['video_retention_uscita_rimossa', 'video_retention_scadenze']) {
      const corpo = soloCodice(corpoDi(MIGRAZIONE_C, nome))
      expect(corpo, `${nome} blocca un intento dopo un job`).not.toMatch(/FROM\s+public\.video_intents\b[^;]*?FOR UPDATE/)
      expect(corpo, `${nome} blocca un intento dopo un job`).not.toMatch(/FOR UPDATE OF i\b/)
    }
  })

  it('nessun console, nessun segreto, nessun uuid di sede, nessun indirizzo nel file (il repository è pubblico)', () => {
    const codice = soloCodice(MIGRAZIONE_C)
    expect(codice).not.toMatch(/console\./)
    expect(codice).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)
    expect(codice).not.toMatch(/https?:\/\//i)
    expect(codice).not.toMatch(/\bcron_secret\b|\bx-cron-secret\b/)
  })

  it('il file NON accende nessuna delle tre guardie di freschezza delle fotografie (solo funzioni: nessuna voce in MIGRAZIONI_ATTESE_AL_MERGE)', () => {
    expect(toccaUnUnico(MIGRAZIONE_C), 'il file contiene UNIQUE o PRIMARY KEY: la guardia degli indici unici lo vedrebbe').toBe(false)
    expect(toccaLeFkUtenti(MIGRAZIONE_C), 'il file contiene un ADD/DROP CONSTRAINT o una REFERENCES utenti').toBe(false)
    expect(toccaLaRls(MIGRAZIONE_C), 'il file contiene la parola policy, RLS, DROP TABLE o una colonna scuola_id').toBe(false)
    // E i riconoscitori sono vivi: li accendono i frammenti giusti (il controllo positivo).
    expect(toccaUnUnico('CREATE UNIQUE INDEX x ON t (a);')).toBe(true)
    expect(toccaLeFkUtenti('ALTER TABLE t ADD CONSTRAINT c CHECK (true);')).toBe(true)
    expect(toccaLaRls('CREATE POLICY p ON t USING (true);')).toBe(true)
  })

  it('nessun vincolo, nessun indice, nessuna colonna, nessuna tabella: solo funzioni (e commenti sulle funzioni)', () => {
    const codice = soloCodice(MIGRAZIONE_C)
    expect(codice).not.toMatch(/\b(CREATE\s+(UNIQUE\s+)?INDEX|CREATE\s+TABLE|ALTER\s+TABLE|ADD\s+COLUMN|ADD\s+CONSTRAINT|CREATE\s+TRIGGER)\b/i)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 11 · IL SECONDARIO #33 DEL FILE A — il vincolo di durata non torna indietro
// ─────────────────────────────────────────────────────────────────────────────

describe('file A · il blocco $probe$ toglie il vincolo di durata SOLO se è quello a 180 (#33)', () => {
  const definizione = (conn: PGlite) =>
    unaRiga<{ def: string; oid: number }>(
      `SELECT pg_get_constraintdef(oid) AS def, oid::int AS oid FROM pg_constraint
       WHERE conrelid = 'public.video_jobs'::regclass AND conname = 'video_jobs_probe_chk'`,
      conn,
    )

  /** Rimette il vincolo a un tetto qualunque, com'è quando la produzione lo ha già cambiato. */
  async function impostaTetto(conn: PGlite, tetto: number) {
    await conn.exec(`
      ALTER TABLE public.video_jobs DROP CONSTRAINT video_jobs_probe_chk;
      ALTER TABLE public.video_jobs ADD CONSTRAINT video_jobs_probe_chk CHECK (
        probe_json IS NULL
        OR CASE
          WHEN jsonb_typeof(probe_json) = 'object'
            AND jsonb_typeof(probe_json -> 'durationSeconds') = 'number'
          THEN (probe_json ->> 'durationSeconds')::numeric > 0
            AND (probe_json ->> 'durationSeconds')::numeric <= ${tetto}
          ELSE false
        END
      )
    `)
  }

  it('il vincolo a 180 della PR 1 passa a 300 (e la seconda applicazione non lo ricrea)', async () => {
    const conn = await costruisci({ conA: false, conC: false })
    try {
      expect((await definizione(conn)).def).toMatch(/<= \(180\)::numeric/)
      await conn.exec(MIGRAZIONE_A)
      const dopo = await definizione(conn)
      expect(dopo.def).toMatch(/<= \(300\)::numeric/)
      await conn.exec(MIGRAZIONE_A)
      expect((await definizione(conn)).oid, 'alla seconda applicazione il vincolo non viene toccato (stesso OID)').toBe(dopo.oid)
    } finally {
      await conn.close()
    }
  }, 60_000)

  it('un tetto DIVERSO (600, deciso dopo) resta com’è: la riapplicazione del file A non lo riporta a 300', async () => {
    const conn = await costruisci({ conC: false })
    try {
      await impostaTetto(conn, 600)
      const prima = await definizione(conn)
      expect(prima.def).toMatch(/<= \(600\)::numeric/)

      await conn.exec(MIGRAZIONE_A)
      await conn.exec(MIGRAZIONE_A)

      const dopo = await definizione(conn)
      expect(dopo.def, 'il tetto di 600 non deve tornare a 300').toMatch(/<= \(600\)::numeric/)
      expect(dopo.oid, 'il vincolo non è stato né tolto né ricreato').toBe(prima.oid)
      // E vale davvero: 500 secondi passano, 601 no.
      const { jobId } = await semina({ canale: 'news', job: { stato: 'queued' } }, conn)
      await conn.exec(`UPDATE public.video_jobs SET probe_json = '{"durationSeconds":500}' WHERE id = '${jobId}'`)
      await expect(
        conn.exec(`UPDATE public.video_jobs SET probe_json = '{"durationSeconds":601}' WHERE id = '${jobId}'`),
      ).rejects.toThrow(/video_jobs_probe_chk/)
    } finally {
      await conn.close()
    }
  }, 60_000)

  it('un tetto già a 300 resta com’è (stesso OID), anche dopo tre applicazioni', async () => {
    const conn = await costruisci({ conC: false })
    try {
      const prima = await definizione(conn)
      expect(prima.def).toMatch(/<= \(300\)::numeric/)
      await conn.exec(MIGRAZIONE_A)
      await conn.exec(MIGRAZIONE_A)
      expect((await definizione(conn)).oid).toBe(prima.oid)
    } finally {
      await conn.close()
    }
  }, 60_000)

  it('l’espressione del file A riconosce la definizione ESATTA letta in produzione (PostgreSQL 17.6, 02/10/2026) e nessun altro tetto', async () => {
    // Letta in sola lettura con `pg_get_constraintdef` sul database di produzione: la forma che la migrazione
    // deve riconoscere per portare il vincolo a 300. PGlite è PostgreSQL 18: la deparse di un `numeric` costante
    // è la stessa, ma qui si prova contro il testo vero e non contro quello che PGlite produce.
    const PRODUZIONE_A_180 =
      "CHECK (((probe_json IS NULL) OR\nCASE\n    WHEN ((jsonb_typeof(probe_json) = 'object'::text) AND (jsonb_typeof((probe_json -> 'durationSeconds'::text)) = 'number'::text)) THEN ((((probe_json ->> 'durationSeconds'::text))::numeric > (0)::numeric) AND (((probe_json ->> 'durationSeconds'::text))::numeric <= (180)::numeric))\n    ELSE false\nEND))"
    // L'espressione si legge dal TESTO della migrazione: se qualcuno la cambia, questa prova la rimisura.
    const espressione = /pg_get_constraintdef\(oid\) ~ '([^']+)'/.exec(soloCodice(MIGRAZIONE_A))
    expect(espressione, 'il blocco $probe$ non confronta più la definizione con un’espressione regolare').not.toBeNull()
    const prova = async (definizione: string): Promise<boolean> =>
      (await db.query<{ v: boolean }>('SELECT $1::text ~ $2 AS v', [definizione, espressione![1]])).rows[0].v
    expect(await prova(PRODUZIONE_A_180), 'la definizione di produzione a 180 deve essere riconosciuta').toBe(true)
    for (const altro of ['(300)', '(240)', '(600)', '(1800)', '(18)']) {
      expect(await prova(PRODUZIONE_A_180.replace('(180)', altro)), `un tetto di ${altro} non è «quello a 180»`).toBe(false)
    }
    // «180» nel testo non basta: un 180 in un altro punto della definizione (il limite INFERIORE) con il
    // tetto a 300 non è «il vincolo a 180».
    const conUnAltro180 = PRODUZIONE_A_180.replace('> (0)::numeric', '> (180)::numeric').replace('<= (180)::numeric', '<= (300)::numeric')
    expect(conUnAltro180).toContain('> (180)::numeric')
    expect(await prova(conUnAltro180)).toBe(false)
  })

  it('il riconoscimento guarda il LIMITE nella definizione: un tetto di 1800 non è «quello a 180»', async () => {
    const conn = await costruisci({ conC: false })
    try {
      await impostaTetto(conn, 1800)
      const prima = await definizione(conn)
      await conn.exec(MIGRAZIONE_A)
      const dopo = await definizione(conn)
      expect(dopo.def).toMatch(/<= \(1800\)::numeric/)
      expect(dopo.oid).toBe(prima.oid)
    } finally {
      await conn.close()
    }
  }, 60_000)
})

// ─────────────────────────────────────────────────────────────────────────────
// 12 · APPLICAZIONE RIPETUTA E DATI DELLA PRODUZIONE
// ─────────────────────────────────────────────────────────────────────────────

/** Una fotografia del catalogo delle tre tabelle video e di tutte le funzioni `video_*`. */
async function fotografia(conn: PGlite): Promise<Record<string, unknown[]>> {
  return {
    funzioni: await righe(`
      SELECT p.proname, pg_get_functiondef(p.oid) AS def, p.proacl::text AS acl, p.prosecdef, p.proconfig::text AS config,
             obj_description(p.oid, 'pg_proc') AS commento
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname LIKE 'video\\_%' ORDER BY p.proname, pg_get_function_identity_arguments(p.oid)
    `, conn),
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
  it('applicata DUE volte di fila (anche tre) non cambia niente: funzioni, commenti, ACL, vincoli (stessi OID), indici, colonne, dati', async () => {
    const conn = await costruisci()
    try {
      // Dei dati che il file ha già toccato: un intento minimizzato, uno annullato, un'uscita con la scadenza.
      await semina({ stato: 'cancelled', automatico: true, tag: [A1], giorni: 9, job: { stato: 'cancelled', uscita: true } }, conn)
      await semina({ canale: 'news', job: { stato: 'failed', uscita: true } }, conn)
      await rpc(`public.video_retention_scadenze(48, 168, 100)`, conn)
      await rpc(`public.video_intenti_minimizza(7, 100)`, conn)

      const datiPrima = {
        intenti: await righe(`SELECT * FROM public.video_intents ORDER BY id`, conn),
        job: await righe(`SELECT * FROM public.video_jobs ORDER BY id`, conn),
        outbox: await conta('public.video_outbox', conn),
      }
      const prima = await fotografia(conn)

      await conn.exec(MIGRAZIONE_C)
      await conn.exec(MIGRAZIONE_C)

      expect(await fotografia(conn)).toEqual(prima)
      expect({
        intenti: await righe(`SELECT * FROM public.video_intents ORDER BY id`, conn),
        job: await righe(`SELECT * FROM public.video_jobs ORDER BY id`, conn),
        outbox: await conta('public.video_outbox', conn),
      }).toEqual(datiPrima)
      // Il solo segno delle riapplicazioni è il log di successo: uno per applicazione (la prima + due).
      expect(await contestiLoggati('video-conservazione-uscite-migration', conn)).toHaveLength(3)
      expect((await contestiLoggati('video-conservazione-uscite-migration', conn))[0]).toEqual({
        rpc_nuove: 6, rpc_riscritte: 2, conteggi_nuovi: 6,
      })
    } finally {
      await conn.close()
    }
  }, 60_000)

  it('RETROCOMPATIBILE: il file C applicato, il codice vecchio chiama le stesse firme e riceve le stesse chiavi di prima (più le nuove)', async () => {
    const conn = await costruisci()
    try {
      // Come la route di oggi: `video_retention_scadenze(p_ore_upload, p_ore_incaglio, p_limite)` e
      // `video_riconciliazione(p_ore_upload, p_ore_incaglio, p_ore_ritardo)`, per nome.
      const scadenze = await rpc<Risposta>(
        `public.video_retention_scadenze(p_ore_upload => 48, p_ore_incaglio => 168, p_limite => 100)`, conn,
      )
      for (const chiave of ['abbandonati', 'incagliati', 'senza_scadenza']) expect(scadenze, chiave).toHaveProperty(chiave)
      const conti = await rpc<Risposta>(
        `public.video_riconciliazione(p_ore_upload => 48, p_ore_incaglio => 168, p_ore_ritardo => 1)`, conn,
      )
      for (const chiave of ['conclusi_senza_scadenza', 'outbox_in_quarantena', 'originali_da_togliere', 'output_di_job_conclusi']) {
        expect(conti, chiave).toHaveProperty(chiave)
      }
      // E il claim a tre argomenti, per nome, come lo chiama PostgREST oggi.
      expect(
        await rpc(`public.video_outbox_claim(p_lease_owner => '${LEASE_A}', p_lease_seconds => 120, p_limite => 25)`, conn),
      ).toEqual({ ok: true, eventi: [] })
    } finally {
      await conn.close()
    }
  }, 60_000)

  it('su un database con le righe della PRODUZIONE (PR 1 applicata, nessun file della PR 2): le 39 + 11 uscite e gli 11 convertiti mai pubblicati escono al primo giro', async () => {
    // Lo stato misurato il 01/10 (solo conteggi), scritto con le colonne di PRIMA del file A: 39 uscite di
    // video già pubblicati (copie doppie), 11 di job annullati, 11 `ready` mai pubblicati dal flusso vecchio.
    const conn = await costruisci({ conA: false, conC: false })
    try {
      const vecchio = async (stato: 'published' | 'confirmed' | 'cancelled', statoJob: 'ready' | 'cancelled', n: number) => {
        for (let i = 0; i < n; i++) {
          const intentId = randomUUID()
          const jobId = randomUUID()
          const pubblicato = stato === 'published'
          await conn.exec(`
            INSERT INTO public.video_intents (id, owner_id, scuola_id, channel, requested_action, payload, status, confirmed_at, revoked_at, published_at)
            VALUES ('${intentId}', '${OWNER}', '${SEDE}', 'gallery', 'publish', '{"scope":"sede"}', '${stato}',
              ${stato === 'cancelled' ? 'NULL' : 'now()'}, ${stato === 'cancelled' ? 'now()' : 'NULL'}, ${pubblicato ? 'now()' : 'NULL'});
            INSERT INTO public.video_jobs (id, owner_id, scuola_id, channel, idempotency_key, intent_id, status, original_path,
              source_size, source_mime, output_bucket, output_path, output_size, probe_json, verified_at, original_delete_after)
            VALUES ('${jobId}', '${OWNER}', '${SEDE}', 'gallery', 'k-${jobId}', '${intentId}', '${statoJob}', 'originals/${jobId}/s',
              5000, 'video/mp4', 'video_processing', 'outputs/${jobId}/f.mp4', 900,
              ${statoJob === 'ready' ? `'{"durationSeconds":20}'::jsonb, now() - interval '30 days', now() - interval '23 days'` : `NULL, NULL, now()`});
          `)
        }
      }
      await vecchio('published', 'ready', 39)
      await vecchio('cancelled', 'cancelled', 11)
      await vecchio('confirmed', 'ready', 11)
      expect(await conta('public.video_jobs', conn)).toBe(61)

      await conn.exec(MIGRAZIONE_A)
      await conn.exec(MIGRAZIONE_C)

      // PRIMA del primo giro: tutto da fare.
      expect(await rpc<Risposta>('public.video_riconciliazione(48, 168, 1)', conn)).toMatchObject({
        uscite_senza_scadenza: 50, // le 39 pubblicate e le 11 annullate; le 11 `ready` non pubblicate aspettano la revoca
        uscite_da_togliere: 0,
        flusso_vecchio_in_volo: 11,
      })

      // I due passi della purga, nell'ordine in cui li fa T13.
      expect(await rpc(`public.video_galleria_flusso_vecchio_revoca(100)`, conn)).toEqual({ ok: true, revocati: 11, rifiutati: 0 })
      expect(await rpc(`public.video_retention_scadenze(48, 168, 100)`, conn)).toMatchObject({ ok: true, uscite_senza_scadenza: 50 })

      // DOPO: tutte e 61 le uscite hanno la data e sono da togliere; il flusso vecchio non c'è più.
      expect(await rpc<Risposta>('public.video_riconciliazione(48, 168, 1)', conn)).toMatchObject({
        uscite_senza_scadenza: 0,
        uscite_da_togliere: 61,
        flusso_vecchio_in_volo: 0,
      })
      // E un secondo giro non trova più niente.
      expect(await rpc(`public.video_galleria_flusso_vecchio_revoca(100)`, conn)).toEqual({ ok: true, revocati: 0, rifiutati: 0 })
      expect(await rpc(`public.video_retention_scadenze(48, 168, 100)`, conn)).toMatchObject({ uscite_senza_scadenza: 0 })

      // Le righe vecchie hanno i default che le lasciano com'erano; nessun bambino è comparso.
      expect(await conta(`public.video_intents WHERE cardinality(tag_alunni) > 0`, conn)).toBe(0)
    } finally {
      await conn.close()
    }
  }, 120_000)
})
