// @vitest-environment node

/**
 * L'ARRIVO DELL'ORIGINALE — il file B della PR 2 (T2b), provato sul file di migrazione VERO.
 *
 * Stesso impianto di `video-pubblicazione-automatica-rpc.test.ts`: PGlite, i ruoli di Supabase
 * ricostruiti a mano e le migrazioni lette DAL DISCO nell'ordine in cui la produzione le applica
 * (le sette già in produzione, il file A, poi questo). In più uno schema `storage` FINTO ma fedele
 * dove serve: la tabella `storage.objects` con l'indice sul nome (l'`upsert` dello Storage è
 * un `INSERT … ON CONFLICT DO UPDATE`), i due trigger che la produzione ha già — quello che
 * aggiorna `updated_at` e quello che rifiuta ogni `DELETE` (42501, a livello di STATEMENT) — e il
 * trigger della migrazione da provare. Un test che ripete l'SQL dentro di sé prova la propria copia.
 *
 * ─── COME SI TROVA LA MIGRAZIONE ─────────────────────────────────────────────────────────
 *
 * Per SUFFISSO (`_video_arrivo_originale.sql`): nasce con un timestamp provvisorio e T16 la rinomina
 * all'istante vero. Un test che ne conoscesse il nome intero si romperebbe proprio in quel momento.
 *
 * ─── COSA QUESTO FILE PROVA ──────────────────────────────────────────────────────────────
 *
 * I quattro casi della spec §5.4 (arrivo, dimensione diversa, risorto, sostituito) e i loro bordi;
 * che `video_job_uploaded` chiamata due volte (trigger + PATCH del web) resti idempotente; che
 * un'eccezione in QUALUNQUE punto del trigger lasci l'INSERT dell'oggetto riuscito e il job com'era
 * (le scritture del blocco si annullano), senza mai mettere nel log il messaggio di Postgres; la
 * rete (`video_arrivi_recupera`); l'installazione (senza `storage.objects`, senza il privilegio,
 * due volte di fila); e l'INTERRUTTORE D'EMERGENZA, eseguendo davvero le righe che la testata
 * della migrazione dice di incollare.
 *
 * ─── COSA NON PROVA, detto qui e non in fondo ────────────────────────────────────────────
 *
 * PGlite è a CONNESSIONE SINGOLA: due transazioni davvero simultanee qui non si possono avere. Il
 * lock di riga e il `lock_timeout` si verificano sul TESTO e sugli attributi della funzione
 * (`proconfig`), non su un'attesa vera. E non c'è il vero `supabase_storage_admin`: il fatto che
 * `postgres` abbia il privilegio TRIGGER su `storage.objects` senza esserne il proprietario è una
 * misura fatta sul database della CI (spec §3), che T16 ripete in produzione.
 *
 * L'OROLOGIO si muove con degli UPDATE sulle colonne, mai con uno `sleep`.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
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

// Le migrazioni già in produzione, nell'ordine di applicazione.
const SCHEMA = leggi('20260916190000_video_jobs.sql')
const TRANSIZIONI = leggi('20260916190100_video_job_transitions.sql')
const INTENTI = leggi('20260916190200_video_intent_lifecycle.sql')
const NEXT = leggi('20260917210000_video_job_next.sql')
const RETENTION = leggi('20260918110000_video_retention_riconciliazione.sql')
const BUCKET = leggi(trovaPerSuffisso('_video_build_bucket.sql'))
const RITENTATIVI = leggi(trovaPerSuffisso('_video_job_ritentativi.sql'))
// Quelle di questa PR: il file A (le colonne e le RPC che il file B usa) e il file B.
const FILE_A = trovaPerSuffisso('_video_pubblicazione_automatica.sql')
const MIGRAZIONE_A = leggi(FILE_A)
const FILE_B = trovaPerSuffisso('_video_arrivo_originale.sql')
const MIGRAZIONE_B = leggi(FILE_B)

const SEDE = '10000000-0000-4000-8000-000000000001'
const OWNER = '20000000-0000-4000-8000-000000000002'
const A1 = 'a1000000-0000-4000-8000-0000000000a1'
const A2 = 'a2000000-0000-4000-8000-0000000000a2'
const LEASE_A = '50000000-0000-4000-8000-000000000005'

type Riga = Record<string, unknown>
type Risposta = { ok: boolean; code?: string; esito?: string; job_id?: string; [chiave: string]: unknown }

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

/** Lo schema `storage` com'è in produzione per ciò che interessa: la tabella e i due trigger che ha già. */
const STORAGE_OBJECTS_FINTO = `
  CREATE TABLE storage.objects (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    bucket_id text NOT NULL REFERENCES storage.buckets(id),
    name text NOT NULL,
    owner uuid,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now(),
    last_accessed_at timestamptz DEFAULT now(),
    metadata jsonb
  );
  CREATE UNIQUE INDEX bucketid_objname ON storage.objects (bucket_id, name);

  CREATE FUNCTION storage.update_updated_at_column() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN NEW.updated_at = now(); RETURN NEW; END $$;
  CREATE TRIGGER update_objects_updated_at BEFORE UPDATE ON storage.objects
    FOR EACH ROW EXECUTE FUNCTION storage.update_updated_at_column();

  CREATE FUNCTION storage.protect_delete() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    RAISE EXCEPTION 'Direct deletion from storage tables is not allowed. Use the Storage API instead.'
      USING ERRCODE = '42501';
  END $$;
  CREATE TRIGGER protect_objects_delete BEFORE DELETE ON storage.objects
    FOR EACH STATEMENT EXECUTE FUNCTION storage.protect_delete();
`

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

    -- La galleria com'è in produzione per ciò che serve a video_galleria_pubblica.
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
    INSERT INTO auth.users(id) VALUES ('${OWNER}');
    INSERT INTO public.utenti(id, scuola_id) VALUES ('${OWNER}', '${SEDE}');
  `)
}

/**
 * Un database completo: lo stub, la produzione, il file A e (di default) il file B.
 * `storage: false` toglie la tabella `storage.objects` (il database della CI, PGlite); `conB: false`
 * lascia il file B da applicare a mano (le prove di installazione).
 */
async function costruisci(opzioni: { storage?: boolean; conB?: boolean } = {}): Promise<PGlite> {
  const conn = new PGlite()
  await preparaStub(conn)
  await conn.exec(SCHEMA)
  await conn.exec(TRANSIZIONI)
  await conn.exec(INTENTI)
  await conn.exec(NEXT)
  await conn.exec(RETENTION)
  await conn.exec(BUCKET)
  await conn.exec(RITENTATIVI)
  await conn.exec(MIGRAZIONE_A)
  if (opzioni.storage ?? true) await conn.exec(STORAGE_OBJECTS_FINTO)
  if (opzioni.conB ?? true) await conn.exec(MIGRAZIONE_B)
  return conn
}

/** Lo svuotamento fra una prova e l'altra: tabelle del dominio, oggetti e log, nello stesso comando (le FK). */
async function svuota(conn: PGlite = db) {
  await conn.exec(`
    TRUNCATE public.video_outbox, public.video_jobs, public.video_intents,
             public.galleria_media_v2, public.log_migrazioni, storage.objects
  `)
}

beforeAll(async () => {
  db = await costruisci()
}, 120_000)

afterAll(async () => {
  await db.close()
})

/**
 * Una prova che PROVOCA un'eccezione nel trigger lo dichiara: tutte le altre pretendono che non ce ne
 * sia stata nessuna. È la rete che manca a un test sul trigger fail-open: un trigger che ingoia ogni
 * errore rende verde anche un test sbagliato, e l'unico segno che qualcosa è esploso è nel log.
 */
let attendoEccezioni = false

beforeEach(async () => {
  attendoEccezioni = false
  await svuota()
})

afterEach(async () => {
  if (attendoEccezioni) return
  const eccezioni = await righe<{ evento: string; code: string | null }>(`
    SELECT payload -> 0 ->> 'evento' AS evento, payload -> 0 -> 'contesto' ->> 'code' AS code
    FROM public.log_migrazioni
    WHERE payload -> 0 ->> 'evento' IN ('video-arrivo-trigger-eccezione', 'video-arrivo-giro-eccezione')
  `)
  expect(
    eccezioni,
    'Il trigger (o il giro) ha INGOIATO un\'eccezione in una prova che non la prevedeva: un trigger fail-open ' +
      'rende verde anche un passo che esplode, e questo è l\'unico segno.',
  ).toEqual([])
})

// ─────────────────────────────────────────────────────────────────────────────
// I MATTONI DEI TEST
// ─────────────────────────────────────────────────────────────────────────────

const percorsoDi = (chiave: string): string => `${OWNER}/${chiave}.mp4`

/** 32 byte deterministici come espressione SQL: lo SHA-256 di un seme. */
const impronta = (seme: string): string => `sha256(convert_to('${seme}', 'UTF8'))`

type Aperto = { intentId: string; jobId: string; percorso: string }

/**
 * Un intento di galleria aperto da `video_galleria_intent_apri`, con i suoi byte e il suo mime
 * dichiarati. `put-nativo` porta lo SHA-256 e un token che vale 48 ore (il seme lo distingue).
 */
async function apriGalleria(
  chiave: string,
  opz: { byte?: number; mime?: string; trasporto?: 'tus' | 'put-nativo'; seme?: string } = {},
  conn: PGlite = db,
): Promise<Aperto & { hashToken: string }> {
  const nativo = opz.trasporto === 'put-nativo'
  const seme = opz.seme ?? `token-${chiave}`
  const percorso = percorsoDi(chiave)
  const r = await rpc<{
    ok: boolean
    code?: string
    intent?: { id: string }
    job?: { id: string }
  }>(
    `public.video_galleria_intent_apri(
      '${OWNER}', '${SEDE}', '${chiave}', '${percorso}', ${opz.byte ?? 5000}, '${opz.mime ?? 'video/mp4'}', 20,
      ARRAY['${A1}', '${A2}']::uuid[], false, NULL::text[], '${opz.trasporto ?? 'tus'}',
      ${nativo ? impronta('contenuto') : 'NULL::bytea'}, ${nativo ? impronta(seme) : 'NULL::bytea'},
      ${nativo ? `clock_timestamp() + interval '48 hours'` : 'NULL::timestamptz'}
    )`,
    conn,
  )
  expect(r.ok, `l'apertura di ${chiave} doveva riuscire: ${JSON.stringify(r)}`).toBe(true)
  return { intentId: r.intent!.id, jobId: r.job!.id, percorso, hashToken: impronta(seme) }
}

/** Un job News (intento `pending`, nessun byte né mime dichiarato): è il flusso che oggi non li ha. */
async function apriNews(chiave: string, conn: PGlite = db): Promise<Aperto> {
  const percorso = percorsoDi(chiave)
  const r = await rpc<{ ok: boolean; intent?: { id: string }; job?: { id: string } }>(
    `public.video_intent_open('${OWNER}', '${SEDE}', 'news', 'publish', '{"scope":"sede"}'::jsonb,
      '${chiave}', '${percorso}', NULL, NULL)`,
    conn,
  )
  expect(r.ok, `l'apertura della News ${chiave} doveva riuscire`).toBe(true)
  return { intentId: r.intent!.id, jobId: r.job!.id, percorso }
}

type Meta = { size?: number | null; mime?: string | null; etag?: string | null; extra?: Record<string, unknown> }

/** I metadati come li scrive lo Storage: eTag con le virgolette dentro, size numerico, mimetype. */
function metadati(m: Meta): string {
  const o: Record<string, unknown> = {
    cacheControl: 'max-age=3600',
    lastModified: new Date().toISOString(),
    httpStatusCode: 200,
  }
  if (m.etag !== null) o.eTag = m.etag ?? '"e1"'
  if (m.size !== null) {
    o.size = m.size ?? 5000
    o.contentLength = m.size ?? 5000
  }
  if (m.mime !== null) o.mimetype = m.mime ?? 'video/mp4'
  return JSON.stringify({ ...o, ...(m.extra ?? {}) })
}

/**
 * Deposita (o RIDEPOSITA) un oggetto: è l'`upsert` dello Storage, un `INSERT … ON CONFLICT DO UPDATE`.
 * Se il nome c'è già, a scattare è il ramo UPDATE del trigger.
 */
async function deposita(percorso: string, m: Meta = {}, bucket = 'video_originals', conn: PGlite = db) {
  await conn.query(
    `INSERT INTO storage.objects(bucket_id, name, metadata) VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (bucket_id, name) DO UPDATE SET metadata = EXCLUDED.metadata`,
    [bucket, percorso, metadati(m)],
  )
}

type RigaJob = {
  status: string
  error_code: string | null
  source_size: number | null
  source_mime: string | null
  arrivato: boolean
  sorgente_etag: string | null
  token_revocato: boolean
  fence_epoch: number
  lease_owner: string | null
  lease_expires_at: string | null
  scadenza_originale_passata: boolean | null
  scadenza_originale: string | null
  originale_timbrato: boolean
  output_path: string | null
  scadenza_uscita_passata: boolean | null
  aggiornato: string
}

/** Lo stato di un job, con gli istanti ridotti a booleani (mai un orologio nei confronti). */
const job = (id: string, conn: PGlite = db) =>
  unaRiga<RigaJob>(
    `SELECT status, error_code, source_size, source_mime,
            arrivato_il IS NOT NULL AS arrivato,
            sorgente_etag,
            rinnovo_token_revocato_il IS NOT NULL AS token_revocato,
            fence_epoch, lease_owner, lease_expires_at::text AS lease_expires_at,
            original_delete_after <= clock_timestamp() AS scadenza_originale_passata,
            original_delete_after::text AS scadenza_originale,
            original_deleted_at IS NOT NULL AS originale_timbrato,
            output_path,
            output_delete_after <= clock_timestamp() AS scadenza_uscita_passata,
            updated_at::text AS aggiornato
     FROM public.video_jobs WHERE id = '${id}'`,
    conn,
  )

/** I log di un evento, nell'ordine in cui sono stati scritti. */
async function eventi(
  evento: string,
  conn: PGlite = db,
): Promise<Array<{ livello: string; code: string | null; contesto: Record<string, unknown> }>> {
  return righe(
    `SELECT payload -> 0 ->> 'livello' AS livello,
            payload -> 0 -> 'contesto' ->> 'code' AS code,
            payload -> 0 -> 'contesto' AS contesto
     FROM public.log_migrazioni
     WHERE payload -> 0 ->> 'evento' = '${evento}'
     ORDER BY ctid`,
    conn,
  )
}

const conta = async (sql: string, conn: PGlite = db): Promise<number> =>
  (await unaRiga<{ n: number }>(`SELECT count(*)::int AS n FROM ${sql}`, conn)).n

const contaOggetti = (conn: PGlite = db) => conta('storage.objects', conn)

/** Tutto ciò che è stato loggato, come un testo solo: per cercarci dentro ciò che NON deve esserci. */
async function tuttoIlLog(conn: PGlite = db): Promise<string> {
  const { rows } = await conn.query<{ t: string }>(
    `SELECT coalesce(string_agg(payload::text, ' '), '') AS t FROM public.log_migrazioni`,
  )
  return rows[0].t
}

/** Quante righe di log ci sono: per provare che un evento NON ha scritto niente. */
const righeDiLog = (conn: PGlite = db) => conta('public.log_migrazioni', conn)

/** Il job entra in `processing` con una lease e il fence 1 (come lo prende il runner). */
async function prendi(jobId: string, conn: PGlite = db) {
  const preso = await rpc(`public.video_job_claim('${jobId}', '${LEASE_A}', 300)`, conn)
  expect(preso.ok, `la presa doveva riuscire: ${JSON.stringify(preso)}`).toBe(true)
}

/** …e poi `ready`, con la sua uscita: il job di un'uscita pronta da pubblicare. */
async function portaAReady(jobId: string, conn: PGlite = db) {
  await prendi(jobId, conn)
  const pronto = await rpc(
    `public.video_job_ready('${jobId}', 1, '${LEASE_A}', 'outputs/${jobId}/final.mp4', 900,
      '{"durationSeconds":20}'::jsonb)`,
    conn,
  )
  expect(pronto.ok, `ready: ${JSON.stringify(pronto)}`).toBe(true)
}

/** Una transazione che si butta: le prove che sostituiscono funzioni o cambiano lo schema non toccano il database condiviso. */
async function inUnaTransazioneDaButtare(corpo: () => Promise<void>, conn: PGlite = db) {
  await conn.exec('BEGIN')
  try {
    await corpo()
  } finally {
    await conn.exec('ROLLBACK')
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 0 · IL FINTO STORAGE È FEDELE (senza questo, «nessuna DELETE» sarebbe verde sul vuoto)
// ─────────────────────────────────────────────────────────────────────────────

describe('lo schema storage finto', () => {
  it('rifiuta ogni DELETE come fa quello vero (42501, anche a zero righe): la prova che il file non ne fa è una prova', async () => {
    await expect(db.exec(`DELETE FROM storage.objects WHERE false`)).rejects.toThrow(/Direct deletion/)
  })

  it('il trigger della migrazione è installato UNA volta, su video_originals, con la forma della spec', async () => {
    const trigger = await righe<{ nome: string; def: string; abilitato: string }>(`
      SELECT tgname AS nome, pg_get_triggerdef(oid) AS def, tgenabled AS abilitato
      FROM pg_trigger
      WHERE tgrelid = 'storage.objects'::regclass AND NOT tgisinternal AND tgname = 'trg_video_originale_arrivato'
    `)
    expect(trigger).toHaveLength(1)
    expect(trigger[0].abilitato, 'abilitato («O»: origin)').toBe('O')
    expect(trigger[0].def).toMatch(/AFTER INSERT OR UPDATE OF metadata ON storage\.objects/)
    expect(trigger[0].def).toMatch(/FOR EACH ROW/)
    expect(trigger[0].def).toMatch(/WHEN \(\(new\.bucket_id = 'video_originals'::text\)\)/)
    // E i due trigger che la produzione ha già non sono stati toccati.
    const altri = await righe<{ nome: string }>(`
      SELECT tgname AS nome FROM pg_trigger
      WHERE tgrelid = 'storage.objects'::regclass AND NOT tgisinternal AND tgname <> 'trg_video_originale_arrivato'
      ORDER BY 1
    `)
    expect(altri.map((t) => t.nome)).toEqual(['protect_objects_delete', 'update_objects_updated_at'])
  })

  it('le tre funzioni hanno gli attributi della spec: SECURITY DEFINER, search_path = pg_catalog, lock_timeout 2 s (le due che girano su un lock)', async () => {
    const f = await righe<{ nome: string; definer: boolean; config: string[] | null }>(`
      SELECT p.proname AS nome, p.prosecdef AS definer, p.proconfig AS config
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname IN ('video_originale_arrivato', '_video_originale_applica', 'video_arrivi_recupera')
      ORDER BY 1
    `)
    expect(f.map((x) => x.nome)).toEqual(['_video_originale_applica', 'video_arrivi_recupera', 'video_originale_arrivato'])
    for (const x of f) {
      expect(x.definer, `${x.nome} deve essere SECURITY DEFINER`).toBe(true)
      expect(x.config, `${x.nome}: search_path`).toContain('search_path=pg_catalog')
    }
    const config = Object.fromEntries(f.map((x) => [x.nome, x.config]))
    // Il trigger e la rete hanno il `lock_timeout`: un lock che non si libera diventa un'eccezione
    // (fail-open) invece di tenere ferma l'API Storage. Il corpo condiviso lo eredita da chi lo chiama.
    expect(config.video_originale_arrivato).toContain('lock_timeout=2s')
    expect(config.video_arrivi_recupera).toContain('lock_timeout=2s')
  })

  it('i privilegi: nessuno la chiama oltre al giro del runner (anon e authenticated mai; service_role solo la rete)', async () => {
    const p = await righe<{ nome: string; anon: boolean; authenticated: boolean; service_role: boolean }>(`
      SELECT p.proname AS nome,
             has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
             has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname IN ('video_originale_arrivato', '_video_originale_applica', 'video_arrivi_recupera')
      ORDER BY 1
    `)
    expect(p).toEqual([
      { nome: '_video_originale_applica', anon: false, authenticated: false, service_role: false },
      { nome: 'video_arrivi_recupera', anon: false, authenticated: false, service_role: true },
      { nome: 'video_originale_arrivato', anon: false, authenticated: false, service_role: false },
    ])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 1 · L'ARRIVO REGOLARE
// ─────────────────────────────────────────────────────────────────────────────

describe('arrivo regolare · il job entra in coda da solo', () => {
  it('galleria `tus`: queued, byte e mime sul job, istante e eTag dell\'arrivo, nessun PATCH', async () => {
    const { jobId, percorso } = await apriGalleria('tus-1')
    expect((await job(jobId)).status).toBe('awaiting_upload')

    await deposita(percorso, { size: 5000, mime: 'video/mp4', etag: '"e1"' })

    expect(await job(jobId)).toMatchObject({
      status: 'queued',
      source_size: 5000,
      source_mime: 'video/mp4',
      arrivato: true,
      sorgente_etag: '"e1"',
      // Un job `tus` non ha un token: non c'è niente da revocare, e una data di revoca senza un
      // token racconterebbe una cosa che non è successa.
      token_revocato: false,
      fence_epoch: 0,
    })
    // E il runner può prenderlo: è un job in coda come un altro.
    expect((await rpc(`public.video_job_claim('${jobId}', '${LEASE_A}', 300)`)).ok).toBe(true)
  })

  it('caricamento NATIVO: il token si revoca all\'arrivo, e `video_rinnovo_usa` dice «arrivato»', async () => {
    const { jobId, percorso, hashToken } = await apriGalleria('nat-1', { trasporto: 'put-nativo' })
    expect(await rpc(`public.video_rinnovo_usa(${hashToken})`)).toMatchObject({ ok: true, stato: 'da-caricare' })
    expect((await job(jobId)).token_revocato).toBe(false)

    await deposita(percorso, { size: 5000, mime: 'video/mp4' })

    expect(await job(jobId)).toMatchObject({ status: 'queued', arrivato: true, token_revocato: true })
    // Il token revocato PERCHÉ il file è arrivato risponde lo stato, non un nuovo indirizzo: è ciò che
    // permette al 409 di una seconda PUT di sapere che il file c'è.
    expect(await rpc(`public.video_rinnovo_usa(${hashToken})`)).toEqual({ ok: true, stato: 'arrivato' })
  })

  it('una News (nessun byte né mime dichiarato) prende dimensione e mime dai metadati, ridotti al contenitore', async () => {
    const { jobId, percorso } = await apriNews('news-1')
    await deposita(percorso, { size: 7777, mime: 'Video/MP4;codecs=avc1.42E01E,mp4a.40.2', etag: '"n1"' })
    expect(await job(jobId)).toMatchObject({
      status: 'queued',
      source_size: 7777,
      // È la regola di `mimeBase` in TypeScript: minuscolo, senza i parametri del produttore.
      source_mime: 'video/mp4',
      sorgente_etag: '"n1"',
    })
  })

  it('il mime DICHIARATO vince su quello dei metadati', async () => {
    const { jobId, percorso } = await apriGalleria('mime-1', { mime: 'video/quicktime' })
    await deposita(percorso, { size: 5000, mime: 'video/mp4' })
    expect((await job(jobId)).source_mime).toBe('video/quicktime')
  })

  it('senza eTag nei metadati l\'arrivo riesce lo stesso (il riferimento resta vuoto)', async () => {
    const { jobId, percorso } = await apriGalleria('senza-etag')
    await deposita(percorso, { size: 5000, etag: null })
    expect(await job(jobId)).toMatchObject({ status: 'queued', arrivato: true, sorgente_etag: null })
  })

  it('il log dell\'arrivo: info, origine «trigger», solo uuid e numeri — mai il percorso, l\'eTag, il proprietario', async () => {
    const { jobId, intentId, percorso } = await apriGalleria('log-1')
    await deposita(percorso, { size: 5000, etag: '"eTag-segreto-xyz"' })

    const [arrivo] = await eventi('video-originale-arrivato')
    expect(arrivo.livello).toBe('info')
    expect(arrivo.contesto).toMatchObject({
      job_id: jobId,
      intent_id: intentId,
      origine: 'trigger',
      byte: 5000,
      trasporto: 'tus',
    })
    expect(typeof arrivo.contesto.secondi_dall_apertura).toBe('number')

    const log = await tuttoIlLog()
    expect(log).not.toContain('eTag-segreto-xyz')
    expect(log).not.toContain(OWNER)
    expect(log).not.toContain('.mp4')
  })

  it('un job senza `byte_dichiarati` non ha il controllo sulla dimensione (qualunque dimensione arriva)', async () => {
    const { jobId, percorso } = await apriNews('news-qualsiasi')
    await deposita(percorso, { size: 1 })
    expect(await job(jobId)).toMatchObject({ status: 'queued', source_size: 1 })
  })

  it('metadati SENZA dimensione: il job resta in attesa, un `warn` lo dice, e l\'evento dopo (con la dimensione) lo porta in coda', async () => {
    const { jobId, percorso } = await apriGalleria('incompleto-1')
    await deposita(percorso, { size: null })
    expect((await job(jobId)).status).toBe('awaiting_upload')
    expect(await eventi('video-originale-incompleto')).toMatchObject([
      { livello: 'warn', contesto: { job_id: jobId, manca: 'dimensione', origine: 'trigger' } },
    ])
    // Un secondo evento sullo stesso oggetto (Storage che completa i metadati): è l'UPDATE a scattare.
    await deposita(percorso, { size: 5000 })
    expect((await job(jobId)).status).toBe('queued')
  })

  it('una News senza mime né nei metadati né dichiarato resta in attesa (non si inventa un mime)', async () => {
    const { jobId, percorso } = await apriNews('news-senza-mime')
    await deposita(percorso, { size: 5000, mime: null })
    expect((await job(jobId)).status).toBe('awaiting_upload')
    expect(await eventi('video-originale-incompleto')).toMatchObject([{ livello: 'warn', contesto: { manca: 'mime' } }])
  })

  it('un size scritto come non-intero (testo, decimale, negativo) non vale come dimensione: usa contentLength, se numerico', async () => {
    const { jobId, percorso } = await apriGalleria('size-strano')
    await deposita(percorso, { size: null, extra: { size: '5000.5', contentLength: 5000 } })
    expect(await job(jobId)).toMatchObject({ status: 'queued', source_size: 5000 })
  })
})

describe('il trigger riguarda solo video_originals, e solo i metadati', () => {
  it('un oggetto di un ALTRO bucket con lo stesso nome non tocca il job né scrive niente nel log', async () => {
    await db.exec(`INSERT INTO storage.buckets(id, name) VALUES ('gallery', 'gallery') ON CONFLICT (id) DO NOTHING`)
    const { jobId, percorso } = await apriGalleria('altro-bucket')
    const prima = await righeDiLog()
    await deposita(percorso, { size: 5000 }, 'gallery')
    expect((await job(jobId)).status).toBe('awaiting_upload')
    expect(await righeDiLog(), 'la clausola WHEN: gli altri bucket non vedono nemmeno la chiamata').toBe(prima)
  })

  it('un UPDATE che non nomina `metadata` (Storage che tocca updated_at) non fa scattare niente', async () => {
    const { jobId, percorso } = await apriGalleria('solo-updated')
    await deposita(percorso, { size: 5000 })
    const prima = await righeDiLog()
    await db.exec(`UPDATE storage.objects SET last_accessed_at = now() WHERE bucket_id = 'video_originals'`)
    expect(await righeDiLog()).toBe(prima)
    expect((await job(jobId)).status).toBe('queued')
  })

  it('un oggetto senza job: l\'INSERT riesce, un `info` lo dice, nessuna eccezione', async () => {
    await deposita(`${OWNER}/orfano.mp4`, { size: 5000 })
    expect(await contaOggetti()).toBe(1)
    expect(await eventi('video-originale-senza-job')).toMatchObject([{ livello: 'info', contesto: { origine: 'trigger' } }])
  })
})

describe('arrivo regolare · il runner parte subito (video_runner_kick)', () => {
  /** Un finto `pg_net` e un finto `cron_config`: lo stub non ha né l'uno né l'altro. Dentro una transazione da buttare. */
  const conPgNet = async () => {
    await db.exec(`
      CREATE SCHEMA net;
      CREATE TABLE net.chiamate (ordine serial PRIMARY KEY, url text, body jsonb, headers jsonb);
      CREATE FUNCTION net.http_post(
        url text, body jsonb DEFAULT '{}'::jsonb, params jsonb DEFAULT '{}'::jsonb,
        headers jsonb DEFAULT '{"Content-Type": "application/json"}'::jsonb, timeout_milliseconds integer DEFAULT 5000
      ) RETURNS bigint LANGUAGE plpgsql AS $$
      BEGIN INSERT INTO net.chiamate(url, body, headers) VALUES (url, body, headers); RETURN 1; END $$;
      CREATE TABLE public.cron_finto (nome text PRIMARY KEY, valore text);
      CREATE FUNCTION public.cron_config(p_nome text) RETURNS text LANGUAGE sql AS $$
        SELECT valore FROM public.cron_finto WHERE nome = p_nome $$;
      INSERT INTO public.cron_finto VALUES ('app.push_dispatch_url', 'https://app.esempio.test/api/push/dispatch'),
                                           ('app.cron_secret', 'segreto-di-prova-123');
    `)
  }
  const chiamate = () => righe<{ url: string; body: { job_id?: string } }>(`SELECT url, body FROM net.chiamate ORDER BY ordine`)

  it('chiama POST /api/video/runner con {job_id}: una volta per arrivo, e il segreto non è nel log', async () => {
    await inUnaTransazioneDaButtare(async () => {
      await conPgNet()
      const { jobId, percorso } = await apriGalleria('kick-1')
      await deposita(percorso, { size: 5000 })
      expect(await chiamate()).toEqual([{ url: 'https://app.esempio.test/api/video/runner', body: { job_id: jobId } }])
      expect(await tuttoIlLog()).not.toContain('segreto-di-prova-123')
      // Un evento sullo stesso oggetto (stesso eTag) non rilancia il runner.
      await deposita(percorso, { size: 5000 })
      expect(await chiamate()).toHaveLength(1)
    })
  })

  it('senza pg_net (il database della CI) il calcio non fa niente e lo scrive nel log: l\'arrivo riesce lo stesso', async () => {
    const { jobId, percorso } = await apriGalleria('kick-senza-net')
    await deposita(percorso, { size: 5000 })
    expect((await job(jobId)).status).toBe('queued')
    const kick = await eventi('video-runner-kick')
    expect(kick).toHaveLength(1)
    expect(kick[0].code).toBe('PG_NET_ASSENTE')
    expect(kick[0].contesto).toMatchObject({ job_id: jobId })
  })

  it('un calcio che SOLLEVA (non dovrebbe: ma un guasto di pg_net o del Vault c\'è già stato) non riporta indietro l\'arrivo', async () => {
    await inUnaTransazioneDaButtare(async () => {
      await db.exec(`
        CREATE OR REPLACE FUNCTION public.video_runner_kick(p_job_id uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'il calcio esplode'; END $$;
      `)
      const { jobId, percorso } = await apriGalleria('kick-esplode')
      await deposita(percorso, { size: 5000 })
      // L'arrivo c'è: `video_job_uploaded` non è stato annullato dall'eccezione del calcio.
      expect(await job(jobId)).toMatchObject({ status: 'queued', arrivato: true })
      expect(await eventi('video-runner-kick')).toMatchObject([{ livello: 'error', code: 'KICK_ECCEZIONE', contesto: { job_id: jobId } }])
    })
  })
})

describe('input strani · il corpo condiviso non si lascia sorprendere', () => {
  const applica = (nome: string | null, metadata: string, origine: string | null) =>
    rpc(
      `public._video_originale_applica(${nome === null ? 'NULL::text' : `'${nome}'`}, ${metadata}, ${origine === null ? 'NULL::text' : `'${origine}'`})`,
    )

  it('argomenti nulli, nome vuoto o un\'origine che non è «trigger»/«giro» → BAD_INPUT, senza scrivere niente', async () => {
    const { jobId } = await apriGalleria('strano-1')
    const prima = await righeDiLog()
    expect(await applica(null, `'{}'::jsonb`, 'trigger')).toEqual({ ok: false, code: 'BAD_INPUT' })
    expect(await applica('   ', `'{}'::jsonb`, 'trigger')).toEqual({ ok: false, code: 'BAD_INPUT' })
    expect(await applica(percorsoDi('strano-1'), `'{}'::jsonb`, null)).toEqual({ ok: false, code: 'BAD_INPUT' })
    expect(await applica(percorsoDi('strano-1'), `'{}'::jsonb`, 'mano')).toEqual({ ok: false, code: 'BAD_INPUT' })
    expect((await job(jobId)).status).toBe('awaiting_upload')
    // I rifiuti scrivono il loro `error` (configurazione sbagliata = livello error, mai silenzio).
    expect((await righeDiLog()) - prima).toBe(4)
  })

  it('metadati NULL, scalari o senza i campi attesi: il job resta in attesa e un warn lo dice (nessuna eccezione)', async () => {
    const { jobId, percorso } = await apriGalleria('strano-2')
    await db.query(`INSERT INTO storage.objects(bucket_id, name, metadata) VALUES ('video_originals', $1, NULL)`, [percorso])
    expect((await job(jobId)).status).toBe('awaiting_upload')
    expect(await applica(percorso, `'"una stringa"'::jsonb`, 'giro')).toMatchObject({ ok: true, esito: 'metadati-incompleti' })
    expect(await applica(percorso, `'[1, 2]'::jsonb`, 'giro')).toMatchObject({ ok: true, esito: 'metadati-incompleti' })
    expect(await applica(percorso, `'{"size": "enorme", "mimetype": "video/mp4"}'::jsonb`, 'giro')).toMatchObject({ esito: 'metadati-incompleti' })
    expect((await job(jobId)).status).toBe('awaiting_upload')
    expect((await eventi('video-originale-incompleto')).length).toBeGreaterThanOrEqual(4)
  })

  it('un nome che non è di nessun job → «senza-job», anche se assomiglia a un percorso (nessun LIKE, nessun prefisso)', async () => {
    await apriGalleria('strano-3')
    expect(await applica(`${percorsoDi('strano-3')}x`, `'{"size": 5000}'::jsonb`, 'trigger')).toEqual({ ok: true, esito: 'senza-job' })
    expect(await applica(percorsoDi('strano-3').toUpperCase(), `'{"size": 5000}'::jsonb`, 'trigger')).toEqual({ ok: true, esito: 'senza-job' })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2 · LA DIMENSIONE DIVERSA
// ─────────────────────────────────────────────────────────────────────────────

describe('dimensione diversa · ORIGINALE_DIVERSO', () => {
  it('meno byte di quelli dichiarati: rejected, scadenza dell\'originale ADESSO, fence + 1, e video_job_uploaded NON è stata chiamata', async () => {
    const { jobId, percorso } = await apriGalleria('div-1', { byte: 5000 })
    await deposita(percorso, { size: 4999 })

    expect(await job(jobId)).toMatchObject({
      status: 'rejected',
      error_code: 'ORIGINALE_DIVERSO',
      fence_epoch: 1,
      scadenza_originale_passata: true,
      originale_timbrato: false,
      // Non c'è mai stata un'uscita: la sua scadenza non si inventa.
      output_path: null,
      scadenza_uscita_passata: null,
      // Il file non è «arrivato» per il job: niente dimensione, niente istante.
      source_size: null,
      arrivato: false,
    })
    expect(await eventi('video-originale-diverso')).toMatchObject([
      { livello: 'error', contesto: { origine: 'trigger', atteso: 5000, trovato: 4999 } },
    ])
  })

  it.each([5001, 1, 0, 2_000_000_000])('anche %i byte, contro i 5000 dichiarati, è un file diverso', async (size) => {
    const { jobId, percorso } = await apriGalleria(`div-${size}`, { byte: 5000 })
    await deposita(percorso, { size })
    expect(await job(jobId)).toMatchObject({ status: 'rejected', error_code: 'ORIGINALE_DIVERSO' })
  })

  it('la STESSA dimensione arriva (controllo positivo del confronto: senza, «diverso» sarebbe sempre vero)', async () => {
    const { jobId, percorso } = await apriGalleria('div-uguale', { byte: 5000 })
    await deposita(percorso, { size: 5000 })
    expect((await job(jobId)).status).toBe('queued')
  })

  it('caricamento NATIVO: il token si revoca, e `video_rinnovo_usa` risponde «annullato» (il job è chiuso senza arrivo)', async () => {
    const { jobId, percorso, hashToken } = await apriGalleria('div-nat', { byte: 5000, trasporto: 'put-nativo' })
    await deposita(percorso, { size: 4000 })
    expect(await job(jobId)).toMatchObject({ status: 'rejected', error_code: 'ORIGINALE_DIVERSO', token_revocato: true })
    expect(await rpc(`public.video_rinnovo_usa(${hashToken})`)).toEqual({ ok: true, stato: 'annullato' })
  })

  it('un secondo evento sullo stesso oggetto non riscrive niente (il job è già chiuso)', async () => {
    const { jobId, percorso } = await apriGalleria('div-due-volte', { byte: 5000 })
    await deposita(percorso, { size: 4999 })
    const prima = await job(jobId)
    await deposita(percorso, { size: 4999, etag: '"e2"' })
    expect(await job(jobId)).toEqual(prima)
    expect(await eventi('video-originale-diverso')).toHaveLength(1)
  })

  it('il log dice i due numeri e nient\'altro (mai il percorso)', async () => {
    const { percorso } = await apriGalleria('div-log', { byte: 5000 })
    await deposita(percorso, { size: 4999 })
    const log = await tuttoIlLog()
    expect(log).not.toContain('.mp4')
    expect(log).not.toContain(OWNER)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3 · IL RISORTO
// ─────────────────────────────────────────────────────────────────────────────

describe('risorto · l\'originale non doveva più esserci', () => {
  /** Annulla un job (come farebbe l'utente) e, se serve, lo fa timbrare come rimosso dalla retention. */
  async function annullato(chiave: string, opz: { timbrato: boolean }) {
    const aperto = await apriGalleria(chiave)
    expect((await rpc(`public.video_job_cancel('${aperto.jobId}', '${OWNER}')`)).ok).toBe(true)
    if (opz.timbrato) {
      expect((await rpc(`public.video_retention_originale_rimosso('${aperto.jobId}')`)).ok).toBe(true)
      expect((await job(aperto.jobId)).originale_timbrato).toBe(true)
    }
    return aperto
  }

  it('job ANNULLATO e già timbrato: il timbro si toglie, la scadenza è adesso, lo stato non cambia, e il log è un warn', async () => {
    const { jobId, percorso } = await annullato('ris-annullato-timbrato', { timbrato: true })
    await deposita(percorso, { size: 5000 })
    expect(await job(jobId)).toMatchObject({
      status: 'cancelled',
      originale_timbrato: false,
      scadenza_originale_passata: true,
      // Non è un arrivo: nessuna coda, nessun istante.
      arrivato: false,
      source_size: null,
    })
    expect(await eventi('video-originale-risorto')).toMatchObject([
      { livello: 'warn', contesto: { job_id: jobId, stato: 'cancelled', timbrato: true, origine: 'trigger' } },
    ])
  })

  it('job ANNULLATO e non ancora timbrato (l\'utente ha annullato mentre caricava): scadenza adesso, e il log è solo un info', async () => {
    const { jobId, percorso } = await annullato('ris-annullato', { timbrato: false })
    await deposita(percorso, { size: 5000 })
    expect(await job(jobId)).toMatchObject({ status: 'cancelled', originale_timbrato: false, scadenza_originale_passata: true })
    expect(await eventi('video-originale-risorto')).toMatchObject([{ livello: 'info', contesto: { timbrato: false } }])
  })

  it('job `failed` COL timbro: si riarma (è il caso dei due originali «risorti» del 01/10)', async () => {
    const { jobId, percorso } = await apriGalleria('ris-failed-timbrato')
    // L'upload abbandonato: la retention lo dichiara `failed` dopo le ore di tolleranza…
    await db.exec(`UPDATE public.video_jobs SET created_at = created_at - interval '3 hours' WHERE id = '${jobId}'`)
    expect(await rpc(`public.video_retention_scadenze(1, 1, 100)`)).toMatchObject({ ok: true, abbandonati: 1 })
    // …e dopo i sette giorni toglie il file e timbra la riga.
    await db.exec(`UPDATE public.video_jobs SET original_delete_after = clock_timestamp() - interval '1 day' WHERE id = '${jobId}'`)
    expect((await rpc(`public.video_retention_originale_rimosso('${jobId}')`)).ok).toBe(true)
    expect(await job(jobId)).toMatchObject({ status: 'failed', error_code: 'UPLOAD_ABBANDONATO', originale_timbrato: true })

    // Il file ricompare.
    await deposita(percorso, { size: 5000 })

    expect(await job(jobId)).toMatchObject({
      status: 'failed',
      error_code: 'UPLOAD_ABBANDONATO',
      originale_timbrato: false,
      scadenza_originale_passata: true,
    })
    expect(await eventi('video-originale-risorto')).toMatchObject([{ livello: 'warn', contesto: { stato: 'failed', timbrato: true } }])
  })

  it('job `failed` SENZA timbro e con la scadenza nel futuro: non si tocca niente (la scadenza che ha già lo toglierà)', async () => {
    const { jobId, percorso } = await apriGalleria('ris-failed-non-timbrato')
    await db.exec(`UPDATE public.video_jobs SET created_at = created_at - interval '3 hours' WHERE id = '${jobId}'`)
    await rpc(`public.video_retention_scadenze(1, 1, 100)`)
    const prima = await job(jobId)
    expect(prima).toMatchObject({ status: 'failed', originale_timbrato: false, scadenza_originale_passata: false })

    await deposita(percorso, { size: 5000 })

    expect(await job(jobId)).toEqual(prima)
    expect(await eventi('video-originale-risorto')).toEqual([])
  })

  it('job `ready` COL timbro e lo STESSO eTag: non si riarma (riscrivere la scadenza violerebbe video_jobs_original_ttl_chk) e non c\'è nessuna eccezione', async () => {
    const { jobId, percorso } = await apriGalleria('ris-ready-timbrato')
    await deposita(percorso, { size: 5000, etag: '"e1"' })
    await portaAReady(jobId)
    await db.exec(`UPDATE public.video_jobs SET original_deleted_at = original_delete_after + interval '1 minute' WHERE id = '${jobId}'`)
    // Il file è stato tolto dalla Storage API e poi RIcompare identico (stesso contenuto, stesso eTag).
    await db.exec(`TRUNCATE storage.objects`)
    const prima = await job(jobId)

    await deposita(percorso, { size: 5000, etag: '"e1"' })

    expect(await job(jobId)).toEqual(prima)
    expect((await job(jobId)).originale_timbrato, 'il timbro resta: lo toglie la spazzata degli originali risorti, non questo file').toBe(true)
    expect(await eventi('video-originale-risorto')).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4 · IL SOSTITUITO
// ─────────────────────────────────────────────────────────────────────────────

describe('sostituito · l\'eTag cambia dopo l\'arrivo', () => {
  it('job `queued`: rejected ORIGINALE_SOSTITUITO, fence + 1, scadenza adesso, e un log di livello error', async () => {
    const { jobId, percorso } = await apriGalleria('sost-queued')
    await deposita(percorso, { size: 5000, etag: '"e1"' })
    expect((await job(jobId)).status).toBe('queued')

    await deposita(percorso, { size: 5000, etag: '"e2"' }) // l'upsert: scatta il ramo UPDATE

    expect(await job(jobId)).toMatchObject({
      status: 'rejected',
      error_code: 'ORIGINALE_SOSTITUITO',
      fence_epoch: 1,
      scadenza_originale_passata: true,
      originale_timbrato: false,
      lease_owner: null,
      lease_expires_at: null,
    })
    expect(await eventi('video-originale-sostituito')).toMatchObject([
      { livello: 'error', contesto: { job_id: jobId, origine: 'trigger', stato: 'queued', intento: 'confirmed' } },
    ])
  })

  it('job `processing`: la lease si azzera e il runner che stava convertendo NON può più scrivere ready né sopravvivere al battito (FENCE_MISMATCH)', async () => {
    const { jobId, percorso } = await apriGalleria('sost-processing')
    await deposita(percorso, { size: 5000, etag: '"e1"' })
    await prendi(jobId)
    expect(await job(jobId)).toMatchObject({ status: 'processing', fence_epoch: 1 })

    await deposita(percorso, { size: 5000, etag: '"e2"' })

    expect(await job(jobId)).toMatchObject({
      status: 'rejected',
      error_code: 'ORIGINALE_SOSTITUITO',
      fence_epoch: 2,
      lease_owner: null,
      lease_expires_at: null,
    })
    // Il runner ha ancora in mano il fence 1: nessuna delle sue scritture passa più.
    expect(
      await rpc(`public.video_job_ready('${jobId}', 1, '${LEASE_A}', 'outputs/${jobId}/final.mp4', 900, '{"durationSeconds":20}'::jsonb)`),
    ).toEqual({ ok: false, code: 'FENCE_MISMATCH' })
    expect(await rpc(`public.video_job_heartbeat('${jobId}', 1, '${LEASE_A}')`)).toEqual({ ok: false, code: 'FENCE_MISMATCH' })
  })

  it('job `ready` di un intento vivo: rejected, e l\'USCITA riceve la scadenza adesso (senza, resterebbe in video_processing per sempre)', async () => {
    const { jobId, intentId, percorso } = await apriGalleria('sost-ready')
    await deposita(percorso, { size: 5000, etag: '"e1"' })
    await portaAReady(jobId)
    const prima = await job(jobId)
    expect(prima).toMatchObject({ status: 'ready', scadenza_originale_passata: false, scadenza_uscita_passata: null })

    await deposita(percorso, { size: 5000, etag: '"e2"' })

    expect(await job(jobId)).toMatchObject({
      status: 'rejected',
      error_code: 'ORIGINALE_SOSTITUITO',
      scadenza_originale_passata: true,
      output_path: `outputs/${jobId}/final.mp4`,
      scadenza_uscita_passata: true,
    })
    // L'intento non è cambiato: la pubblicazione troverà JOBS_NOT_READY e non pubblicherà.
    expect((await unaRiga<{ status: string }>(`SELECT status FROM public.video_intents WHERE id = '${intentId}'`)).status).toBe('confirmed')
    expect(await rpc(`public.video_galleria_pubblica('${intentId}', 1, '${OWNER}', '${SEDE}', 'uploads/${OWNER}/v-${intentId}.mp4', ARRAY['${A1}']::uuid[])`))
      .toMatchObject({ ok: false, code: 'JOBS_NOT_READY' })
  })

  it('un job `ready` di una News con l\'uscita che scade fra sette giorni: l\'uscita scade comunque ADESSO (non si tiene un\'uscita senza padrone)', async () => {
    const { jobId, percorso } = await apriNews('sost-news-ready')
    await deposita(percorso, { size: 5000, etag: '"e1"' })
    await portaAReady(jobId)
    expect((await job(jobId)).scadenza_uscita_passata).toBe(false)

    await deposita(percorso, { size: 5000, etag: '"e2"' })

    expect(await job(jobId)).toMatchObject({ status: 'rejected', scadenza_uscita_passata: true })
  })

  it('un job di una News `pending` (non ancora confermata) è un intento vivo: la sostituzione lo respinge', async () => {
    const { jobId, percorso } = await apriNews('sost-news-pending')
    await deposita(percorso, { size: 5000, etag: '"e1"' })
    await deposita(percorso, { size: 5000, etag: '"e2"' })
    expect(await job(jobId)).toMatchObject({ status: 'rejected', error_code: 'ORIGINALE_SOSTITUITO' })
    expect(await eventi('video-originale-sostituito')).toMatchObject([{ contesto: { intento: 'pending' } }])
  })

  it('lo STESSO eTag (Storage che ritocca i metadati) non fa niente', async () => {
    const { jobId, percorso } = await apriGalleria('sost-stesso-etag')
    await deposita(percorso, { size: 5000, etag: '"e1"' })
    const prima = await job(jobId)
    await deposita(percorso, { size: 5000, etag: '"e1"', extra: { lastModified: '2030-01-01T00:00:00.000Z' } })
    expect(await job(jobId)).toEqual(prima)
    expect(await eventi('video-originale-sostituito')).toEqual([])
  })

  it('un eTag NUOVO ma senza riferimento (il job è entrato in coda dal PATCH prima che il trigger lo vedesse): non si rifiuta niente', async () => {
    const { jobId, percorso } = await apriGalleria('sost-senza-riferimento')
    // Il PATCH `caricato` del web, prima di qualunque evento dello Storage.
    expect((await rpc(`public.video_job_uploaded('${jobId}', '${OWNER}', 5000, 'video/mp4')`)).ok).toBe(true)
    expect((await job(jobId)).sorgente_etag).toBeNull()

    await deposita(percorso, { size: 5000, etag: '"qualunque"' })

    expect(await job(jobId)).toMatchObject({ status: 'queued', sorgente_etag: null, arrivato: false })
  })

  it('un evento SENZA eTag su un job con riferimento non conta come «cambiato»', async () => {
    const { jobId, percorso } = await apriGalleria('sost-evento-senza-etag')
    await deposita(percorso, { size: 5000, etag: '"e1"' })
    await deposita(percorso, { size: 5000, etag: null })
    expect((await job(jobId)).status).toBe('queued')
  })

  it('intento PUBBLICATO: nessuna transizione (l\'uscita è già in galleria), ma la traccia c\'è, come warn', async () => {
    const { jobId, intentId, percorso } = await apriGalleria('sost-pubblicato')
    await deposita(percorso, { size: 5000, etag: '"e1"' })
    await portaAReady(jobId)
    expect(
      await rpc(`public.video_galleria_pubblica('${intentId}', 1, '${OWNER}', '${SEDE}', 'uploads/${OWNER}/v-${intentId}.mp4', ARRAY['${A1}']::uuid[])`),
    ).toMatchObject({ ok: true, created: true })

    await deposita(percorso, { size: 5000, etag: '"e2"' })

    expect((await job(jobId)).status, 'un intento pubblicato con un job respinto sarebbe una contraddizione').toBe('ready')
    expect(await eventi('video-originale-sostituito')).toMatchObject([
      { livello: 'warn', contesto: { job_id: jobId, intento: 'published', transizione: false } },
    ])
  })

  it('job ANNULLATO: è un risorto, non una sostituzione (anche con un eTag diverso)', async () => {
    const { jobId, percorso } = await apriGalleria('sost-annullato')
    await deposita(percorso, { size: 5000, etag: '"e1"' })
    expect((await rpc(`public.video_job_cancel('${jobId}', '${OWNER}')`)).ok).toBe(true)
    await deposita(percorso, { size: 5000, etag: '"e2"' })
    expect((await job(jobId)).status).toBe('cancelled')
    expect(await eventi('video-originale-sostituito')).toEqual([])
    expect((await eventi('video-originale-risorto')).length).toBeGreaterThanOrEqual(1)
  })

  it('job `ready` col timbro e un eTag DIVERSO (il file è tornato ed è un altro): rejected, e il timbro si toglie perché il file va tolto di nuovo', async () => {
    const { jobId, percorso } = await apriGalleria('sost-ready-timbrato')
    await deposita(percorso, { size: 5000, etag: '"e1"' })
    await portaAReady(jobId)
    await db.exec(`UPDATE public.video_jobs SET original_deleted_at = original_delete_after + interval '1 minute' WHERE id = '${jobId}'`)
    await db.exec(`TRUNCATE storage.objects`)

    await deposita(percorso, { size: 5000, etag: '"altro"' })

    expect(await job(jobId)).toMatchObject({
      status: 'rejected',
      error_code: 'ORIGINALE_SOSTITUITO',
      // Senza questo il vincolo `video_jobs_original_deleted_chk` farebbe fallire l'UPDATE (timbro più
      // recente della scadenza nuova) e il trigger ingoierebbe l'eccezione: il file resterebbe lì.
      originale_timbrato: false,
      scadenza_originale_passata: true,
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5 · video_job_uploaded CHIAMATA DUE VOLTE (trigger + PATCH `caricato`)
// ─────────────────────────────────────────────────────────────────────────────

describe('video_job_uploaded due volte · idempotente, e fragile su un solo punto', () => {
  const uploaded = (jobId: string, byte = 5000, mime = 'video/mp4') =>
    rpc(`public.video_job_uploaded('${jobId}', '${OWNER}', ${byte}, '${mime}')`)

  it('dopo il trigger il PATCH `caricato` con gli stessi byte e lo stesso mime va a buon fine e non scrive niente', async () => {
    const { jobId, percorso } = await apriGalleria('idem-1')
    await deposita(percorso, { size: 5000 })
    const prima = await job(jobId)

    const r = await uploaded(jobId)

    expect(r).toMatchObject({ ok: true, job: { status: 'queued', source_size: 5000, source_mime: 'video/mp4' } })
    expect(await job(jobId), 'neanche updated_at: una chiamata ripetuta non sposta niente').toEqual(prima)
  })

  it.each([
    ['in lavorazione', async (jobId: string) => prendi(jobId), 'processing'],
    ['pronto', async (jobId: string) => portaAReady(jobId), 'ready'],
  ] as const)('anche a job %s la seconda chiamata è un successo che non cambia lo stato', async (_nome, avanza, stato) => {
    const { jobId, percorso } = await apriGalleria(`idem-${stato}`)
    await deposita(percorso, { size: 5000 })
    await avanza(jobId)
    const prima = await job(jobId)
    expect(await uploaded(jobId)).toMatchObject({ ok: true, job: { status: stato } })
    expect(await job(jobId)).toEqual(prima)
  })

  it('con un mime o una dimensione DIVERSI prende SOURCE_CONFLICT: il PATCH deve dichiarare gli stessi valori del trigger', async () => {
    const { jobId, percorso } = await apriGalleria('idem-conflitto')
    await deposita(percorso, { size: 5000 })
    expect(await uploaded(jobId, 5000, 'video/quicktime')).toEqual({ ok: false, code: 'SOURCE_CONFLICT' })
    expect(await uploaded(jobId, 4999)).toEqual({ ok: false, code: 'SOURCE_CONFLICT' })
    // E il job è intatto.
    expect(await job(jobId)).toMatchObject({ status: 'queued', source_size: 5000, source_mime: 'video/mp4' })
  })

  it('il PATCH PER PRIMO (il trigger non l\'ha visto) e poi l\'oggetto: il trigger non riscrive il job', async () => {
    const { jobId, percorso } = await apriGalleria('idem-patch-prima')
    expect((await uploaded(jobId)).ok).toBe(true)
    const prima = await job(jobId)
    await deposita(percorso, { size: 5000 })
    expect(await job(jobId)).toEqual(prima)
  })

  it('il PATCH su un job che il trigger ha RESPINTO (dimensione diversa) prende INVALID_STATE e non lo riporta in coda', async () => {
    const { jobId, percorso } = await apriGalleria('idem-respinto', { byte: 5000 })
    await deposita(percorso, { size: 4000 })
    expect(await uploaded(jobId, 5000)).toEqual({ ok: false, code: 'INVALID_STATE' })
    expect((await job(jobId)).status).toBe('rejected')
  })

  it('un `video_job_uploaded` che RIFIUTA dentro il trigger (codice di rifiuto, non eccezione): il job resta in attesa e il log dice quale', async () => {
    await inUnaTransazioneDaButtare(async () => {
      await db.exec(`
        CREATE OR REPLACE FUNCTION public.video_job_uploaded(p_job_id uuid, p_owner_id uuid, p_source_size bigint, p_source_mime text)
        RETURNS jsonb LANGUAGE sql AS $$ SELECT '{"ok": false, "code": "INTENT_INACTIVE"}'::jsonb $$;
      `)
      const { jobId, percorso } = await apriGalleria('idem-rifiuto')
      await deposita(percorso, { size: 5000 })
      expect(await job(jobId)).toMatchObject({ status: 'awaiting_upload', arrivato: false })
      expect(await eventi('video-originale-arrivato')).toMatchObject([
        { livello: 'error', code: 'INTENT_INACTIVE', contesto: { job_id: jobId, origine: 'trigger' } },
      ])
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 6 · FAIL-OPEN: UN'ECCEZIONE NEL TRIGGER NON FA MAI FALLIRE L'UPLOAD
// ─────────────────────────────────────────────────────────────────────────────

describe('fail-open · l\'INSERT dell\'oggetto riesce comunque, e il job resta com\'era', () => {
  beforeEach(() => {
    attendoEccezioni = true
  })

  it('un\'eccezione DOPO una scrittura: l\'oggetto c\'è, il job è tornato com\'era (nessuna scrittura a metà), e il log non ha il messaggio', async () => {
    await inUnaTransazioneDaButtare(async () => {
      await db.exec(`
        CREATE OR REPLACE FUNCTION public.video_job_uploaded(p_job_id uuid, p_owner_id uuid, p_source_size bigint, p_source_mime text)
        RETURNS jsonb LANGUAGE plpgsql AS $$
        BEGIN
          UPDATE public.video_jobs SET status = 'queued', source_size = p_source_size, source_mime = p_source_mime
          WHERE id = p_job_id;
          RAISE EXCEPTION 'SEGRETO-DI-PROVA % %', p_job_id, 'nome-di-un-bambino';
        END $$;
      `)
      const { jobId, percorso } = await apriGalleria('fo-1')

      await deposita(percorso, { size: 5000 })

      expect(await contaOggetti(), 'l\'INSERT dell\'oggetto è riuscito').toBe(1)
      expect(await job(jobId)).toMatchObject({ status: 'awaiting_upload', source_size: null, source_mime: null, arrivato: false })
      const [ecc] = await eventi('video-arrivo-trigger-eccezione')
      expect(ecc).toMatchObject({ livello: 'error', code: 'P0001', contesto: { origine: 'trigger' } })
      const log = await tuttoIlLog()
      expect(log, 'MAI il messaggio di Postgres: può contenere il valore che l\'ha causato').not.toContain('SEGRETO-DI-PROVA')
      expect(log).not.toContain('nome-di-un-bambino')
    })
  })

  it('una violazione di vincolo DOPO `video_job_uploaded`: l\'arrivo si annulla per intero, e il log porta il NOME del vincolo, la tabella e lo SQLSTATE', async () => {
    await inUnaTransazioneDaButtare(async () => {
      // Un vincolo che la scrittura dell'arrivo viola: succede DOPO che `video_job_uploaded` ha scritto.
      await db.exec(`ALTER TABLE public.video_jobs ADD CONSTRAINT boom_di_prova CHECK (arrivato_il IS NULL)`)
      const { jobId, percorso } = await apriGalleria('fo-2')

      await deposita(percorso, { size: 5000 })

      expect(await contaOggetti()).toBe(1)
      // Tutto o niente: la coda di `video_job_uploaded` è stata annullata insieme alla scrittura che ha fallito.
      expect(await job(jobId)).toMatchObject({ status: 'awaiting_upload', source_size: null, arrivato: false })
      expect(await eventi('video-arrivo-trigger-eccezione')).toMatchObject([
        { livello: 'error', code: '23514', contesto: { vincolo: 'boom_di_prova', tabella: 'video_jobs' } },
      ])
    })
  })

  it('anche se il corpo condiviso sparisce del tutto (funzione assente): l\'INSERT riesce', async () => {
    await inUnaTransazioneDaButtare(async () => {
      await db.exec(`DROP FUNCTION public._video_originale_applica(text, jsonb, text)`)
      const { jobId, percorso } = await apriGalleria('fo-3')
      await deposita(percorso, { size: 5000 })
      expect(await contaOggetti()).toBe(1)
      expect((await job(jobId)).status).toBe('awaiting_upload')
      expect(await eventi('video-arrivo-trigger-eccezione')).toMatchObject([{ livello: 'error', code: '42883' }])
    })
  })

  it('anche se il LOGGER è rotto (la funzione di log non esiste): l\'INSERT riesce e il trigger non solleva', async () => {
    await inUnaTransazioneDaButtare(async () => {
      const { jobId, percorso } = await apriGalleria('fo-4')
      await db.exec(`DROP FUNCTION public._video_job_transition_log(text, text, uuid, uuid, text, jsonb)`)
      await deposita(percorso, { size: 5000 })
      expect(await contaOggetti(), 'senza il logger nemmeno il gestore può scrivere: l\'upload deve riuscire lo stesso').toBe(1)
      expect((await job(jobId)).status).toBe('awaiting_upload')
    })
  })

  it('un\'eccezione sul ramo UPDATE (l\'upsert) è fail-open come quella sul ramo INSERT', async () => {
    const { jobId, percorso } = await apriGalleria('fo-5')
    await deposita(percorso, { size: 5000, etag: '"e1"' })
    await inUnaTransazioneDaButtare(async () => {
      await db.exec(`ALTER TABLE public.video_jobs ADD CONSTRAINT boom_di_prova CHECK (status <> 'rejected')`)
      await deposita(percorso, { size: 5000, etag: '"e2"' }) // sostituzione: l'UPDATE a `rejected` viola il vincolo
      expect(await contaOggetti()).toBe(1)
      expect((await job(jobId)).status, 'la sostituzione non si è potuta scrivere: il job è com\'era').toBe('queued')
      expect(await eventi('video-arrivo-trigger-eccezione')).toMatchObject([{ code: '23514', contesto: { vincolo: 'boom_di_prova' } }])
      // …e l'oggetto è quello NUOVO: l'upsert dello Storage è riuscito.
      expect(
        (await unaRiga<{ e: string }>(`SELECT metadata ->> 'eTag' AS e FROM storage.objects`)).e,
      ).toBe('"e2"')
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 7 · LA RETE · video_arrivi_recupera
// ─────────────────────────────────────────────────────────────────────────────

describe('video_arrivi_recupera · gli arrivi che il trigger non ha visto', () => {
  const recupera = (limite: number | null = 50, conn: PGlite = db) =>
    rpc<{ ok: boolean; code?: string; candidati?: number; arrivati?: number; diversi?: number; non_risolti?: number; errori?: number; motivo?: string }>(
      `public.video_arrivi_recupera(${limite === null ? 'NULL::integer' : limite})`,
      conn,
    )

  /** Il trigger spento (come se non ci fosse stato quando l'oggetto è arrivato). */
  const senzaTrigger = () => db.exec(`ALTER TABLE storage.objects DISABLE TRIGGER trg_video_originale_arrivato`)
  const conTrigger = () => db.exec(`ALTER TABLE storage.objects ENABLE TRIGGER trg_video_originale_arrivato`)

  afterEach(async () => {
    await conTrigger()
  })

  it('porta in coda il job il cui oggetto esiste, lo dice come WARN (il trigger non l\'ha visto) e un info di riepilogo', async () => {
    const { jobId, percorso } = await apriGalleria('giro-1')
    await senzaTrigger()
    await deposita(percorso, { size: 5000, etag: '"g1"' })
    expect((await job(jobId)).status, 'senza il trigger l\'oggetto non ha mosso niente').toBe('awaiting_upload')

    expect(await recupera()).toEqual({ ok: true, candidati: 1, arrivati: 1, diversi: 0, non_risolti: 0, errori: 0 })

    expect(await job(jobId)).toMatchObject({ status: 'queued', source_size: 5000, arrivato: true, sorgente_etag: '"g1"' })
    expect(await eventi('video-arrivo-recuperato-dal-giro')).toMatchObject([
      { livello: 'warn', contesto: { job_id: jobId, esito: 'arrivato' } },
    ])
    expect(await eventi('video-originale-arrivato')).toMatchObject([{ livello: 'info', contesto: { origine: 'giro' } }])
    expect(await eventi('video-arrivi-recupera')).toMatchObject([
      { livello: 'info', contesto: { candidati: 1, arrivati: 1, diversi: 0, non_risolti: 0, errori: 0 } },
    ])
    // Il secondo giro non trova più niente (idempotente), e lo dice lo stesso: il successo si logga.
    expect(await recupera()).toEqual({ ok: true, candidati: 0, arrivati: 0, diversi: 0, non_risolti: 0, errori: 0 })
  })

  it('stessa logica del trigger: una dimensione diversa è rifiutata anche dal giro', async () => {
    const { jobId, percorso } = await apriGalleria('giro-div', { byte: 5000 })
    await senzaTrigger()
    await deposita(percorso, { size: 100 })
    expect(await recupera()).toMatchObject({ candidati: 1, arrivati: 0, diversi: 1 })
    expect(await job(jobId)).toMatchObject({ status: 'rejected', error_code: 'ORIGINALE_DIVERSO' })
    expect(await eventi('video-arrivo-recuperato-dal-giro')).toMatchObject([{ contesto: { esito: 'diverso' } }])
  })

  it('un job senza oggetto non è un candidato, e un oggetto di un altro bucket non conta', async () => {
    await db.exec(`INSERT INTO storage.buckets(id, name) VALUES ('gallery', 'gallery') ON CONFLICT (id) DO NOTHING`)
    const senza = await apriGalleria('giro-senza-oggetto')
    const altro = await apriGalleria('giro-altro-bucket')
    await deposita(altro.percorso, { size: 5000 }, 'gallery')
    expect(await recupera()).toEqual({ ok: true, candidati: 0, arrivati: 0, diversi: 0, non_risolti: 0, errori: 0 })
    expect((await job(senza.jobId)).status).toBe('awaiting_upload')
    expect((await job(altro.jobId)).status).toBe('awaiting_upload')
  })

  it('metadati incompleti: conta come NON risolto, il job resta in attesa, e il giro dopo ci riprova', async () => {
    const { jobId, percorso } = await apriGalleria('giro-incompleto')
    await senzaTrigger()
    await deposita(percorso, { size: null })
    expect(await recupera()).toMatchObject({ candidati: 1, arrivati: 0, non_risolti: 1 })
    expect((await job(jobId)).status).toBe('awaiting_upload')
    expect(await recupera()).toMatchObject({ candidati: 1, non_risolti: 1 })
  })

  it('rispetta il limite e va dal più vecchio', async () => {
    const a = await apriGalleria('giro-lim-1')
    const b = await apriGalleria('giro-lim-2')
    const c = await apriGalleria('giro-lim-3')
    await db.exec(`UPDATE public.video_jobs SET created_at = created_at - interval '2 hours' WHERE id = '${c.jobId}'`)
    await db.exec(`UPDATE public.video_jobs SET created_at = created_at - interval '1 hour' WHERE id = '${b.jobId}'`)
    await senzaTrigger()
    for (const x of [a, b, c]) await deposita(x.percorso, { size: 5000 })

    expect(await recupera(2)).toMatchObject({ candidati: 2, arrivati: 2 })
    expect((await job(c.jobId)).status).toBe('queued')
    expect((await job(b.jobId)).status).toBe('queued')
    expect((await job(a.jobId)).status, 'il più recente aspetta il giro dopo').toBe('awaiting_upload')
  })

  it('un job che ESPLODE non ferma gli altri: l\'errore ha il suo sottoblocco, il suo log e il suo conteggio', async () => {
    attendoEccezioni = true
    await inUnaTransazioneDaButtare(async () => {
      // Il vincolo viola solo per il job da 777 byte, DOPO che `video_job_uploaded` ha scritto.
      await db.exec(`ALTER TABLE public.video_jobs ADD CONSTRAINT boom_di_prova CHECK (arrivato_il IS NULL OR source_size <> 777)`)
      const buono = await apriGalleria('giro-buono', { byte: 5000 })
      const cattivo = await apriGalleria('giro-cattivo', { byte: 777 })
      await db.exec(`UPDATE public.video_jobs SET created_at = created_at - interval '1 hour' WHERE id = '${cattivo.jobId}'`)
      await senzaTrigger()
      await deposita(cattivo.percorso, { size: 777 })
      await deposita(buono.percorso, { size: 5000 })

      expect(await recupera()).toEqual({ ok: true, candidati: 2, arrivati: 1, diversi: 0, non_risolti: 0, errori: 1 })

      expect((await job(buono.jobId)).status, 'il buono è entrato in coda nonostante il cattivo').toBe('queued')
      expect((await job(cattivo.jobId)).status, 'il cattivo si è annullato per intero').toBe('awaiting_upload')
      expect(await eventi('video-arrivo-giro-eccezione')).toMatchObject([
        { livello: 'error', code: '23514', contesto: { job_id: cattivo.jobId, origine: 'giro', vincolo: 'boom_di_prova' } },
      ])
    })
  })

  it('NON scrive su storage.objects: gli oggetti restano esattamente com\'erano (nessuna DELETE, nessun UPDATE)', async () => {
    const { percorso } = await apriGalleria('giro-sola-lettura')
    await senzaTrigger()
    await deposita(percorso, { size: 5000 })
    const fotografia = () =>
      unaRiga<{ n: number; h: string }>(
        `SELECT count(*)::int AS n, md5(string_agg(id::text || name || metadata::text || updated_at::text, '|' ORDER BY name)) AS h FROM storage.objects`,
      )
    const prima = await fotografia()
    await recupera()
    expect(await fotografia()).toEqual(prima)
  })

  it.each([[0], [-1], [201], [null]])('p_limite %s → BAD_INPUT, senza toccare niente', async (limite) => {
    const { jobId, percorso } = await apriGalleria(`giro-bad-${String(limite)}`)
    await senzaTrigger()
    await deposita(percorso, { size: 5000 })
    expect(await recupera(limite)).toEqual({ ok: false, code: 'BAD_INPUT' })
    expect((await job(jobId)).status).toBe('awaiting_upload')
  })

  it('senza `storage.objects` (il database della CI) non fa niente, non solleva, e lo dice', async () => {
    const conn = await costruisci({ storage: false })
    try {
      const r = await recupera(10, conn)
      expect(r).toEqual({ ok: true, candidati: 0, arrivati: 0, diversi: 0, non_risolti: 0, errori: 0, motivo: 'storage-assente' })
      expect(await eventi('video-arrivi-recupera', conn)).toMatchObject([{ livello: 'info', code: 'STORAGE_ASSENTE' }])
    } finally {
      await conn.close()
    }
  }, 60_000)
})

// ─────────────────────────────────────────────────────────────────────────────
// 8 · L'INSTALLAZIONE
// ─────────────────────────────────────────────────────────────────────────────

/** Gli SHA delle tre funzioni: se la riapplicazione cambiasse qualcosa, cambierebbero. */
const impronteFunzioni = (conn: PGlite) =>
  righe<{ nome: string; h: string; config: string | null }>(
    `SELECT p.proname AS nome, md5(p.prosrc) AS h, p.proconfig::text AS config
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('video_originale_arrivato', '_video_originale_applica', 'video_arrivi_recupera')
     ORDER BY 1`,
    conn,
  )

describe('l\'installazione', () => {
  it('RIAPPLICATA due volte di fila: nessun errore, un solo trigger, le funzioni identiche', async () => {
    const trigger = () =>
      conta(`pg_trigger WHERE tgrelid = 'storage.objects'::regclass AND NOT tgisinternal AND tgname = 'trg_video_originale_arrivato'`)
    const prima = await impronteFunzioni(db)
    await db.exec(MIGRAZIONE_B)
    await db.exec(MIGRAZIONE_B)
    expect(await trigger()).toBe(1)
    expect(await impronteFunzioni(db)).toEqual(prima)
    // E funziona ancora: la riapplicazione non ha lasciato un trigger doppio che scatti due volte.
    const { jobId, percorso } = await apriGalleria('riapplicata')
    await deposita(percorso, { size: 5000 })
    expect((await job(jobId)).status).toBe('queued')
    expect(await eventi('video-originale-arrivato')).toHaveLength(1)
  })

  it('SENZA `storage.objects` (il database della CI, PGlite) la migrazione PASSA: le funzioni ci sono, il trigger no, e un error lo dice', async () => {
    const conn = await costruisci({ storage: false })
    try {
      expect(await impronteFunzioni(conn)).toHaveLength(3)
      expect(await conta(`pg_trigger WHERE tgname = 'trg_video_originale_arrivato'`, conn)).toBe(0)
      expect(await eventi('video-arrivo-originale-migration', conn)).toMatchObject([
        { livello: 'error', code: 'STORAGE_OBJECTS_ASSENTE', contesto: { trigger_installato: false } },
      ])
    } finally {
      await conn.close()
    }
  }, 60_000)

  it('SENZA il privilegio TRIGGER su storage.objects la migrazione PASSA, non installa niente, e un error lo dice', async () => {
    const conn = await costruisci({ conB: false })
    try {
      // `postgres` di Supabase non è il proprietario di `storage.objects`: ha (o può non avere) il solo
      // privilegio TRIGGER. Qui si esegue il file con un ruolo che NON ce l'ha.
      await conn.exec(`
        CREATE ROLE migratore NOLOGIN;
        GRANT USAGE, CREATE ON SCHEMA public TO migratore;
        GRANT USAGE ON SCHEMA storage TO migratore;
        GRANT SELECT ON storage.objects TO migratore;
        GRANT EXECUTE ON FUNCTION public._video_job_transition_log(text, text, uuid, uuid, text, jsonb) TO migratore;
      `)
      await conn.exec(`SET ROLE migratore`)
      try {
        await conn.exec(MIGRAZIONE_B)
      } finally {
        await conn.exec(`RESET ROLE`)
      }
      expect(await conta(`pg_trigger WHERE tgname = 'trg_video_originale_arrivato'`, conn)).toBe(0)
      expect(await eventi('video-arrivo-originale-migration', conn)).toMatchObject([
        { livello: 'error', code: 'TRIGGER_NON_CONCESSO', contesto: { trigger_installato: false } },
      ])
    } finally {
      await conn.close()
    }
  }, 60_000)

  it('un trigger installato scrive un info di successo (senza, «nessun log» non distingue «ok» da «mai partito»)', async () => {
    const conn = await costruisci()
    try {
      expect(await eventi('video-arrivo-originale-migration', conn)).toMatchObject([
        { livello: 'info', contesto: { trigger_installato: true, funzioni: 3 } },
      ])
    } finally {
      await conn.close()
    }
  }, 60_000)

  it('è RETROCOMPATIBILE: su un database che ha già job in attesa (la produzione di oggi) l\'applicazione non li tocca', async () => {
    const conn = await costruisci({ conB: false })
    try {
      const { jobId, percorso } = await apriGalleria('gia-in-attesa', {}, conn)
      await conn.query(`INSERT INTO storage.objects(bucket_id, name, metadata) VALUES ('video_originals', $1, $2::jsonb)`, [percorso, metadati({})])
      const prima = await job(jobId, conn)
      await conn.exec(MIGRAZIONE_B)
      // L'oggetto c'era prima del trigger: nessun evento, quindi nessuna transizione. A portarlo in coda
      // sarà la rete, al primo giro.
      expect(await job(jobId, conn)).toEqual(prima)
      expect(await rpc(`public.video_arrivi_recupera(10)`, conn)).toMatchObject({ ok: true, candidati: 1, arrivati: 1 })
    } finally {
      await conn.close()
    }
  }, 60_000)
})

// ─────────────────────────────────────────────────────────────────────────────
// 9 · L'INTERRUTTORE D'EMERGENZA — le righe della testata, eseguite davvero
// ─────────────────────────────────────────────────────────────────────────────

describe('l\'interruttore d\'emergenza della testata', () => {
  /** Le righe fra i due marcatori, senza il prefisso di commento: è ciò che chi è in emergenza incolla. */
  function istruzioneDiEmergenza(): string {
    const righeTesta = MIGRAZIONE_B.split('\n')
    const inizio = righeTesta.findIndex((r) => r.includes('>>> INTERRUTTORE: INIZIO'))
    const fine = righeTesta.findIndex((r) => r.includes('>>> INTERRUTTORE: FINE'))
    expect(inizio, 'manca il marcatore di inizio dell\'interruttore nella testata').toBeGreaterThanOrEqual(0)
    expect(fine, 'manca il marcatore di fine dell\'interruttore nella testata').toBeGreaterThan(inizio)
    return righeTesta
      .slice(inizio + 1, fine)
      .map((r) => r.replace(/^--\s?/, ''))
      .join('\n')
  }

  it('l\'istruzione è SQL vero, tiene SECURITY DEFINER e search_path, e NEUTRALIZZA il trigger: l\'upload riesce e il job non si muove', async () => {
    const istruzione = istruzioneDiEmergenza()
    expect(istruzione).toMatch(/CREATE OR REPLACE FUNCTION public\.video_originale_arrivato\(\)/)
    expect(istruzione).toMatch(/SECURITY DEFINER/)
    expect(istruzione).toMatch(/SET search_path = pg_catalog/)
    expect(istruzione, 'neutralizzare non vuol dire cancellare: niente DELETE, niente DROP').not.toMatch(/\b(DELETE|DROP)\b/i)

    await inUnaTransazioneDaButtare(async () => {
      await db.exec(istruzione)
      const { jobId, percorso } = await apriGalleria('emergenza-1')

      await deposita(percorso, { size: 5000 })

      expect(await contaOggetti(), 'l\'upload riesce').toBe(1)
      expect(await job(jobId), 'il trigger c\'è ancora ma non fa più niente').toMatchObject({ status: 'awaiting_upload', arrivato: false })
      expect(await eventi('video-originale-arrivato')).toEqual([])
      expect(await conta(`pg_trigger WHERE tgname = 'trg_video_originale_arrivato'`)).toBe(1)

      // La rete, invece, continua a lavorare: è il motivo per cui l'interruttore non lascia i video fermi.
      expect(await rpc(`public.video_arrivi_recupera(10)`)).toMatchObject({ ok: true, arrivati: 1 })
      expect((await job(jobId)).status).toBe('queued')
    })
  })

  it('e RIAPPLICARE il file lo rimette com\'era', async () => {
    await inUnaTransazioneDaButtare(async () => {
      await db.exec(istruzioneDiEmergenza())
      await db.exec(MIGRAZIONE_B)
      const { jobId, percorso } = await apriGalleria('emergenza-2')
      await deposita(percorso, { size: 5000 })
      expect((await job(jobId)).status).toBe('queued')
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 10 · IL LOG NON PERDE NIENTE E NON DICE TROPPO
// ─────────────────────────────────────────────────────────────────────────────

describe('igiene del log', () => {
  it('dopo una batteria di arrivi, rifiuti e sostituzioni il log non contiene un percorso, un eTag, un mime o il proprietario', async () => {
    const a = await apriGalleria('igiene-a')
    const b = await apriGalleria('igiene-b', { byte: 5000 })
    const c = await apriGalleria('igiene-c')
    await deposita(a.percorso, { size: 5000, etag: '"ETAG-A-RISERVATO"' })
    await deposita(b.percorso, { size: 10, etag: '"ETAG-B-RISERVATO"' })
    await deposita(c.percorso, { size: 5000, etag: '"ETAG-C-1"' })
    await deposita(c.percorso, { size: 5000, etag: '"ETAG-C-2"' })
    await deposita(`${OWNER}/orfano-riservato.mp4`, { size: 5000 })

    const log = await tuttoIlLog()
    for (const vietato of [OWNER, '.mp4', 'ETAG-', 'video/mp4', 'orfano-riservato', 'igiene-a']) {
      expect(log, `il log contiene «${vietato}»`).not.toContain(vietato)
    }
  })

  it('ogni evento di questo file ha un livello e un job (tranne l\'oggetto senza job e il riepilogo del giro)', async () => {
    const a = await apriGalleria('ev-a')
    await deposita(a.percorso, { size: 5000 })
    const senzaJob = await righe<{ evento: string }>(`
      SELECT payload -> 0 ->> 'evento' AS evento FROM public.log_migrazioni
      WHERE payload -> 0 ->> 'evento' LIKE 'video-originale-%' AND payload -> 0 -> 'contesto' ->> 'job_id' IS NULL
    `)
    expect(senzaJob).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 11 · LA TESTATA NON MENTE SUI LOG (un elenco di eventi che invecchia è peggio di nessun elenco)
// ─────────────────────────────────────────────────────────────────────────────

describe('la testata elenca gli eventi di log che il codice scrive davvero', () => {
  /** Il testo senza le righe di commento: ciò che gira. */
  const codice = MIGRAZIONE_B.split('\n').filter((r) => !/^\s*--/.test(r)).join('\n')
  const testata = MIGRAZIONE_B.split('\n').filter((r) => /^\s*--/.test(r)).join('\n')

  const eventiNelCodice = [...codice.matchAll(/_video_job_transition_log\(\s*'(video-[a-z0-9-]+)'/g)].map((m) => m[1])

  it('ogni evento scritto dal codice è nella testata, e viceversa (tranne il calcio, che è di un\'altra funzione)', () => {
    expect(eventiNelCodice.length, 'l\'estrattore non vede più le chiamate al log').toBeGreaterThanOrEqual(10)
    const nelCodice = new Set(eventiNelCodice)
    const nonElencati = [...nelCodice].filter((e) => !testata.includes(e))
    expect(nonElencati, 'eventi di log scritti dalla migrazione e assenti dalla tabella della testata').toEqual([])

    // La tabella della testata: le righe `--   video-xxx   livello   …`.
    const elencati = [...testata.matchAll(/^--\s+(video-[a-z0-9-]+)\s+(?:info|warn|error)\b/gm)].map((m) => m[1])
    expect(elencati.length, 'la tabella degli eventi non si legge più').toBeGreaterThanOrEqual(10)
    const nonScritti = elencati.filter((e) => !nelCodice.has(e) && e !== 'video-runner-kick')
    expect(nonScritti, 'eventi elencati nella testata che il codice non scrive più').toEqual([])
  })

  it('gli eventi sono quelli della spec §16 (con il prefisso `video-` di tutti gli eventi SQL del dominio)', () => {
    for (const evento of [
      'video-originale-arrivato',
      'video-originale-risorto',
      'video-originale-diverso',
      'video-originale-sostituito',
      'video-arrivo-trigger-eccezione',
      'video-arrivo-recuperato-dal-giro',
    ]) {
      expect(eventiNelCodice, `${evento} non è scritto dalla migrazione`).toContain(evento)
    }
  })
})

