// @vitest-environment node

/**
 * L'OBLIO ARRIVA AI BAMBINI SCELTI SUGLI INTENTI DEI VIDEO — `video_intents.tag_alunni`.
 *
 * La PR 2 «server e web» dei video sposta i bambini dal browser al server: l'insegnante li sceglie PRIMA di
 * caricare, e finché il video non è pubblicato vivono sull'intento (`video_intents.tag_alunni`, un array di
 * uuid di MINORI). È un luogo nuovo, in una tabella che non è `galleria_media_v2`, e nessun passo
 * dell'oblio ci arrivava: dopo una richiesta di cancellazione l'identificativo del bambino sarebbe rimasto
 * lì fino alla minimizzazione (sette giorni dalla conclusione). `anonimizzaAlunno` ora chiama
 * `video_intent_oblio_alunno`, e questo file è la PROVA DI MUTAZIONE di quella chiamata: tolta, i test sulla
 * funzione vera diventano rossi perché il bambino resta nella tabella.
 *
 * ─── TRE LIVELLI, E PERCHÉ SONO TRE ──────────────────────────────────────────────────────────────────────
 *
 *  1. PGlite con le migrazioni VERE (file A e file C della PR 2, lette dal disco): prova COSA SUCCEDE alle
 *     righe — il bambino esce da tutti gli intenti, e solo lui; un intento che resta senza nessuno si revoca
 *     e la sua uscita riceve la scadenza; un video di gruppo non si tocca; il bambino non entra mai nel log
 *     SQL. Un finto che rispondesse «ok» a tutto direbbe di sì anche a un oblio che non toglie niente.
 *  2. `anonimizzaAlunno` su un client che inoltra la RPC a PGlite: prova che l'oblio la CHIAMA, con il
 *     solo uuid del bambino, e che l'effetto arriva alla tabella.
 *  3. Un client finto con le risposte che PostgREST davvero dà quando qualcosa va storto: PostgREST non
 *     lancia, ritorna `{ error }`, e una RPC può rispondere `{ ok: false }`. Un oblio che non è riuscito
 *     non deve passare per «zero intenti»: va nel conteggio `lettureFallite`, e da lì nell'`oblio-parziale`
 *     che le route dell'oblio dichiarano a chi risponde alla Direzione.
 *
 * ─── COSA QUESTO FILE NON DIMOSTRA ───────────────────────────────────────────────────────────────────────
 *
 * Che il file del video in `video_processing` esca: lo fa la purga (`/api/gdpr/retention-video`), provata in
 * `__tests__/api/gdpr-retention-video.test.ts`. L'oblio qui accorcia soltanto il termine (la scadenza
 * dell'uscita diventa «adesso»), e il registro dell'oblio lo dichiara (`REGISTRO_BUCKET_OBLIO`).
 */

import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { anonimizzaAlunno, obliaIntentiVideoAlunno } from '@/lib/gdpr/esegui'
import { creaFintoSupabase, type DBFinto } from '../fixtures/finto-supabase'

// Le spie sul logger servono a dimostrare che il guasto ARRIVA nel canale degli errori, non solo nel valore
// di ritorno (un oblio parziale che nessuno vede è indistinguibile da uno riuscito). Si preserva il resto
// del modulo, che altri import usano davvero.
const spie = vi.hoisted(() => ({ logEvento: vi.fn(), logErrore: vi.fn() }))
vi.mock('@/lib/logging/logger', async (originale) => {
  const vero = await originale<typeof import('@/lib/logging/logger')>()
  return { ...vero, logEvento: spie.logEvento, logErrore: spie.logErrore }
})

const AT = '2026-10-02T09:00:00Z'
const NOSTRO = 'aaaaaaaa-0000-4000-8000-00000000000a'
const ALTRO = 'bbbbbbbb-0000-4000-8000-00000000000b'
const TERZO = 'cccccccc-0000-4000-8000-00000000000c'

// ═══════════════════════════════════════════════════════════════════════════════
// 1. PGlite CON LE MIGRAZIONI VERE
// ═══════════════════════════════════════════════════════════════════════════════

const CARTELLA_MIGRAZIONI = join(process.cwd(), 'supabase/migrations')
const leggi = (file: string): string => readFileSync(join(CARTELLA_MIGRAZIONI, file), 'utf8')

/** Il file che finisce con quel suffisso, e uno solo: i file della PR nascono con un timestamp provvisorio. */
function trovaPerSuffisso(suffisso: string): string {
  const trovati = readdirSync(CARTELLA_MIGRAZIONI).filter((f) => f.endsWith(suffisso))
  if (trovati.length !== 1) {
    throw new Error(
      `Cerco in supabase/migrations/ UN file che finisce con «${suffisso}» e ne trovo ${trovati.length} ` +
        `(${trovati.join(', ') || 'nessuno'}). Se la migrazione è stata rinominata con la version registrata, ` +
        `il suffisso deve restare lo stesso.`,
    )
  }
  return trovati[0]
}

// Le migrazioni già in produzione (PR 1 compresa), nell'ordine di applicazione, e quelle di questa PR.
const MIGRAZIONI = [
  leggi('20260916190000_video_jobs.sql'),
  leggi('20260916190100_video_job_transitions.sql'),
  leggi('20260916190200_video_intent_lifecycle.sql'),
  leggi('20260917210000_video_job_next.sql'),
  leggi('20260918110000_video_retention_riconciliazione.sql'),
  leggi(trovaPerSuffisso('_video_build_bucket.sql')),
  leggi(trovaPerSuffisso('_video_job_ritentativi.sql')),
  leggi(trovaPerSuffisso('_video_pubblicazione_automatica.sql')),
  leggi(trovaPerSuffisso('_video_conservazione_uscite.sql')),
]

const SEDE = '10000000-0000-4000-8000-000000000001'
const OWNER = '20000000-0000-4000-8000-000000000002'

let db: PGlite

/** Il database senza nessuna migrazione: ruoli, Storage, tabelle d'appoggio e il log di installazione. */
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
    INSERT INTO auth.users(id) VALUES ('${OWNER}');
    INSERT INTO public.utenti(id, scuola_id) VALUES ('${OWNER}', '${SEDE}');
  `)
}

type StatoIntento = 'pending' | 'confirmed' | 'action_required' | 'published' | 'cancelled'

type OpzioniSeme = {
  stato?: StatoIntento
  /** I bambini scelti. Vuoto con `broadcast` = un video per tutta la classe. */
  tag: string[]
  broadcast?: boolean
  /** Un job `ready` con la sua uscita convertita in `video_processing`, e senza scadenza. */
  conUscita?: boolean
}

const uuids = (xs: string[]): string =>
  xs.length === 0 ? `'{}'::uuid[]` : `ARRAY[${xs.map((x) => `'${x}'`).join(', ')}]::uuid[]`

/**
 * Un intento di galleria (e, se serve, il suo job pronto) scritto DIRETTAMENTE, rispettando i vincoli: qui
 * interessa l'effetto dell'oblio su uno stato, non il modo in cui ci si arriva.
 */
async function semina(opz: OpzioniSeme): Promise<{ intentId: string; jobId: string | null }> {
  const stato = opz.stato ?? 'confirmed'
  const intentId = randomUUID()
  const confermato = ['confirmed', 'action_required', 'published'].includes(stato)
  const revocato = stato === 'cancelled'
  const pubblicato = stato === 'published'

  await db.exec(`
    INSERT INTO public.video_intents (
      id, owner_id, scuola_id, channel, requested_action, payload, status,
      confirmed_at, revoked_at, published_at, created_at, updated_at,
      pubblicazione_automatica, tag_alunni, broadcast, n_tag
    ) VALUES (
      '${intentId}', '${OWNER}', '${SEDE}', 'gallery', 'publish', '{"scope":"sede"}', '${stato}',
      ${confermato ? `now() - interval '1 day'` : 'NULL'},
      ${revocato ? `now() - interval '1 day'` : 'NULL'},
      ${pubblicato ? `now() - interval '1 day'` : 'NULL'},
      now() - interval '2 days', now() - interval '1 day',
      true, ${uuids(opz.tag)}, ${opz.broadcast ?? false}, ${opz.tag.length}
    )
  `)
  if (!opz.conUscita) return { intentId, jobId: null }

  const jobId = randomUUID()
  await db.exec(`
    INSERT INTO public.video_jobs (
      id, owner_id, scuola_id, channel, idempotency_key, intent_id, status,
      original_path, source_size, source_mime,
      output_bucket, output_path, output_size, probe_json,
      verified_at, original_delete_after, created_at, updated_at
    ) VALUES (
      '${jobId}', '${OWNER}', '${SEDE}', 'gallery', 'k-${jobId}', '${intentId}', 'ready',
      'originals/${jobId}/source', 5000, 'video/mp4',
      'video_processing', 'outputs/${jobId}/final.mp4', 900, '{"durationSeconds":20}'::jsonb,
      now() - interval '1 day', now() + interval '6 days', now() - interval '2 days', now() - interval '1 day'
    )
  `)
  return { intentId, jobId }
}

type RigaIntento = { status: string; tag_alunni: string[]; n_tag: number; broadcast: boolean }
const intento = async (id: string): Promise<RigaIntento> =>
  (
    await db.query<RigaIntento>(
      `SELECT status, tag_alunni, n_tag, broadcast FROM public.video_intents WHERE id = '${id}'`,
    )
  ).rows[0]

type RigaJob = { status: string; output_delete_after: string | null; vicino_adesso: boolean | null }
const job = async (id: string): Promise<RigaJob> =>
  (
    await db.query<RigaJob>(`
      SELECT status, output_delete_after::text,
             abs(extract(epoch FROM (output_delete_after - clock_timestamp()))) < 120 AS vicino_adesso
      FROM public.video_jobs WHERE id = '${id}'
    `)
  ).rows[0]

/** Tutto ciò che le funzioni video hanno scritto nel log, come un unico testo. */
async function tuttoIlLog(): Promise<string> {
  const { rows } = await db.query<{ payload: unknown }>('SELECT payload FROM public.log_migrazioni')
  return JSON.stringify(rows.map((r) => r.payload))
}

/** La RPC dell'oblio, inoltrata a PGlite: la funzione VERA al posto di un finto che dice sempre «ok». */
const rpcSuPglite = async (args: Record<string, unknown>) => {
  const { rows } = await db.query<{ risultato: unknown }>(
    'SELECT public.video_intent_oblio_alunno(p_alunno => $1) AS risultato',
    [args.p_alunno],
  )
  return { data: rows[0].risultato, error: null }
}

describe('l’oblio sugli intenti, con le migrazioni VERE', () => {
  beforeAll(async () => {
    db = new PGlite()
    await preparaStub(db)
    for (const sql of MIGRAZIONI) await db.exec(sql)
  }, 120_000)

  afterAll(async () => {
    await db.close()
  })

  beforeEach(async () => {
    spie.logEvento.mockClear()
    spie.logErrore.mockClear()
    await db.exec(`
      TRUNCATE public.video_outbox, public.video_jobs, public.video_intents,
               public.galleria_media_v2, public.log_migrazioni
    `)
  })

  /** Esegue l'oblio vero di un alunno, con la RPC degli intenti inoltrata al database. */
  const obliaSuPglite = (alunnoId: string) =>
    anonimizzaAlunno(
      creaFintoSupabase({}, [], { rpc: { video_intent_oblio_alunno: rpcSuPglite } }),
      { id: alunnoId },
      AT,
      'test',
    )

  it('toglie il bambino da TUTTI gli intenti, qualunque sia il loro stato — e SOLO lui', async () => {
    const inCorso = await semina({ stato: 'confirmed', tag: [NOSTRO, ALTRO] })
    const inAttesa = await semina({ stato: 'pending', tag: [TERZO, NOSTRO] })
    const azione = await semina({ stato: 'action_required', tag: [NOSTRO, ALTRO] })
    const pubblicato = await semina({ stato: 'published', tag: [NOSTRO, ALTRO] })
    const annullato = await semina({ stato: 'cancelled', tag: [ALTRO, NOSTRO] })
    const altrui = await semina({ stato: 'confirmed', tag: [ALTRO, TERZO] })
    const perTutti = await semina({ stato: 'confirmed', tag: [], broadcast: true })

    const r = await obliaSuPglite(NOSTRO)

    // Il bambino non è più su nessun intento: ESATTAMENTE ciò che il passo esiste per ottenere.
    const { rows } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.video_intents WHERE '${NOSTRO}' = ANY(tag_alunni)`,
    )
    expect(rows[0].n, 'il bambino è ancora nominato da un intento dopo l’oblio').toBe(0)

    // Gli altri bambini restano, nello stesso ordine: si toglie un elemento, non si riscrive l'array.
    expect((await intento(inCorso.intentId)).tag_alunni).toEqual([ALTRO])
    expect((await intento(inAttesa.intentId)).tag_alunni).toEqual([TERZO])
    expect((await intento(azione.intentId)).tag_alunni).toEqual([ALTRO])
    expect((await intento(pubblicato.intentId)).tag_alunni).toEqual([ALTRO])
    expect((await intento(annullato.intentId)).tag_alunni).toEqual([ALTRO])
    // Controllo positivo: gli intenti che non lo nominavano non sono stati toccati.
    expect((await intento(altrui.intentId)).tag_alunni).toEqual([ALTRO, TERZO])
    expect(await intento(perTutti.intentId)).toMatchObject({ status: 'confirmed', tag_alunni: [], broadcast: true })

    // Gli stati non cambiano per chi ha ancora qualcuno a cui arrivare, e un pubblicato resta pubblicato.
    expect((await intento(inCorso.intentId)).status).toBe('confirmed')
    expect((await intento(pubblicato.intentId)).status).toBe('published')
    // `n_tag` è un numero, non identifica nessuno: resta com'era.
    expect((await intento(inCorso.intentId)).n_tag).toBe(2)

    // Il referto dell'oblio dice quanti intenti ha toccato, e nessuno è stato revocato.
    expect(r).toMatchObject({ videoIntentiTrattati: 5, videoIntentiRevocati: 0 })
  })

  it('un intento NON terminale che resta senza bambini e non è broadcast si REVOCA, e la sua uscita scade subito', async () => {
    // Non ha più nessuno a cui arrivare: pubblicarlo sarebbe pubblicare un video senza destinatari. Si
    // revoca, e il file convertito in `video_processing` riceve la scadenza «adesso» — così la purga lo
    // toglie al giro successivo invece di tenerlo fino ai sette giorni dei convertiti non pubblicati.
    const solo = await semina({ stato: 'confirmed', tag: [NOSTRO], conUscita: true })

    const r = await obliaSuPglite(NOSTRO)

    expect(await intento(solo.intentId)).toMatchObject({ status: 'cancelled', tag_alunni: [] })
    const j = await job(solo.jobId!)
    expect(j.status).toBe('cancelled')
    expect(j.output_delete_after, 'l’uscita di un video revocato non ha ricevuto la scadenza').not.toBeNull()
    expect(j.vicino_adesso, 'la scadenza dell’uscita non è «adesso»').toBe(true)
    expect(r).toMatchObject({ videoIntentiTrattati: 1, videoIntentiRevocati: 1 })
  })

  it('un video di GRUPPO non pubblicato non si revoca, e la sua uscita NON riceve la scadenza: resta fino al suo termine', async () => {
    // Dentro ci sono altri bambini: è la scelta della galleria («foto di gruppo: si toglie il tag e il file
    // resta, perché dentro c'è l'immagine di altri bambini»), e il registro la dichiara come finestra residua.
    const gruppo = await semina({ stato: 'confirmed', tag: [NOSTRO, ALTRO], conUscita: true })

    const r = await obliaSuPglite(NOSTRO)

    expect(await intento(gruppo.intentId)).toMatchObject({ status: 'confirmed', tag_alunni: [ALTRO] })
    const j = await job(gruppo.jobId!)
    expect(j.status).toBe('ready')
    expect(j.output_delete_after).toBeNull()
    expect(r).toMatchObject({ videoIntentiTrattati: 1, videoIntentiRevocati: 0 })
  })

  it('un intento PUBBLICATO con il solo bambino perde il bambino ma resta pubblicato: il video non si ritira', async () => {
    // Il video pubblicato vive in `gallery` e lì lo raggiunge l'oblio delle foto; l'intento è un residuo
    // (di norma ha già `tag_alunni` vuoto: la pubblicazione lo svuota), e non c'è niente da revocare.
    const pubblicato = await semina({ stato: 'published', tag: [NOSTRO] })

    const r = await obliaSuPglite(NOSTRO)

    expect(await intento(pubblicato.intentId)).toMatchObject({ status: 'published', tag_alunni: [] })
    expect(r).toMatchObject({ videoIntentiTrattati: 1, videoIntentiRevocati: 0 })
  })

  it('un bambino che non è su nessun intento: zero e zero, e nessun intento cambia', async () => {
    const altrui = await semina({ stato: 'confirmed', tag: [ALTRO], conUscita: true })

    const r = await obliaSuPglite(NOSTRO)

    expect(r).toMatchObject({ videoIntentiTrattati: 0, videoIntentiRevocati: 0 })
    expect(await intento(altrui.intentId)).toMatchObject({ status: 'confirmed', tag_alunni: [ALTRO] })
    expect((await job(altrui.jobId!)).output_delete_after).toBeNull()
  })

  it('è idempotente: il secondo oblio dello stesso bambino non trova più niente', async () => {
    await semina({ stato: 'confirmed', tag: [NOSTRO, ALTRO] })

    await obliaSuPglite(NOSTRO)
    const secondo = await obliaSuPglite(NOSTRO)

    expect(secondo).toMatchObject({ videoIntentiTrattati: 0, videoIntentiRevocati: 0 })
  })

  it('il bambino NON entra mai nei log: né in quello dell’oblio, né nel registro delle transizioni SQL', async () => {
    // È un archivio di minori: il registro dell'oblio non deve lasciare l'identificativo che sta cancellando.
    await semina({ stato: 'confirmed', tag: [NOSTRO], conUscita: true })
    await semina({ stato: 'confirmed', tag: [NOSTRO, ALTRO] })

    await obliaSuPglite(NOSTRO)

    const logSql = await tuttoIlLog()
    expect(logSql, 'la funzione SQL ha scritto nel log che si sta occupando di quel bambino').not.toContain(NOSTRO)
    // E il log SQL dice che ha lavorato (il successo si logga anche qui).
    expect(logSql).toContain('video-intent-oblio-alunno')
    const logApp = JSON.stringify([...spie.logEvento.mock.calls, ...spie.logErrore.mock.calls])
    expect(logApp).not.toContain(NOSTRO)
    // Il successo dell'applicazione sì: un `info` coi soli conteggi.
    const riga = spie.logEvento.mock.calls.find((c) => (c[2] as { esito?: string })?.esito === 'oblio-video-intenti')
    expect(riga?.[1]).toBe('info')
    expect(riga?.[2]).toMatchObject({ operazione: 'test', n_intenti: 2, n_revocati: 1 })
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 2. L'OBLIO CHIAMA LA RPC, E NE CONTROLLA IL VALORE DI RITORNO (client finto)
// ═══════════════════════════════════════════════════════════════════════════════

type RispostaRpc = { data: unknown; error: unknown }

/** Un oblio su un client finto: la RPC risponde come gli si dice, e ogni sua chiamata è registrata. */
function oblioConRisposta(risposta: RispostaRpc | (() => RispostaRpc)) {
  const chiamate: Record<string, unknown>[] = []
  const database: DBFinto = { alunni: [{ id: NOSTRO, nome: 'NOME DI PROVA', cognome: 'COGNOME DI PROVA' }] }
  const client = creaFintoSupabase(database, [], {
    rpc: {
      video_intent_oblio_alunno: async (args) => {
        chiamate.push(args)
        return typeof risposta === 'function' ? risposta() : risposta
      },
    },
  })
  return { client, chiamate, database }
}

const OK_ZERO: RispostaRpc = { data: { ok: true, intenti: 0, revocati: 0 }, error: null }

describe('l’oblio dei video in volo: chiamata e controllo del valore di ritorno', () => {
  beforeEach(() => {
    spie.logEvento.mockClear()
    spie.logErrore.mockClear()
  })

  it('anonimizzaAlunno chiama `video_intent_oblio_alunno` UNA volta, col solo uuid del bambino', async () => {
    const { client, chiamate } = oblioConRisposta(OK_ZERO)

    await anonimizzaAlunno(client, { id: NOSTRO }, AT, 'test')

    expect(chiamate, 'l’oblio non chiama più `video_intent_oblio_alunno`').toEqual([{ p_alunno: NOSTRO }])
  })

  it('una RPC che NON risponde ({ error }) non è «zero intenti»: si conta fra le letture fallite e si grida', async () => {
    // PostgREST non lancia: ritorna `{ error }`. Senza il controllo si andrebbe avanti dichiarando un oblio
    // completo mentre l'identificativo del bambino è ancora su `video_intents`.
    const base = await anonimizzaAlunno(oblioConRisposta(OK_ZERO).client, { id: NOSTRO }, AT, 'test')
    spie.logErrore.mockClear()
    const errore = { code: '57014', message: 'canceling statement due to statement timeout' }
    const { client } = oblioConRisposta({ data: null, error: errore })

    const r = await anonimizzaAlunno(client, { id: NOSTRO }, AT, 'test')

    expect(r.lettureFallite, 'un oblio non riuscito non si conta fra le letture fallite').toBe(base.lettureFallite + 1)
    expect(r.videoIntentiTrattati).toBe(0)
    const grido = spie.logErrore.mock.calls.find((c) => (c[0] as { evento?: string }).evento === 'oblio_video_intenti')
    expect(grido, 'il guasto non è arrivato nel canale degli errori').toBeDefined()
    expect(grido?.[1]).toBe(errore)
  })

  it('una RPC che RIFIUTA ({ ok: false }) è un guasto con il suo codice, non un successo', async () => {
    const base = await anonimizzaAlunno(oblioConRisposta(OK_ZERO).client, { id: NOSTRO }, AT, 'test')
    spie.logEvento.mockClear()
    const { client } = oblioConRisposta({ data: { ok: false, code: 'BAD_INPUT' }, error: null })

    const r = await anonimizzaAlunno(client, { id: NOSTRO }, AT, 'test')

    expect(r.lettureFallite).toBe(base.lettureFallite + 1)
    const riga = spie.logEvento.mock.calls.find((c) => (c[2] as { esito?: string })?.esito === 'oblio-video-intenti-rifiutato')
    expect(riga?.[1]).toBe('error')
    expect(riga?.[2]).toMatchObject({ operazione: 'test', error_code: 'BAD_INPUT' })
    // Il successo NON si dichiara.
    expect(spie.logEvento.mock.calls.some((c) => (c[2] as { esito?: string })?.esito === 'oblio-video-intenti')).toBe(false)
  })

  it('una risposta senza corpo (`data` nullo) non è un successo: «non so» non è «fatto»', async () => {
    const base = await anonimizzaAlunno(oblioConRisposta(OK_ZERO).client, { id: NOSTRO }, AT, 'test')
    const { client } = oblioConRisposta({ data: null, error: null })

    const r = await anonimizzaAlunno(client, { id: NOSTRO }, AT, 'test')

    expect(r.lettureFallite).toBe(base.lettureFallite + 1)
  })

  it('lo schema che non c’è (DB E2E della CI non migrato, PGRST202) degrada in silenzio: non c’è niente da obliare', async () => {
    const base = await anonimizzaAlunno(oblioConRisposta(OK_ZERO).client, { id: NOSTRO }, AT, 'test')
    spie.logErrore.mockClear()
    const { client } = oblioConRisposta({ data: null, error: { code: 'PGRST202', message: 'function not found' } })

    const r = await anonimizzaAlunno(client, { id: NOSTRO }, AT, 'test')

    expect(r.lettureFallite).toBe(base.lettureFallite)
    expect(spie.logErrore.mock.calls.some((c) => (c[0] as { evento?: string }).evento === 'oblio_video_intenti')).toBe(false)
  })

  it('un guasto della RPC NON ferma il resto dell’oblio: l’anagrafica è anonimizzata lo stesso', async () => {
    // L'oblio è una sequenza di passi non atomici: un passo che non riesce si dichiara e gli altri girano.
    const { client, database } = oblioConRisposta({ data: null, error: { code: '57014', message: 'timeout' } })

    await anonimizzaAlunno(client, { id: NOSTRO }, AT, 'test')

    const riga = (database.alunni as { id: string; nome: string; anonimizzato_il?: string }[])[0]
    expect(riga.nome, 'l’anagrafica non è stata anonimizzata').not.toBe('NOME DI PROVA')
    expect(riga.anonimizzato_il).toBe(AT)
  })

  it('il successo si logga anche a ZERO (`info`, solo conteggi): «nessun log» non dice «il passo non è partito»', async () => {
    const { client } = oblioConRisposta(OK_ZERO)

    await anonimizzaAlunno(client, { id: NOSTRO }, AT, 'test')

    const riga = spie.logEvento.mock.calls.find((c) => (c[2] as { esito?: string })?.esito === 'oblio-video-intenti')
    expect(riga?.[1]).toBe('info')
    expect(riga?.[2]).toEqual({ operazione: 'test', esito: 'oblio-video-intenti', n_intenti: 0, n_revocati: 0 })
  })

  it('i conteggi della RPC tornano nel referto dell’oblio, e un campo che non è un numero vale zero', async () => {
    const { client } = oblioConRisposta({ data: { ok: true, intenti: 3, revocati: 1 }, error: null })
    const r = await anonimizzaAlunno(client, { id: NOSTRO }, AT, 'test')
    expect(r).toMatchObject({ videoIntentiTrattati: 3, videoIntentiRevocati: 1 })

    const { client: storto } = oblioConRisposta({ data: { ok: true, intenti: '3', revocati: null }, error: null })
    const rStorto = await anonimizzaAlunno(storto, { id: NOSTRO }, AT, 'test')
    expect(rStorto).toMatchObject({ videoIntentiTrattati: 0, videoIntentiRevocati: 0 })
  })

  it('`obliaIntentiVideoAlunno` da sola: il valore di ritorno, nei tre casi', async () => {
    const rpc = (risposta: RispostaRpc) => ({ rpc: async () => risposta }) as never

    await expect(obliaIntentiVideoAlunno(rpc(OK_ZERO), NOSTRO, 'test')).resolves.toEqual({
      intenti: 0,
      revocati: 0,
      letto: true,
    })
    await expect(
      obliaIntentiVideoAlunno(rpc({ data: { ok: true, intenti: 4, revocati: 2 }, error: null }), NOSTRO, 'test'),
    ).resolves.toEqual({ intenti: 4, revocati: 2, letto: true })
    await expect(
      obliaIntentiVideoAlunno(rpc({ data: null, error: { code: '57014' } }), NOSTRO, 'test'),
    ).resolves.toEqual({ intenti: 0, revocati: 0, letto: false })
  })
})
