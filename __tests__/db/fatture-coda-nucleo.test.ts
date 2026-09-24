// @vitest-environment node

/**
 * Coda fatture Aruba, NUCLEO — la migrazione `20260923102831_fatture_coda_nucleo.sql`
 * eseguita su PGlite dal FILE VERO della cartella delle migrazioni, seguita dalla
 * correzione della consegna 2a `<version>_fatture_coda_togli_azzera_esito.sql` (rilievo b:
 * «Togli» azzera anche `esito_codice` ed `esito_messaggio`), trovata per suffisso, e da
 * quella della consegna 2b `<version>_fatture_coda_chiudi_emessa_azzera_messaggio.sql`
 * (D13: la chiusura «emessa» azzera sempre `esito_messaggio`), trovata allo stesso modo,
 * e infine dalla correzione del 24/09 `<version>_fatture_coda_distanza_accessi.sql`
 * (65 s fra due accessi ad Aruba della coda: `prendi` non consegna prima, e `prendi` e
 * `rilascia` timbrano `ultimo_accesso_il`), trovata allo stesso modo.
 *
 * Stesso impianto di `__tests__/lib/video-job-next.test.ts`: i ruoli di Supabase
 * ricostruiti a mano, le sole tabelle toccate dalla migrazione (`schools`, `pagamenti`,
 * `app_log`), e al posto del Vault, di pg_net e di pg_cron tre sostituti minimi che
 * REGISTRANO come sono stati chiamati. L'SQL delle RPC non è mai ricopiato qui: un test
 * che prova una copia resta verde il giorno in cui la copia e il file divergono.
 *
 * ⚠️ QUELLO CHE QUESTO FILE **NON** DIMOSTRA, detto in testa e non in fondo.
 *
 * PGlite è a CONNESSIONE SINGOLA. Il `FOR UPDATE SKIP LOCKED` e l'advisory lock di
 * `fatture_coda_prendi` esistono per due giri DAVVERO simultanei, e qui due transazioni
 * simultanee non si possono avere: nessuna riga risulta mai «bloccata da un altro».
 * Il «lavoratore unico» si prova quindi dal lato che si vede su una connessione sola —
 * il testimone in `fatture_coda_stato`: un secondo giro con un altro token, mentre il
 * primo è vivo, riceve un insieme vuoto. La prova con due connessioni vere richiede il
 * contenitore `supabase/postgres` della CI o un `pg` locale.
 *
 * Tutti gli uuid sono palesemente finti: nessuna sede, nessun pagamento, nessun utente
 * veri (il repository è pubblico).
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { senzaCommenti, toccaLaRls, toccaLeFkUtenti, toccaUnUnico } from '../architecture/soglia-fotografia'

const NOME_FILE = '20260923102831_fatture_coda_nucleo.sql'
const MIGRAZIONE = readFileSync(join(process.cwd(), 'supabase/migrations', NOME_FILE), 'utf8')

const CARTELLA_MIGRAZIONI = join(process.cwd(), 'supabase/migrations')
const SUFFISSO_TOGLI = '_fatture_coda_togli_azzera_esito.sql'
const TROVATI_TOGLI = readdirSync(CARTELLA_MIGRAZIONI).filter((nome) => nome.endsWith(SUFFISSO_TOGLI))
const NOME_TOGLI = TROVATI_TOGLI[0] ?? ''
const TOGLI_AZZERA = NOME_TOGLI ? readFileSync(join(CARTELLA_MIGRAZIONI, NOME_TOGLI), 'utf8') : ''

const SUFFISSO_CHIUDI = '_fatture_coda_chiudi_emessa_azzera_messaggio.sql'
const TROVATI_CHIUDI = readdirSync(CARTELLA_MIGRAZIONI).filter((nome) => nome.endsWith(SUFFISSO_CHIUDI))
const NOME_CHIUDI = TROVATI_CHIUDI[0] ?? ''
const CHIUDI_AZZERA = NOME_CHIUDI ? readFileSync(join(CARTELLA_MIGRAZIONI, NOME_CHIUDI), 'utf8') : ''

const SUFFISSO_ACCESSI = '_fatture_coda_distanza_accessi.sql'
const TROVATI_ACCESSI = readdirSync(CARTELLA_MIGRAZIONI).filter((nome) => nome.endsWith(SUFFISSO_ACCESSI))
const NOME_ACCESSI = TROVATI_ACCESSI[0] ?? ''
const DISTANZA_ACCESSI = NOME_ACCESSI ? readFileSync(join(CARTELLA_MIGRAZIONI, NOME_ACCESSI), 'utf8') : ''

const SEDE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SEDE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const SEGRETERIA = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const ADMIN = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const TOKEN_A = 'e1000000-0000-4000-8000-000000000001'
const TOKEN_B = 'e2000000-0000-4000-8000-000000000002'
const PRESTITO_S = 330

/** L'uuid finto del pagamento n (1..255). */
const pag = (n: number) => `f0000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`

type Voce = {
  id: string
  gruppo_id: string
  gruppo_seq: string
  ordine_selezione: number
  urgente: boolean
  pagamento_id: string
  scuola_id: string
  intestatario_scelto: unknown
  conferma_proposta: boolean
  causale_manuale: string | null
  stato: string
  esito_codice: string | null
  esito_messaggio: string | null
  creato_da: string
  lavoratore_token: string | null
  tentativi: number
  presa_il: Date | null
  prestito_scade_il: Date | null
  concluso_il: Date | null
  in_attesa_dal: Date
}

type EsitoAccoda = { gruppo_id: string; accodate: number; gia_in_coda: string[] }

type VoceInput = {
  pagamento_id: string
  ordine_selezione?: number
  intestatario_scelto?: unknown
  conferma_proposta?: boolean
  causale_manuale?: string | null
}

let db: PGlite

async function preparaDatabase(opzioni: { cron?: boolean } = {}) {
  await db.exec(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

    CREATE TABLE public.schools (id uuid PRIMARY KEY);
    CREATE TABLE public.pagamenti (
      id uuid PRIMARY KEY,
      scuola_id uuid REFERENCES public.schools(id),
      data_incasso timestamptz,
      creato_il timestamptz DEFAULT CURRENT_TIMESTAMP
    );

    -- app_log: le sole colonne che la migrazione scrive, più la chiave della deduplica.
    CREATE TABLE public.app_log (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      giorno date NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')::date,
      livello text NOT NULL CHECK (livello IN ('info','warn','error')),
      evento text NOT NULL,
      sorgente text NOT NULL DEFAULT 'server',
      messaggio text NOT NULL,
      fingerprint text NOT NULL,
      occorrenze int NOT NULL DEFAULT 1,
      visto_l_ultima timestamptz NOT NULL DEFAULT now(),
      contesto jsonb NOT NULL DEFAULT '{}'::jsonb
    );
    CREATE UNIQUE INDEX app_log_impronta_giorno_key ON public.app_log (fingerprint, giorno);

    -- Il Vault finto: cron_config legge da una tabella che il test riempie.
    CREATE TABLE public.vault_finto (nome text PRIMARY KEY, valore text);
    CREATE FUNCTION public.cron_config(p_nome text) RETURNS text
    LANGUAGE sql AS $$ SELECT valore FROM public.vault_finto WHERE nome = p_nome $$;

    -- pg_net finto, con la firma vera: registra ogni chiamata.
    CREATE SCHEMA net;
    CREATE TABLE net.chiamate (
      n bigserial PRIMARY KEY, url text, headers jsonb, body jsonb, timeout_milliseconds int
    );
    CREATE FUNCTION net.http_post(
      url text,
      body jsonb DEFAULT '{}'::jsonb,
      params jsonb DEFAULT '{}'::jsonb,
      headers jsonb DEFAULT '{"Content-Type": "application/json"}'::jsonb,
      timeout_milliseconds integer DEFAULT 5000
    ) RETURNS bigint
    LANGUAGE sql AS $$
      INSERT INTO net.chiamate (url, headers, body, timeout_milliseconds)
      VALUES ($1, $4, $2, $5) RETURNING n
    $$;

    INSERT INTO public.schools (id) VALUES ('${SEDE_A}'), ('${SEDE_B}');
  `)

  if (opzioni.cron) {
    await db.exec(`
      CREATE SCHEMA cron;
      CREATE TABLE cron.job (jobid bigserial PRIMARY KEY, jobname text, schedule text, command text);
      CREATE FUNCTION cron.schedule(text, text, text) RETURNS bigint
      LANGUAGE sql AS $$ INSERT INTO cron.job (jobname, schedule, command) VALUES ($1, $2, $3) RETURNING jobid $$;
      CREATE FUNCTION cron.unschedule(bigint) RETURNS boolean
      LANGUAGE sql AS $$ DELETE FROM cron.job WHERE jobid = $1 RETURNING true $$;
    `)
  }
}

async function nuovoPagamento(
  n: number,
  opzioni: { sede?: string; incasso?: string | null; creato?: string | null } = {},
) {
  await db.query(
    `INSERT INTO public.pagamenti (id, scuola_id, data_incasso, creato_il) VALUES ($1, $2, $3, $4)`,
    [
      pag(n),
      opzioni.sede ?? SEDE_A,
      opzioni.incasso === undefined ? '2026-09-01T10:00:00Z' : opzioni.incasso,
      opzioni.creato === undefined ? '2026-08-01T10:00:00Z' : opzioni.creato,
    ],
  )
}

async function accoda(voci: VoceInput[], urgente = false, creatoDa = SEGRETERIA): Promise<EsitoAccoda> {
  const { rows } = await db.query<{ r: EsitoAccoda }>(
    `SELECT public.fatture_coda_accoda($1::jsonb, $2::uuid, $3::boolean) AS r`,
    [JSON.stringify(voci), creatoDa, urgente],
  )
  return rows[0].r
}

async function prendi(token: string, max = 15, prestito = PRESTITO_S): Promise<Voce[]> {
  const { rows } = await db.query<Voce>(
    `SELECT * FROM public.fatture_coda_prendi($1::uuid, $2::int, $3::int)`,
    [token, max, prestito],
  )
  return rows
}

async function chiudi(
  id: string,
  token: string,
  esito: string,
  codice: string | null = null,
  messaggio: string | null = null,
) {
  await db.query(`SELECT public.fatture_coda_chiudi($1::uuid, $2::uuid, $3, $4, $5)`, [
    id,
    token,
    esito,
    codice,
    messaggio,
  ])
}

async function rilascia(token: string, minuti: number, motivo: string | null) {
  await db.query(`SELECT public.fatture_coda_rilascia($1::uuid, $2::int, $3)`, [token, minuti, motivo])
}

async function bidello(): Promise<number> {
  const { rows } = await db.query<{ n: number }>(`SELECT public.fatture_coda_bidello() AS n`)
  return rows[0].n
}

async function togli(ids: string[], attore = SEGRETERIA): Promise<number> {
  const { rows } = await db.query<{ n: number }>(`SELECT public.fatture_coda_togli($1::uuid[], $2::uuid) AS n`, [
    ids,
    attore,
  ])
  return rows[0].n
}

async function rimetti(ids: string[], attore = SEGRETERIA): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `SELECT public.fatture_coda_rimetti($1::uuid[], $2::uuid) AS n`,
    [ids, attore],
  )
  return rows[0].n
}

async function sospendi(sospesa: boolean, attore = ADMIN) {
  await db.query(`SELECT public.fatture_coda_sospendi($1::uuid, $2::boolean)`, [attore, sospesa])
}

async function voceDi(n: number): Promise<Voce> {
  const { rows } = await db.query<Voce>(
    `SELECT * FROM public.fatture_coda WHERE pagamento_id = $1 ORDER BY accodata_il DESC, id LIMIT 1`,
    [pag(n)],
  )
  return rows[0]
}

async function voci(): Promise<Voce[]> {
  const { rows } = await db.query<Voce>(`SELECT * FROM public.fatture_coda ORDER BY pagamento_id, accodata_il`)
  return rows
}

type Stato = {
  sospesa: boolean
  sospesa_da: string | null
  sospesa_il: Date | null
  pausa_fino_a: Date | null
  pausa_motivo: string | null
  lavoratore_token: string | null
  lavoratore_scade_il: Date | null
  ultimo_giro_il: Date | null
  ultimo_accesso_il: Date | null
}

async function stato(): Promise<Stato> {
  const { rows } = await db.query<Stato>(`SELECT * FROM public.fatture_coda_stato WHERE id = 1`)
  return rows[0]
}

/** Come se l'ultimo accesso della coda fosse di più di 65 s fa: il giro dopo può prendere. */
async function dimenticaAccesso() {
  await db.exec(`UPDATE public.fatture_coda_stato SET ultimo_accesso_il = NULL WHERE id = 1`)
}

/** Mette l'ultimo accesso a un'espressione SQL, per esempio `now() - interval '64 seconds'`. */
async function accessoA(espressione: string) {
  await db.exec(`UPDATE public.fatture_coda_stato SET ultimo_accesso_il = ${espressione} WHERE id = 1`)
}

/** I secondi passati dall'ultimo accesso, misurati dal database. */
async function secondiDallAccesso(): Promise<number | null> {
  const { rows } = await db.query<{ s: number | null }>(
    `SELECT extract(epoch FROM now() - ultimo_accesso_il)::float8 AS s FROM public.fatture_coda_stato WHERE id = 1`,
  )
  return rows[0].s
}

/** L'errore che l'istruzione solleva, o null se passa. */
async function erroreDi(promessa: Promise<unknown>): Promise<{ code?: string; message: string } | null> {
  try {
    await promessa
    return null
  } catch (e) {
    const err = e as { code?: string; message?: string }
    return { code: err.code, message: String(err.message ?? e) }
  }
}

/** Numeri di pagamento, nell'ordine in cui la coda li ha consegnati. */
const numeri = (lista: Voce[]) => lista.map((v) => parseInt(v.pagamento_id.slice(-12), 16))

beforeEach(async () => {
  db = new PGlite()
  await preparaDatabase()
  await db.exec(MIGRAZIONE)
  if (TOGLI_AZZERA) await db.exec(TOGLI_AZZERA)
  if (CHIUDI_AZZERA) await db.exec(CHIUDI_AZZERA)
  if (DISTANZA_ACCESSI) await db.exec(DISTANZA_ACCESSI)
})

afterEach(async () => {
  await db.close()
})

// ═════════════════════════════════════════════════════════════════════════════
describe('fatture_coda · forma dello schema', () => {
  it('le due tabelle hanno la RLS accesa, nessuna policy, e nessun privilegio per anon/authenticated', async () => {
    const { rows } = await db.query<{
      tabella: string
      rls: boolean
      policy: number
      anon: boolean
      authenticated: boolean
      service: boolean
    }>(`
      SELECT c.relname AS tabella,
             c.relrowsecurity AS rls,
             (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policy,
             has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE') AS anon,
             has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE') AS authenticated,
             has_table_privilege('service_role', c.oid, 'SELECT') AS service
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname IN ('fatture_coda', 'fatture_coda_stato')
      ORDER BY c.relname
    `)
    expect(rows).toEqual([
      { tabella: 'fatture_coda', rls: true, policy: 0, anon: false, authenticated: false, service: true },
      { tabella: 'fatture_coda_stato', rls: true, policy: 0, anon: false, authenticated: false, service: true },
    ])
  })

  it('le RPC hanno le firme della spec, sono SECURITY DEFINER col search_path chiuso, e le esegue solo il service role', async () => {
    const { rows } = await db.query<{
      nome: string
      argomenti: string
      risultato: string
      definer: boolean
      config: string[] | null
      service: boolean
      anon: boolean
      authenticated: boolean
      pubblico: boolean
    }>(`
      SELECT p.proname AS nome,
             pg_get_function_identity_arguments(p.oid) AS argomenti,
             pg_get_function_result(p.oid) AS risultato,
             p.prosecdef AS definer,
             p.proconfig AS config,
             has_function_privilege('service_role', p.oid, 'EXECUTE') AS service,
             has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
             EXISTS (
               SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
               WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
             ) AS pubblico
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname LIKE 'fatture\\_coda\\_%'
      ORDER BY p.proname
    `)

    // I NOMI dei parametri sono contratto: PostgREST passa gli argomenti per nome.
    expect(rows.map((r) => [r.nome, r.argomenti, r.risultato])).toEqual([
      ['fatture_coda_accoda', 'p_voci jsonb, p_creato_da uuid, p_urgente boolean', 'jsonb'],
      ['fatture_coda_bidello', '', 'integer'],
      ['fatture_coda_chiudi', 'p_id uuid, p_token uuid, p_esito text, p_codice text, p_messaggio text', 'void'],
      ['fatture_coda_prendi', 'p_token uuid, p_max integer, p_prestito_s integer', 'SETOF fatture_coda'],
      ['fatture_coda_rilascia', 'p_token uuid, p_pausa_minuti integer, p_motivo text', 'void'],
      ['fatture_coda_rimetti', 'p_ids uuid[], p_attore uuid', 'integer'],
      ['fatture_coda_sospendi', 'p_attore uuid, p_sospesa boolean', 'void'],
      ['fatture_coda_tick_http', '', 'void'],
      ['fatture_coda_togli', 'p_ids uuid[], p_attore uuid', 'integer'],
    ])
    for (const r of rows) {
      expect(r.definer, `${r.nome} deve essere SECURITY DEFINER`).toBe(true)
      expect(r.config?.join(' ') ?? '', `${r.nome} senza search_path`).toMatch(/^search_path=public\b/)
      expect(r.service, `${r.nome}: il service role deve poterla eseguire`).toBe(true)
      expect(r.anon, `${r.nome}: anon NON deve poterla eseguire`).toBe(false)
      expect(r.authenticated, `${r.nome}: authenticated NON deve poterla eseguire`).toBe(false)
      expect(r.pubblico, `${r.nome}: EXECUTE a PUBLIC non revocato`).toBe(false)
    }
  })

  it('fatture_coda_stato ha la riga id=1 e ne rifiuta una seconda', async () => {
    const { rows } = await db.query<{ id: number }>(`SELECT id FROM public.fatture_coda_stato`)
    expect(rows).toEqual([{ id: 1 }])
    const errore = await erroreDi(db.exec(`INSERT INTO public.fatture_coda_stato (id) VALUES (2)`))
    expect(errore?.code).toBe('23514')
  })

  it('una seconda esecuzione della migrazione non dà errori e non tocca dati né stato', async () => {
    await nuovoPagamento(1)
    await accoda([{ pagamento_id: pag(1), ordine_selezione: 0 }])
    await sospendi(true)

    await expect(db.exec(MIGRAZIONE)).resolves.toBeDefined()
    // Rieseguire il solo nucleo rimette la togli e la chiudi vecchie (CREATE OR REPLACE):
    // l'ordine vero è nucleo → 2a → 2b → 24/09 (la prendi e la rilascia della distanza).
    if (TOGLI_AZZERA) await expect(db.exec(TOGLI_AZZERA)).resolves.toBeDefined()
    if (CHIUDI_AZZERA) await expect(db.exec(CHIUDI_AZZERA)).resolves.toBeDefined()
    if (DISTANZA_ACCESSI) await expect(db.exec(DISTANZA_ACCESSI)).resolves.toBeDefined()

    expect(await voci()).toHaveLength(1)
    const s = await stato()
    expect(s.sospesa).toBe(true)
    const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.fatture_coda_stato`)
    expect(rows[0].n).toBe(1)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('fatture_coda · il lavoro pg_cron', () => {
  it('con pg_cron: un solo lavoro fatture-coda-tick, fuori dai minuti della sync, anche rieseguendo la migrazione', async () => {
    await db.close()
    db = new PGlite()
    await preparaDatabase({ cron: true })
    await db.exec(MIGRAZIONE)
    await db.exec(MIGRAZIONE)

    const { rows } = await db.query<{ jobname: string; schedule: string; command: string }>(
      `SELECT jobname, schedule, command FROM cron.job`,
    )
    expect(rows).toEqual([
      {
        jobname: 'fatture-coda-tick',
        schedule: '7,12,17,22,27,37,42,47,52,57 * * * *',
        command: 'SELECT public.fatture_coda_tick_http();',
      },
    ])
    const minuti = rows[0].schedule.split(' ')[0].split(',').map(Number)
    // Le finestre della sync SDI sono :00–:05 e :30–:35: nessun tick lì dentro.
    expect(minuti.filter((m) => (m >= 0 && m <= 5) || (m >= 30 && m <= 35))).toEqual([])
  })

  it('senza pg_cron (il DB E2E della CI) la migrazione passa lo stesso', async () => {
    // Il beforeEach l'ha già eseguita senza lo schema cron: se fosse fallita, qui non
    // si arriverebbe. Si controlla che il resto sia al suo posto.
    const { rows } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'fatture_coda_tick_http'`,
    )
    expect(rows[0].n).toBe(1)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('fatture_coda_accoda', () => {
  it('accoda in un solo gruppo, e un pagamento con una voce attiva non si accoda due volte', async () => {
    for (const n of [1, 2, 3]) await nuovoPagamento(n)

    const primo = await accoda([
      { pagamento_id: pag(1), ordine_selezione: 0 },
      { pagamento_id: pag(2), ordine_selezione: 1 },
    ])
    expect(primo.accodate).toBe(2)
    expect(primo.gia_in_coda).toEqual([])
    expect(primo.gruppo_id).toMatch(/^[0-9a-f-]{36}$/)

    const tutte = await voci()
    expect(new Set(tutte.map((v) => v.gruppo_id))).toEqual(new Set([primo.gruppo_id]))
    expect(new Set(tutte.map((v) => v.gruppo_seq)).size).toBe(1)
    expect(tutte.every((v) => v.stato === 'in_coda' && v.creato_da === SEGRETERIA)).toBe(true)

    // Il secondo gesto ripropone il 2 (già in coda) e aggiunge il 3.
    const secondo = await accoda([
      { pagamento_id: pag(2), ordine_selezione: 0 },
      { pagamento_id: pag(3), ordine_selezione: 1 },
    ])
    expect(secondo.accodate).toBe(1)
    expect(secondo.gia_in_coda).toEqual([pag(2)])
    expect(secondo.gruppo_id).not.toBe(primo.gruppo_id)
    expect(Number((await voceDi(3)).gruppo_seq)).toBeGreaterThan(Number((await voceDi(1)).gruppo_seq))
    expect(await voci()).toHaveLength(3)
  })

  it('una voce in_invio o in errore blocca il riaccodamento; emessa e tolta no', async () => {
    for (const n of [1, 2, 3, 4]) await nuovoPagamento(n)
    await accoda([1, 2, 3, 4].map((n, i) => ({ pagamento_id: pag(n), ordine_selezione: i })))
    const prese = await prendi(TOKEN_A, 3)
    expect(numeri(prese)).toEqual([1, 2, 3])
    await chiudi(prese[0].id, TOKEN_A, 'emessa', 'emessa')
    await chiudi(prese[1].id, TOKEN_A, 'errore', 'scarto_aruba', 'rifiutata')
    // il 3 resta in_invio; il 4 in_coda → lo si toglie
    expect(await togli([(await voceDi(4)).id])).toBe(1)

    const esito = await accoda([1, 2, 3, 4].map((n, i) => ({ pagamento_id: pag(n), ordine_selezione: i })))
    expect(esito.gia_in_coda).toEqual([pag(2), pag(3)])
    expect(esito.accodate).toBe(2)
    expect((await voceDi(1)).stato).toBe('in_coda')
    expect((await voceDi(4)).stato).toBe('in_coda')
  })

  it('lo stesso pagamento due volte nella stessa chiamata nasce una volta sola', async () => {
    await nuovoPagamento(1)
    const esito = await accoda([
      { pagamento_id: pag(1), ordine_selezione: 0 },
      { pagamento_id: pag(1), ordine_selezione: 1 },
    ])
    expect(esito.accodate).toBe(1)
    expect(esito.gia_in_coda).toEqual([])
    expect(await voci()).toHaveLength(1)
  })

  it('porta sede, intestatario, conferma, causale e urgenza; la causale vuota diventa null', async () => {
    await nuovoPagamento(1, { sede: SEDE_B })
    await nuovoPagamento(2)
    const intestatario = { adult_id: '99999999-9999-4999-8999-999999999999', ruolo: 'finto' }
    await accoda(
      [
        {
          pagamento_id: pag(1),
          ordine_selezione: 4,
          intestatario_scelto: intestatario,
          conferma_proposta: true,
          causale_manuale: 'Retta di prova',
        },
        { pagamento_id: pag(2), ordine_selezione: 5, causale_manuale: '   ' },
      ],
      true,
    )
    const uno = await voceDi(1)
    expect(uno).toMatchObject({
      scuola_id: SEDE_B,
      ordine_selezione: 4,
      intestatario_scelto: intestatario,
      conferma_proposta: true,
      causale_manuale: 'Retta di prova',
      urgente: true,
      tentativi: 0,
    })
    const due = await voceDi(2)
    expect(due).toMatchObject({ causale_manuale: null, intestatario_scelto: null, conferma_proposta: false })
  })

  it('data_riferimento: giorno Europe/Rome dell’incasso, altrimenti della creazione, altrimenti oggi', async () => {
    // 23:30 UTC del 22/09 sono le 01:30 del 23/09 a Roma (ora legale).
    await nuovoPagamento(1, { incasso: '2026-09-22T23:30:00Z' })
    // 23:30 UTC del 1/03 sono le 00:30 del 2/03 a Roma (ora solare).
    await nuovoPagamento(2, { incasso: null, creato: '2026-03-01T23:30:00Z' })
    await nuovoPagamento(3, { incasso: null, creato: null })
    await accoda([1, 2, 3].map((n, i) => ({ pagamento_id: pag(n), ordine_selezione: i })))

    const { rows } = await db.query<{ n: string; data: string; oggi: string }>(`
      SELECT right(pagamento_id::text, 1) AS n, data_riferimento::text AS data,
             ((now() AT TIME ZONE 'Europe/Rome')::date)::text AS oggi
      FROM public.fatture_coda ORDER BY pagamento_id
    `)
    expect(rows.map((r) => r.data)).toEqual(['2026-09-23', '2026-03-02', rows[2].oggi])
  })

  it('rifiuta la chiamata intera se un pagamento non esiste, e non accoda nemmeno gli altri', async () => {
    await nuovoPagamento(1)
    const errore = await erroreDi(
      accoda([
        { pagamento_id: pag(1), ordine_selezione: 0 },
        { pagamento_id: pag(77), ordine_selezione: 1 },
      ]),
    )
    expect(errore?.code).toBe('P0002')
    expect(await voci()).toEqual([])
  })

  it('rifiuta input malformati: niente voci, più di 500, voce senza pagamento, creatore assente, causale oltre 1000', async () => {
    await nuovoPagamento(1)
    expect((await erroreDi(accoda([])))?.code).toBe('22023')
    const troppe = Array.from({ length: 501 }, (_, i) => ({ pagamento_id: pag(1), ordine_selezione: i }))
    expect((await erroreDi(accoda(troppe)))?.code).toBe('22023')
    expect((await erroreDi(accoda([{ ordine_selezione: 0 } as VoceInput])))?.code).toBe('22023')
    expect(
      (
        await erroreDi(
          db.query(`SELECT public.fatture_coda_accoda($1::jsonb, NULL, false)`, [
            JSON.stringify([{ pagamento_id: pag(1) }]),
          ]),
        )
      )?.code,
    ).toBe('22023')
    const lunga = 'x'.repeat(1001)
    expect((await erroreDi(accoda([{ pagamento_id: pag(1), causale_manuale: lunga }])))?.code).toBe('23514')
    expect(await voci()).toEqual([])
  })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('fatture_coda_prendi', () => {
  /**
   * Gruppo A (normale): 1 (incasso 10/09, sel. 0), 2 (05/09, sel. 1), 3 (05/09, sel. 2).
   * Gruppo B (normale): 4.   Gruppo C (urgente): 5.
   * Ordine atteso: 5 (urgente) · 2, 3 (A, per data e poi per selezione) · 1 · 4 (B).
   */
  async function preparaCodaMista() {
    await nuovoPagamento(1, { incasso: '2026-09-10T08:00:00Z' })
    await nuovoPagamento(2, { incasso: '2026-09-05T08:00:00Z' })
    await nuovoPagamento(3, { incasso: '2026-09-05T08:00:00Z' })
    await nuovoPagamento(4, { incasso: '2026-08-01T08:00:00Z' })
    await nuovoPagamento(5, { incasso: '2026-09-20T08:00:00Z' })
    await accoda([
      { pagamento_id: pag(1), ordine_selezione: 0 },
      { pagamento_id: pag(2), ordine_selezione: 1 },
      { pagamento_id: pag(3), ordine_selezione: 2 },
    ])
    await accoda([{ pagamento_id: pag(4), ordine_selezione: 0 }])
    await accoda([{ pagamento_id: pag(5), ordine_selezione: 0 }], true)
  }

  it('consegna nell’ordine: urgenti, poi gruppo, poi data del pagamento, poi selezione', async () => {
    await preparaCodaMista()
    expect(numeri(await prendi(TOKEN_A, 2))).toEqual([5, 2])
    await dimenticaAccesso() // ogni presa è un giro nuovo, a distanza dal precedente (24/09)
    expect(numeri(await prendi(TOKEN_A, 2))).toEqual([3, 1])
    await dimenticaAccesso()
    expect(numeri(await prendi(TOKEN_A, 2))).toEqual([4])
    await dimenticaAccesso()
    expect(await prendi(TOKEN_A, 2)).toEqual([])
  })

  it('porta le voci prese in_invio col token, il prestito e un tentativo in più; prende il testimone', async () => {
    await preparaCodaMista()
    const prese = await prendi(TOKEN_A, 15, 330)
    expect(prese).toHaveLength(5)
    for (const v of prese) {
      expect(v.stato).toBe('in_invio')
      expect(v.lavoratore_token).toBe(TOKEN_A)
      expect(v.tentativi).toBe(1)
      expect(v.presa_il).not.toBeNull()
      const secondi = (v.prestito_scade_il!.getTime() - v.presa_il!.getTime()) / 1000
      expect(secondi).toBe(330)
    }
    const s = await stato()
    expect(s.lavoratore_token).toBe(TOKEN_A)
    expect(s.ultimo_giro_il).not.toBeNull()
    expect((s.lavoratore_scade_il!.getTime() - s.ultimo_giro_il!.getTime()) / 1000).toBe(330)
  })

  it('un solo lavoratore: un altro token, finché il primo è vivo, riceve un insieme vuoto', async () => {
    await preparaCodaMista()
    expect(await prendi(TOKEN_A, 1)).toHaveLength(1)
    await dimenticaAccesso() // il vuoto qui sotto deve essere del lavoratore, non dei 65 s (24/09)
    expect(await prendi(TOKEN_B, 15)).toEqual([])
    expect((await stato()).lavoratore_token).toBe(TOKEN_A)

    // Scaduto il testimone del primo, il secondo subentra. Un testimone scade 330 s dopo
    // la presa: anche l'ultimo accesso è di allora (24/09).
    await db.exec(
      `UPDATE public.fatture_coda_stato
          SET lavoratore_scade_il = now() - interval '1 second',
              ultimo_accesso_il = now() - interval '331 seconds'
        WHERE id = 1`,
    )
    expect(numeri(await prendi(TOKEN_B, 15))).toEqual([2, 3, 1, 4])
    expect((await stato()).lavoratore_token).toBe(TOKEN_B)
  })

  it('coda sospesa: vuoto, e il testimone non viene preso', async () => {
    await preparaCodaMista()
    await sospendi(true)
    expect(await prendi(TOKEN_A)).toEqual([])
    const s = await stato()
    expect(s.lavoratore_token).toBeNull()
    expect(s.ultimo_giro_il).toBeNull()
    await sospendi(false)
    expect(await prendi(TOKEN_A)).toHaveLength(5)
  })

  it('coda in pausa: vuoto per chiunque finché la pausa non scade', async () => {
    await preparaCodaMista()
    await rilascia(TOKEN_A, 60, 'aruba-429')
    expect(await prendi(TOKEN_A)).toEqual([])
    expect(await prendi(TOKEN_B)).toEqual([])
    expect((await stato()).lavoratore_token).toBeNull()

    await db.exec(`UPDATE public.fatture_coda_stato SET pausa_fino_a = now() - interval '1 second' WHERE id = 1`)
    expect(await prendi(TOKEN_B)).toHaveLength(5)
  })

  it('non prende voci in errore, tolte o emesse', async () => {
    await preparaCodaMista()
    const prese = await prendi(TOKEN_A, 3)
    await chiudi(prese[0].id, TOKEN_A, 'emessa')
    await chiudi(prese[1].id, TOKEN_A, 'errore', 'scarto_aruba')
    await chiudi(prese[2].id, TOKEN_A, 'errore', 'esito_incerto')
    await togli([(await voceDi(1)).id])
    await dimenticaAccesso() // un giro nuovo, a distanza: il vuoto qui sotto è per le voci, non per i 65 s
    expect(numeri(await prendi(TOKEN_A))).toEqual([4])
    await dimenticaAccesso()
    expect(await prendi(TOKEN_A)).toEqual([])
  })

  it('rifiuta argomenti assenti o non positivi', async () => {
    expect((await erroreDi(prendi(TOKEN_A, 0)))?.code).toBe('22023')
    expect((await erroreDi(prendi(TOKEN_A, 5, 0)))?.code).toBe('22023')
    expect(
      (await erroreDi(db.query(`SELECT * FROM public.fatture_coda_prendi(NULL, 5, 330)`)))?.code,
    ).toBe('22023')
  })

  // ── correzione del 24/09: il 429 delle 10:09:59 ─────────────────────────────
  // Aruba concede UN signin al minuto per IP, e ogni giro fa il suo. Il lavoratore unico
  // impediva due giri INSIEME, non due giri a pochi secondi l'uno dall'altro.
  describe('65 s fra due accessi ad Aruba (correzione del 24/09)', () => {
    it('N1 · dopo un giro con voci, un altro token non prende prima di 65 s: niente testimone, niente ultimo_giro_il, voci intatte', async () => {
      await preparaCodaMista()
      expect(numeri(await prendi(TOKEN_A, 1))).toEqual([5])
      await rilascia(TOKEN_A, 0, null)
      const prima = await stato()
      expect(prima.ultimo_accesso_il).not.toBeNull()

      expect(await prendi(TOKEN_B, 15)).toEqual([])
      const dopo = await stato()
      expect(dopo.lavoratore_token).toBeNull()
      expect(dopo.ultimo_giro_il!.getTime()).toBe(prima.ultimo_giro_il!.getTime())

      // La sveglia rifiutata non perde voci: restano in_coda, senza tentativi né token.
      const inCoda = (await voci()).filter((v) => v.stato === 'in_coda')
      expect(inCoda).toHaveLength(4)
      for (const v of inCoda) {
        expect(v.tentativi).toBe(0)
        expect(v.lavoratore_token).toBeNull()
      }

      await dimenticaAccesso()
      expect(numeri(await prendi(TOKEN_B, 15))).toEqual([2, 3, 1, 4])
    })

    it('N2 · il confine: a 64 s rifiuta, a 65 s consegna', async () => {
      await preparaCodaMista()
      await accessoA("now() - interval '64 seconds'")
      expect(await prendi(TOKEN_A, 1)).toEqual([])
      // Ogni db.query è una transazione sua: fra le due letture di now() passano millisecondi.
      await accessoA("now() - interval '65 seconds'")
      expect(numeri(await prendi(TOKEN_A, 1))).toEqual([5])
    })

    it('N3 · il rilascio sposta l’orologio alla FINE del giro', async () => {
      // L'ordine del giro vero (`giro.ts`): prendi → chiudi ogni voce → rilascia. `chiudi` non
      // azzera `lavoratore_token` in nessun ramo, quindi l'EXISTS di `rilascia` trova ancora
      // le voci del giro anche quando sono già tutte chiuse. Con la voce chiusa, qui: un
      // rilascio con la voce ancora `in_invio` non succede mai.
      await preparaCodaMista()
      const [presa] = await prendi(TOKEN_A, 1)
      await chiudi(presa.id, TOKEN_A, 'emessa')
      await accessoA("now() - interval '10 minutes'") // come se il signin fosse vecchio
      await rilascia(TOKEN_A, 0, null)
      expect(await secondiDallAccesso()).toBeLessThan(2)
      expect(await prendi(TOKEN_B, 1)).toEqual([])
    })

    it('N4 · un giro a vuoto non timbra', async () => {
      expect(await prendi(TOKEN_A)).toEqual([])
      await rilascia(TOKEN_A, 0, null)
      expect((await stato()).ultimo_accesso_il).toBeNull()

      // La sveglia che segue un cron a vuoto prende subito.
      await nuovoPagamento(1)
      await accoda([{ pagamento_id: pag(1) }], true)
      expect(numeri(await prendi(TOKEN_B, 1))).toEqual([1])
    })

    it('N5 · rilascia: senza voci non timbra; con voci timbra anche se il testimone è di un altro; mai all’indietro', async () => {
      await preparaCodaMista()

      // (a) Un token che non ha voci non sposta l'orologio.
      await accessoA("now() - interval '10 minutes'")
      await rilascia(TOKEN_B, 0, null)
      expect(await secondiDallAccesso()).toBeGreaterThan(590)

      // (b) Un token con voci timbra anche se il testimone, nel frattempo, è di un altro.
      await dimenticaAccesso()
      await prendi(TOKEN_A, 1)
      await db.exec(`
        UPDATE public.fatture_coda_stato
           SET lavoratore_token = '${TOKEN_B}',
               lavoratore_scade_il = now() + interval '330 seconds',
               ultimo_accesso_il = now() - interval '10 minutes'
         WHERE id = 1
      `)
      await rilascia(TOKEN_A, 0, null)
      expect((await stato()).lavoratore_token).toBe(TOKEN_B)
      expect(await secondiDallAccesso()).toBeLessThan(2)

      // (c) Mai all'indietro.
      await accessoA("now() + interval '1 hour'")
      const futuro = (await stato()).ultimo_accesso_il!.getTime()
      await rilascia(TOKEN_A, 0, null)
      expect((await stato()).ultimo_accesso_il!.getTime()).toBe(futuro)
    })

    it('N6 · «Rimetti» toglie il token alle voci del giro: resta il timbro della presa', async () => {
      await preparaCodaMista()
      const [voce] = await prendi(TOKEN_A, 1)
      await chiudi(voce.id, TOKEN_A, 'errore', 'scarto_aruba')
      expect(await rimetti([voce.id])).toBe(1)
      await rilascia(TOKEN_A, 0, null) // nessuna voce porta più A: il rilascio non timbra
      expect(await prendi(TOKEN_B, 1)).toEqual([])
    })

    it('N7 · forma: la colonna è timestamptz e ammette null', async () => {
      const { rows } = await db.query<{ tipo: string; nullo: string }>(`
        SELECT data_type AS tipo, is_nullable AS nullo
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'fatture_coda_stato' AND column_name = 'ultimo_accesso_il'
      `)
      expect(rows).toEqual([{ tipo: 'timestamp with time zone', nullo: 'YES' }])
    })

    it('N8 · la migrazione del 24/09 esiste, è una sola, viene dopo quella della 2b e non è nel futuro', () => {
      expect(TROVATI_ACCESSI).toHaveLength(1)
      const version = NOME_ACCESSI.slice(0, 14)
      expect(version).toMatch(/^\d{14}$/)
      expect(version > NOME_CHIUDI.slice(0, 14)).toBe(true)
      expect(version <= new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)).toBe(true)
    })

    it('N9 · non accende nessuna guardia delle fotografie, e revoca per nome', () => {
      expect(DISTANZA_ACCESSI).not.toBe('')
      expect(toccaLaRls(DISTANZA_ACCESSI)).toBe(false)
      expect(toccaUnUnico(DISTANZA_ACCESSI)).toBe(false)
      expect(toccaLeFkUtenti(DISTANZA_ACCESSI)).toBe(false)
      expect(senzaCommenti(DISTANZA_ACCESSI)).not.toMatch(/scuola_id/i)
      expect(DISTANZA_ACCESSI).toContain(
        'REVOKE ALL ON FUNCTION public.fatture_coda_prendi(uuid, integer, integer) FROM PUBLIC, anon, authenticated;',
      )
      expect(DISTANZA_ACCESSI).toContain(
        'REVOKE ALL ON FUNCTION public.fatture_coda_rilascia(uuid, integer, text) FROM PUBLIC, anon, authenticated;',
      )
    })
  })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('fatture_coda_chiudi', () => {
  async function unaInMano(n = 1): Promise<Voce> {
    await nuovoPagamento(n)
    await accoda([
      {
        pagamento_id: pag(n),
        ordine_selezione: 0,
        causale_manuale: 'Causale finta',
        intestatario_scelto: { adult_id: '99999999-9999-4999-8999-999999999999' },
      },
    ])
    await dimenticaAccesso() // ogni voce «in mano» è un giro nuovo, a distanza dal precedente (24/09)
    const [voce] = await prendi(TOKEN_A, 1)
    return voce
  }

  it('controlla il token: un altro lavoratore riceve NON_TUA e la voce resta intatta', async () => {
    const voce = await unaInMano()
    const errore = await erroreDi(chiudi(voce.id, TOKEN_B, 'emessa', 'emessa'))
    expect(errore?.code).toBe('P0001')
    expect(errore?.message).toContain('NON_TUA')
    expect(await voceDi(1)).toMatchObject({ stato: 'in_invio', lavoratore_token: TOKEN_A })
  })

  it('emessa: conclusa, codice registrato, causale e intestatario azzerati', async () => {
    const voce = await unaInMano()
    await chiudi(voce.id, TOKEN_A, 'emessa', 'gia_emessa', null)
    const dopo = await voceDi(1)
    expect(dopo).toMatchObject({
      stato: 'emessa',
      esito_codice: 'gia_emessa',
      causale_manuale: null,
      intestatario_scelto: null,
      prestito_scade_il: null,
    })
    expect(dopo.concluso_il).not.toBeNull()
  })

  it('errore: resta attiva (blocca il riaccodamento), porta codice e messaggio troncato a 500', async () => {
    const voce = await unaInMano()
    await chiudi(voce.id, TOKEN_A, 'errore', '422', 'm'.repeat(800))
    const dopo = await voceDi(1)
    expect(dopo.stato).toBe('errore')
    expect(dopo.esito_codice).toBe('422')
    expect(dopo.esito_messaggio).toHaveLength(500)
    expect(dopo.concluso_il).toBeNull()
    // i dati servono al «Rimetti in coda»: restano
    expect(dopo.causale_manuale).toBe('Causale finta')
    expect((await accoda([{ pagamento_id: pag(1) }])).gia_in_coda).toEqual([pag(1)])
  })

  it('riprova: torna in_coda alla STESSA posizione, con in_attesa_dal invariato', async () => {
    for (const n of [1, 2]) await nuovoPagamento(n)
    await accoda([
      { pagamento_id: pag(1), ordine_selezione: 0 },
      { pagamento_id: pag(2), ordine_selezione: 1 },
    ])
    const prima = await voceDi(1)
    const [presa] = await prendi(TOKEN_A, 1)
    expect(numeri([presa])).toEqual([1])

    await chiudi(presa.id, TOKEN_A, 'riprova', 'aruba_429', null)
    const dopo = await voceDi(1)
    expect(dopo).toMatchObject({
      stato: 'in_coda',
      gruppo_seq: prima.gruppo_seq,
      presa_il: null,
      prestito_scade_il: null,
      concluso_il: null,
      tentativi: 1,
    })
    expect(dopo.in_attesa_dal.getTime()).toBe(prima.in_attesa_dal.getTime())

    // Al giro dopo (a distanza, 24/09) è ancora la prima della coda, davanti al 2.
    await dimenticaAccesso()
    expect(numeri(await prendi(TOKEN_A, 1))).toEqual([1])
    expect((await voceDi(1)).tentativi).toBe(2)
  })

  it('la stessa chiusura ripetuta dallo stesso lavoratore non fa nulla; una diversa è rifiutata', async () => {
    const voce = await unaInMano()
    await chiudi(voce.id, TOKEN_A, 'emessa', 'emessa')
    const dopo = await voceDi(1)
    await expect(chiudi(voce.id, TOKEN_A, 'emessa', 'emessa')).resolves.toBeUndefined()
    expect((await voceDi(1)).concluso_il?.getTime()).toBe(dopo.concluso_il?.getTime())

    const errore = await erroreDi(chiudi(voce.id, TOKEN_A, 'errore', 'scarto_aruba'))
    expect(errore?.message).toContain('NON_TUA')
    expect((await voceDi(1)).stato).toBe('emessa')
  })

  it('rifiuta un esito fuori elenco e una voce inesistente', async () => {
    const voce = await unaInMano()
    expect((await erroreDi(chiudi(voce.id, TOKEN_A, 'boh')))?.code).toBe('22023')
    expect((await erroreDi(chiudi(pag(200), TOKEN_A, 'emessa')))?.code).toBe('P0002')
    expect((await voceDi(1)).stato).toBe('in_invio')
  })

  // ── consegna 2b, D13: «emessa» azzera SEMPRE il messaggio d'esito ──────────
  it('la migrazione della consegna 2b esiste, è una sola, viene dopo quella della 2a e non è nel futuro', () => {
    expect(TROVATI_CHIUDI).toHaveLength(1)
    const version = NOME_CHIUDI.slice(0, 14)
    expect(version).toMatch(/^\d{14}$/)
    expect(version > NOME_TOGLI.slice(0, 14)).toBe(true)
    expect(version <= new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)).toBe(true)
  })

  it('non accende nessuna guardia delle fotografie, e revoca per nome', () => {
    expect(CHIUDI_AZZERA).not.toBe('')
    expect(toccaLaRls(CHIUDI_AZZERA)).toBe(false)
    expect(toccaUnUnico(CHIUDI_AZZERA)).toBe(false)
    expect(toccaLeFkUtenti(CHIUDI_AZZERA)).toBe(false)
    expect(senzaCommenti(CHIUDI_AZZERA)).not.toMatch(/scuola_id/i)
    expect(CHIUDI_AZZERA).toContain(
      'REVOKE ALL ON FUNCTION public.fatture_coda_chiudi(uuid, uuid, text, text, text) FROM PUBLIC, anon, authenticated;',
    )
  })

  it('emessa: il messaggio passato dal chiamante NON resta (su errore invece resta)', async () => {
    const voce = await unaInMano(1)
    await chiudi(voce.id, TOKEN_A, 'emessa', 'emessa', 'Messaggio finto')
    expect(await voceDi(1)).toMatchObject({
      stato: 'emessa',
      esito_codice: 'emessa',
      esito_messaggio: null,
      causale_manuale: null,
      intestatario_scelto: null,
    })

    // Controllo: una seconda voce chiusa in errore col messaggio lo tiene.
    const seconda = await unaInMano(2)
    await chiudi(seconda.id, TOKEN_A, 'errore', 'scarto_aruba', 'Messaggio finto')
    expect(await voceDi(2)).toMatchObject({ stato: 'errore', esito_messaggio: 'Messaggio finto' })
  })

  it('la stessa chiusura «emessa» ripetuta resta un no-op anche con un messaggio', async () => {
    const voce = await unaInMano()
    await chiudi(voce.id, TOKEN_A, 'emessa', 'emessa', 'Messaggio finto')
    const dopo = await voceDi(1)
    await expect(chiudi(voce.id, TOKEN_A, 'emessa', 'emessa', 'Messaggio finto')).resolves.toBeUndefined()
    const ancora = await voceDi(1)
    expect(ancora.concluso_il?.getTime()).toBe(dopo.concluso_il?.getTime())
    expect(ancora).toMatchObject({ stato: 'emessa', esito_codice: 'emessa', esito_messaggio: null })
  })

  it('ripulisce le emesse che avevano già un messaggio, ed è idempotente', async () => {
    if (!CHIUDI_AZZERA) throw new Error(`manca la migrazione *${SUFFISSO_CHIUDI}`)
    // Nucleo e 2a di nuovo = la chiudi che è in produzione oggi.
    await db.exec(MIGRAZIONE)
    if (TOGLI_AZZERA) await db.exec(TOGLI_AZZERA)
    for (const n of [1, 2]) await nuovoPagamento(n)
    await accoda([1, 2].map((n, i) => ({ pagamento_id: pag(n), ordine_selezione: i })))
    const prese = await prendi(TOKEN_A, 2)
    const idDi = (n: number) => prese.find((v) => v.pagamento_id === pag(n))!.id
    await chiudi(idDi(1), TOKEN_A, 'emessa', 'emessa', 'Messaggio finto')
    await chiudi(idDi(2), TOKEN_A, 'errore', 'esito_incerto', 'Resta')
    expect((await voceDi(1)).esito_messaggio).toBe('Messaggio finto') // lo stato da ripulire c'è davvero

    await db.exec(CHIUDI_AZZERA)
    expect(await voceDi(1)).toMatchObject({ stato: 'emessa', esito_codice: 'emessa', esito_messaggio: null })
    expect(await voceDi(2)).toMatchObject({ stato: 'errore', esito_codice: 'esito_incerto', esito_messaggio: 'Resta' })

    await expect(db.exec(CHIUDI_AZZERA)).resolves.toBeDefined()
    expect(await voceDi(1)).toMatchObject({ esito_messaggio: null })
    expect((await voceDi(2)).esito_messaggio).toBe('Resta')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('fatture_coda_rilascia', () => {
  it('libera il testimone solo se il token combacia', async () => {
    await nuovoPagamento(1)
    await accoda([{ pagamento_id: pag(1) }])
    await prendi(TOKEN_A, 1)

    await rilascia(TOKEN_B, 0, null)
    expect((await stato()).lavoratore_token).toBe(TOKEN_A)

    await rilascia(TOKEN_A, 0, null)
    const s = await stato()
    expect(s.lavoratore_token).toBeNull()
    expect(s.lavoratore_scade_il).toBeNull()
    expect(s.pausa_fino_a).toBeNull()
  })

  it('pausa 60 dopo un 429: fino a ~adesso+60′, col motivo; una pausa più corta non la accorcia', async () => {
    await rilascia(TOKEN_A, 60, 'aruba-429')
    const secondi = async () => {
      const { rows } = await db.query<{ s: number }>(
        `SELECT extract(epoch FROM pausa_fino_a - now())::float8 AS s FROM public.fatture_coda_stato WHERE id = 1`,
      )
      return rows[0].s
    }
    const dopo60 = await secondi()
    expect(dopo60).toBeGreaterThan(59 * 60)
    expect(dopo60).toBeLessThanOrEqual(60 * 60)
    expect((await stato()).pausa_motivo).toBe('aruba-429')

    const primaScadenza = (await stato()).pausa_fino_a!.getTime()
    await rilascia(TOKEN_A, 15, 'esito-incerto')
    const s = await stato()
    expect(s.pausa_fino_a!.getTime()).toBe(primaScadenza)
    expect(s.pausa_motivo).toBe('aruba-429')
  })

  it('una pausa più lunga di quella in corso la allunga e ne prende il motivo', async () => {
    await rilascia(TOKEN_A, 15, 'esito-incerto')
    const prima = (await stato()).pausa_fino_a!.getTime()
    await rilascia(TOKEN_A, 60, 'aruba-429')
    const s = await stato()
    expect(s.pausa_fino_a!.getTime()).toBeGreaterThan(prima)
    expect(s.pausa_motivo).toBe('aruba-429')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('fatture_coda_bidello', () => {
  it('in_invio col prestito scaduto → errore esito_incerto, MAI di nuovo in_coda; le altre non si toccano', async () => {
    for (const n of [1, 2, 3]) await nuovoPagamento(n)
    await accoda([1, 2, 3].map((n, i) => ({ pagamento_id: pag(n), ordine_selezione: i })))
    await prendi(TOKEN_A, 2)
    await db.exec(`
      UPDATE public.fatture_coda SET prestito_scade_il = now() - interval '1 second'
      WHERE pagamento_id = '${pag(1)}'
    `)

    expect(await bidello()).toBe(1)

    const scaduta = await voceDi(1)
    expect(scaduta).toMatchObject({
      stato: 'errore',
      esito_codice: 'esito_incerto',
      esito_messaggio: 'invio interrotto: controllare sul pannello Aruba prima di rimetterla in coda',
      prestito_scade_il: null,
      concluso_il: null,
    })
    expect((await voceDi(2)).stato).toBe('in_invio')
    expect((await voceDi(3)).stato).toBe('in_coda')

    // Un secondo passaggio non trova niente, e la voce resta in errore: nessun giro la riprende.
    expect(await bidello()).toBe(0)
    await rilascia(TOKEN_A, 0, null)
    await dimenticaAccesso() // il giro dopo, a distanza (24/09)
    expect(numeri(await prendi(TOKEN_B))).toEqual([3])
    expect((await voceDi(1)).stato).toBe('errore')

    // Il giro morto che risorge non può più chiuderla come emessa.
    const tardiva = await erroreDi(chiudi(scaduta.id, TOKEN_A, 'emessa', 'emessa'))
    expect(tardiva?.message).toContain('NON_TUA')
    expect((await voceDi(1)).esito_codice).toBe('esito_incerto')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('fatture_coda_togli', () => {
  it('toglie solo in_coda ed errore; azzera i dati personali; conta quelle toccate', async () => {
    for (const n of [1, 2, 3, 4]) await nuovoPagamento(n)
    await accoda(
      [1, 2, 3, 4].map((n, i) => ({
        pagamento_id: pag(n),
        ordine_selezione: i,
        causale_manuale: 'Causale finta',
        intestatario_scelto: { adult_id: '99999999-9999-4999-8999-999999999999' },
      })),
    )
    const prese = await prendi(TOKEN_A, 3)
    await chiudi(prese[0].id, TOKEN_A, 'emessa') // 1 emessa
    await chiudi(prese[1].id, TOKEN_A, 'errore', 'scarto_aruba') // 2 errore
    // 3 in_invio, 4 in_coda

    const ids = await Promise.all([1, 2, 3, 4].map(async (n) => (await voceDi(n)).id))
    expect(await togli(ids)).toBe(2)

    for (const n of [2, 4]) {
      const v = await voceDi(n)
      expect(v).toMatchObject({ stato: 'tolta', causale_manuale: null, intestatario_scelto: null })
      expect(v.concluso_il).not.toBeNull()
    }
    expect((await voceDi(1)).stato).toBe('emessa')
    expect((await voceDi(3)).stato).toBe('in_invio')

    // Tolta, il pagamento si può accodare di nuovo.
    expect((await accoda([{ pagamento_id: pag(4) }])).accodate).toBe(1)
  })

  it('senza attore rifiuta; con un elenco vuoto non fa nulla', async () => {
    expect(
      (await erroreDi(db.query(`SELECT public.fatture_coda_togli(ARRAY[]::uuid[], NULL)`)))?.code,
    ).toBe('22023')
    expect(await togli([])).toBe(0)
  })

  it('la migrazione della consegna 2a esiste, è una sola, viene dopo il nucleo e non è nel futuro', () => {
    expect(TROVATI_TOGLI).toHaveLength(1)
    const version = NOME_TOGLI.slice(0, 14)
    expect(version).toMatch(/^\d{14}$/)
    expect(version > NOME_FILE.slice(0, 14)).toBe(true)
    expect(version <= new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)).toBe(true)
  })

  it('non accende nessuna guardia delle fotografie, e revoca per nome', () => {
    expect(TOGLI_AZZERA).not.toBe('')
    expect(toccaLaRls(TOGLI_AZZERA)).toBe(false)
    expect(toccaUnUnico(TOGLI_AZZERA)).toBe(false)
    expect(toccaLeFkUtenti(TOGLI_AZZERA)).toBe(false)
    expect(senzaCommenti(TOGLI_AZZERA)).not.toMatch(/scuola_id/i)
    expect(TOGLI_AZZERA).toContain(
      'REVOKE ALL ON FUNCTION public.fatture_coda_togli(uuid[], uuid) FROM PUBLIC, anon, authenticated;',
    )
  })

  it('azzera anche esito_codice ed esito_messaggio, su in_coda come su errore; non tocca le altre', async () => {
    for (const n of [1, 2, 3]) await nuovoPagamento(n)
    await accoda([1, 2, 3].map((n, i) => ({ pagamento_id: pag(n), ordine_selezione: i })))
    const prese = await prendi(TOKEN_A, 3)
    const idDi = (n: number) => prese.find((v) => v.pagamento_id === pag(n))!.id
    await chiudi(idDi(1), TOKEN_A, 'errore', 'scarto_aruba', 'Messaggio finto')
    await chiudi(idDi(2), TOKEN_A, 'riprova', 'non_tentata') // torna in_coda CON un codice
    await chiudi(idDi(3), TOKEN_A, 'errore', 'esito_incerto', 'Altro messaggio finto') // controllo

    expect(await togli([idDi(1), idDi(2)])).toBe(2)

    for (const n of [1, 2]) {
      expect(await voceDi(n)).toMatchObject({ stato: 'tolta', esito_codice: null, esito_messaggio: null })
    }
    expect(await voceDi(3)).toMatchObject({
      stato: 'errore', esito_codice: 'esito_incerto', esito_messaggio: 'Altro messaggio finto',
    })
  })

  it('ripulisce le voci GIÀ tolte dalla versione vecchia, ed è idempotente', async () => {
    if (!TOGLI_AZZERA) throw new Error(`manca la migrazione *${SUFFISSO_TOGLI}`)
    await db.exec(MIGRAZIONE) // il nucleo di nuovo = la togli che è in produzione oggi
    for (const n of [1, 2, 3]) await nuovoPagamento(n)
    await accoda([1, 2, 3].map((n, i) => ({ pagamento_id: pag(n), ordine_selezione: i })))
    const prese = await prendi(TOKEN_A, 3)
    const idDi = (n: number) => prese.find((v) => v.pagamento_id === pag(n))!.id
    await chiudi(idDi(1), TOKEN_A, 'errore', 'scarto_aruba', 'Messaggio finto')
    await chiudi(idDi(2), TOKEN_A, 'errore', 'esito_incerto', 'Resta')
    await chiudi(idDi(3), TOKEN_A, 'emessa')
    expect(await togli([idDi(1)])).toBe(1)
    expect((await voceDi(1)).esito_messaggio).toBe('Messaggio finto') // lo stato da ripulire c'è davvero

    await db.exec(TOGLI_AZZERA)
    expect(await voceDi(1)).toMatchObject({ stato: 'tolta', esito_codice: null, esito_messaggio: null })
    expect(await voceDi(2)).toMatchObject({ stato: 'errore', esito_codice: 'esito_incerto', esito_messaggio: 'Resta' })
    expect(await voceDi(3)).toMatchObject({ stato: 'emessa', esito_codice: 'emessa' })

    await expect(db.exec(TOGLI_AZZERA)).resolves.toBeDefined()
    expect(await voceDi(1)).toMatchObject({ esito_codice: null, esito_messaggio: null })
  })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('fatture_coda_rimetti', () => {
  it('solo errore → in_coda, IN FONDO, con l’attesa che riparte e l’esito azzerato', async () => {
    for (const n of [1, 2, 3]) await nuovoPagamento(n)
    await accoda([1, 2].map((n, i) => ({ pagamento_id: pag(n), ordine_selezione: i })))
    const [prima] = await prendi(TOKEN_A, 1)
    await chiudi(prima.id, TOKEN_A, 'errore', 'esito_incerto', 'interrotto')
    await rilascia(TOKEN_A, 0, null)
    // Un gruppo accodato DOPO l'errore.
    await accoda([{ pagamento_id: pag(3), ordine_selezione: 0 }])

    const primaDelRientro = await voceDi(1)
    const ids = await Promise.all([1, 2, 3].map(async (n) => (await voceDi(n)).id))
    expect(await rimetti(ids)).toBe(1)

    const rientrata = await voceDi(1)
    expect(rientrata).toMatchObject({
      stato: 'in_coda',
      esito_codice: null,
      esito_messaggio: null,
      lavoratore_token: null,
      presa_il: null,
    })
    expect(Number(rientrata.gruppo_seq)).toBeGreaterThan(Number((await voceDi(3)).gruppo_seq))
    expect(rientrata.in_attesa_dal.getTime()).toBeGreaterThan(primaDelRientro.in_attesa_dal.getTime())

    // In fondo: prima il 2 (primo gruppo), poi il 3 (secondo gruppo), poi l'1 rimesso.
    await dimenticaAccesso() // il giro dopo, a distanza (24/09)
    expect(numeri(await prendi(TOKEN_B))).toEqual([2, 3, 1])
  })

  it('non tocca le voci in_coda, in_invio, emesse o tolte', async () => {
    for (const n of [1, 2, 3, 4]) await nuovoPagamento(n)
    await accoda([1, 2, 3, 4].map((n, i) => ({ pagamento_id: pag(n), ordine_selezione: i })))
    const prese = await prendi(TOKEN_A, 2)
    await chiudi(prese[0].id, TOKEN_A, 'emessa')
    await togli([(await voceDi(4)).id])
    const ids = await Promise.all([1, 2, 3, 4].map(async (n) => (await voceDi(n)).id))
    expect(await rimetti(ids)).toBe(0)
    expect((await voci()).map((v) => v.stato)).toEqual(['emessa', 'in_invio', 'in_coda', 'tolta'])
  })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('fatture_coda_sospendi', () => {
  it('sospende e riprende; sospendere di nuovo non azzera l’orologio delle 24 ore', async () => {
    await sospendi(true, ADMIN)
    const prima = await stato()
    expect(prima).toMatchObject({ sospesa: true, sospesa_da: ADMIN })
    expect(prima.sospesa_il).not.toBeNull()

    await sospendi(true, SEGRETERIA)
    const ancora = await stato()
    expect(ancora.sospesa_da).toBe(ADMIN)
    expect(ancora.sospesa_il!.getTime()).toBe(prima.sospesa_il!.getTime())

    await sospendi(false, ADMIN)
    expect(await stato()).toMatchObject({ sospesa: false, sospesa_da: null, sospesa_il: null })
  })

  it('rifiuta attore o valore assenti', async () => {
    expect(
      (await erroreDi(db.query(`SELECT public.fatture_coda_sospendi(NULL, true)`)))?.code,
    ).toBe('22023')
    expect(
      (await erroreDi(db.query(`SELECT public.fatture_coda_sospendi($1::uuid, NULL)`, [ADMIN])))?.code,
    ).toBe('22023')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('fatture_coda_tick_http', () => {
  async function tick() {
    await db.query(`SELECT public.fatture_coda_tick_http()`)
  }
  async function chiamate() {
    const { rows } = await db.query<{ url: string; headers: Record<string, string>; timeout_milliseconds: number }>(
      `SELECT url, headers, timeout_milliseconds FROM net.chiamate ORDER BY n`,
    )
    return rows
  }
  async function logCron() {
    const { rows } = await db.query<{ livello: string; fingerprint: string; esito: string; occorrenze: number }>(`
      SELECT livello, fingerprint, contesto->'campi'->>'esito' AS esito, occorrenze
      FROM public.app_log WHERE evento = 'cron' ORDER BY fingerprint
    `)
    return rows
  }

  it('chiama la route del giro sull’origine del Vault, col segreto e il timeout di 300 s', async () => {
    await db.exec(`
      INSERT INTO public.vault_finto (nome, valore) VALUES
        ('app.fattura_sync_url', 'https://esempio.invalid/api/pagamenti/fattura/sync'),
        ('app.cron_secret', 'segreto-finto');
    `)
    await tick()
    expect(await chiamate()).toEqual([
      {
        url: 'https://esempio.invalid/api/pagamenti/fattura/coda/giro',
        headers: { 'Content-Type': 'application/json', 'x-cron-secret': 'segreto-finto' },
        timeout_milliseconds: 300000,
      },
    ])
    expect(await logCron()).toEqual([])
  })

  it('ricava l’origine anche da un altro URL configurato', async () => {
    await db.exec(`
      INSERT INTO public.vault_finto (nome, valore) VALUES
        ('app.push_dispatch_url', 'https://altro.invalid/api/push/dispatch'),
        ('app.cron_secret', 'segreto-finto');
    `)
    await tick()
    expect((await chiamate()).map((c) => c.url)).toEqual(['https://altro.invalid/api/pagamenti/fattura/coda/giro'])
  })

  it('configurazione assente: nessuna chiamata, e un error in app_log (deduplicato)', async () => {
    await tick()
    await tick()
    expect(await chiamate()).toEqual([])
    expect(await logCron()).toEqual([
      { livello: 'error', fingerprint: 'cron:fatture-coda-tick-url-assente', esito: 'url-assente', occorrenze: 2 },
    ])
  })

  it('segreto assente: nessuna chiamata destinata al 401, e un error in app_log', async () => {
    await db.exec(
      `INSERT INTO public.vault_finto (nome, valore) VALUES ('app.fattura_sync_url', 'https://esempio.invalid/x')`,
    )
    await tick()
    expect(await chiamate()).toEqual([])
    expect((await logCron()).map((r) => r.esito)).toEqual(['segreto-assente'])
  })

  it('pg_net che rifiuta la chiamata: error post-fallito, e la funzione non esplode', async () => {
    await db.exec(`
      INSERT INTO public.vault_finto (nome, valore) VALUES
        ('app.fattura_sync_url', 'https://esempio.invalid/x'), ('app.cron_secret', 's');
      CREATE OR REPLACE FUNCTION net.http_post(
        url text, body jsonb DEFAULT '{}'::jsonb, params jsonb DEFAULT '{}'::jsonb,
        headers jsonb DEFAULT '{}'::jsonb, timeout_milliseconds integer DEFAULT 5000
      ) RETURNS bigint LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'pg_net giù'; END $$;
    `)
    await expect(tick()).resolves.toBeUndefined()
    expect((await logCron()).map((r) => r.esito)).toEqual(['post-fallito'])
  })

  it('fail-open: se anche app_log manca, la sveglia non fa fallire il chiamante', async () => {
    await db.exec(`DROP TABLE public.app_log`)
    await expect(tick()).resolves.toBeUndefined()
  })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('controlli negativi · le prove devono fallire sulla migrazione rotta', () => {
  async function conMigrazione(sql: string) {
    await db.close()
    db = new PGlite()
    await preparaDatabase()
    await db.exec(sql)
  }

  it('senza il controllo del token, chiudi accetterebbe un altro lavoratore: la prova del token lo misura', async () => {
    const rotta = MIGRAZIONE.replace(
      'IF v_voce.stato <> \'in_invio\' OR v_voce.lavoratore_token IS DISTINCT FROM p_token THEN',
      "IF v_voce.stato <> 'in_invio' THEN",
    )
    expect(rotta).not.toBe(MIGRAZIONE)
    await conMigrazione(rotta)
    await nuovoPagamento(1)
    await accoda([{ pagamento_id: pag(1) }])
    const [voce] = await prendi(TOKEN_A, 1)
    expect(await erroreDi(chiudi(voce.id, TOKEN_B, 'emessa'))).toBeNull()
  })

  it('senza l’indice unico parziale, lo stesso pagamento nascerebbe due volte: la prova del dedup lo misura', async () => {
    const rotta = MIGRAZIONE.replace(
      /CREATE UNIQUE INDEX IF NOT EXISTS fatture_coda_una_attiva_uidx[\s\S]*?;/,
      '',
    ).replace(
      "ON CONFLICT (pagamento_id) WHERE stato IN ('in_coda', 'in_invio', 'errore') DO NOTHING",
      '',
    )
    expect(rotta).not.toBe(MIGRAZIONE)
    await conMigrazione(rotta)
    await nuovoPagamento(1)
    await accoda([{ pagamento_id: pag(1) }])
    const secondo = await accoda([{ pagamento_id: pag(1) }])
    expect(secondo.accodate).toBe(1)
    expect(await voci()).toHaveLength(2)
  })

  it('con un bidello che rimette in coda, la prova del bidello cadrebbe', async () => {
    const rotta = MIGRAZIONE.replace(
      /(WITH scadute AS \(\s*UPDATE public\.fatture_coda\s*SET stato\s*=\s*)'errore'/,
      "$1'in_coda'",
    ).replace("esito_codice      = 'esito_incerto',", "esito_codice      = 'esito_incerto', presa_il = NULL, lavoratore_token = NULL,")
    expect(rotta).not.toBe(MIGRAZIONE)
    await conMigrazione(rotta)
    await nuovoPagamento(1)
    await accoda([{ pagamento_id: pag(1) }])
    await prendi(TOKEN_A, 1)
    await db.exec(`UPDATE public.fatture_coda SET prestito_scade_il = now() - interval '1 second'`)
    await bidello()
    expect((await voceDi(1)).stato).toBe('in_coda')
  })

  it('senza le due righe dell’esito la togli lascerebbe il messaggio: la prova dell’esito lo misura', async () => {
    const rotta = TOGLI_AZZERA.replace(/\n\s+esito_codice\s+= NULL,\n\s+esito_messaggio\s+= NULL,/, '')
    expect(rotta).not.toBe(TOGLI_AZZERA)
    await conMigrazione(MIGRAZIONE)
    await db.exec(rotta)
    await nuovoPagamento(1)
    await accoda([{ pagamento_id: pag(1) }])
    const [voce] = await prendi(TOKEN_A, 1)
    await chiudi(voce.id, TOKEN_A, 'errore', 'scarto_aruba', 'Messaggio finto')
    expect(await togli([voce.id])).toBe(1)
    expect((await voceDi(1)).esito_messaggio).toBe('Messaggio finto')
  })

  it('senza il blocco DO le voci già tolte restano col messaggio: la prova della ripulitura lo misura', async () => {
    const senzaDo = TOGLI_AZZERA.replace(/DO \$\$[\s\S]*?END \$\$;/, '')
    expect(senzaDo).not.toBe(TOGLI_AZZERA)
    await conMigrazione(MIGRAZIONE)
    await nuovoPagamento(1)
    await accoda([{ pagamento_id: pag(1) }])
    const [voce] = await prendi(TOKEN_A, 1)
    await chiudi(voce.id, TOKEN_A, 'errore', 'scarto_aruba', 'Messaggio finto')
    await togli([voce.id]) // la togli VECCHIA
    await db.exec(senzaDo)
    expect((await voceDi(1)).esito_messaggio).toBe('Messaggio finto')
  })

  it('senza la riga nel ramo emessa il messaggio resterebbe: la prova della chiusura lo misura', async () => {
    const rotta = CHIUDI_AZZERA.replace(/esito_messaggio\s+= NULL,(\s+concluso_il)/, 'esito_messaggio     = v_messaggio,$1')
    expect(rotta).not.toBe(CHIUDI_AZZERA)
    await conMigrazione(MIGRAZIONE)
    await db.exec(TOGLI_AZZERA)
    await db.exec(rotta)
    await nuovoPagamento(1)
    await accoda([{ pagamento_id: pag(1) }])
    const [voce] = await prendi(TOKEN_A, 1)
    await chiudi(voce.id, TOKEN_A, 'emessa', 'emessa', 'Messaggio finto')
    expect((await voceDi(1)).esito_messaggio).toBe('Messaggio finto')
  })

  it('senza il blocco DO le emesse di prima restano col messaggio: la prova della ripulitura lo misura', async () => {
    const senzaDo = CHIUDI_AZZERA.replace(/DO \$\$[\s\S]*?END \$\$;/, '')
    expect(senzaDo).not.toBe(CHIUDI_AZZERA)
    await conMigrazione(MIGRAZIONE)
    await db.exec(TOGLI_AZZERA)
    await nuovoPagamento(1)
    await accoda([{ pagamento_id: pag(1) }])
    const [voce] = await prendi(TOKEN_A, 1)
    await chiudi(voce.id, TOKEN_A, 'emessa', 'emessa', 'Messaggio finto') // la chiudi VECCHIA
    await db.exec(senzaDo)
    expect((await voceDi(1)).esito_messaggio).toBe('Messaggio finto')
  })

  // ── correzione del 24/09: 65 s fra due accessi ad Aruba ────────────────────
  /** Nucleo, 2a e 2b come in produzione, poi il 24/09 (rotto); due pagamenti in coda. */
  async function conAccessi(sql: string) {
    await conMigrazione(MIGRAZIONE)
    await db.exec(TOGLI_AZZERA)
    await db.exec(CHIUDI_AZZERA)
    await db.exec(sql)
    for (const n of [1, 2]) await nuovoPagamento(n)
    await accoda([1, 2].map((n, i) => ({ pagamento_id: pag(n), ordine_selezione: i })))
  }

  it('senza il controllo dei 65 s un altro token prenderebbe subito: N1 lo misura', async () => {
    const rotta = DISTANZA_ACCESSI.replace(/\n\s*IF v_stato\.ultimo_accesso_il IS NOT NULL[\s\S]*?END IF;/, '')
    expect(rotta).not.toBe(DISTANZA_ACCESSI)
    await conAccessi(rotta)
    await prendi(TOKEN_A, 1)
    await rilascia(TOKEN_A, 0, null)
    expect(numeri(await prendi(TOKEN_B, 1))).toEqual([2])
  })

  it('senza il ramo di rilascia l’orologio resterebbe alla presa: N3 lo misura', async () => {
    const rotta = DISTANZA_ACCESSI.replace(/\n\s*IF p_token IS NOT NULL\s+AND EXISTS[\s\S]*?END IF;/, '')
    expect(rotta).not.toBe(DISTANZA_ACCESSI)
    await conAccessi(rotta)
    const [presa] = await prendi(TOKEN_A, 1)
    await chiudi(presa.id, TOKEN_A, 'emessa') // l'ordine del giro vero, come in N3
    await db.exec(
      `UPDATE public.fatture_coda_stato SET ultimo_accesso_il = now() - interval '10 minutes' WHERE id = 1`,
    )
    await rilascia(TOKEN_A, 0, null)
    expect(numeri(await prendi(TOKEN_B, 1))).toEqual([2])
  })

  it('senza il timbro della presa, un «Rimetti» prima del rilascio aprirebbe la porta: N6 lo misura', async () => {
    const rotta = DISTANZA_ACCESSI.replace(/\n\s*IF v_ids IS NOT NULL THEN[\s\S]*?END IF;/, '')
    expect(rotta).not.toBe(DISTANZA_ACCESSI)
    await conAccessi(rotta)
    const [voce] = await prendi(TOKEN_A, 1)
    await chiudi(voce.id, TOKEN_A, 'errore', 'scarto_aruba')
    expect(await rimetti([voce.id])).toBe(1)
    await rilascia(TOKEN_A, 0, null)
    expect(await prendi(TOKEN_B, 1)).toHaveLength(1)
  })

  it('senza il controllo del lavoratore un secondo token prenderebbe mentre il primo è vivo: «un solo lavoratore» lo misura', async () => {
    const rotta = DISTANZA_ACCESSI.replace(/\n\s*IF v_stato\.lavoratore_token IS NOT NULL[\s\S]*?END IF;/, '')
    expect(rotta).not.toBe(DISTANZA_ACCESSI)
    await conAccessi(rotta)
    await prendi(TOKEN_A, 1)
    await dimenticaAccesso() // lontano dall'accesso: l'unico freno rimasto sarebbe il lavoratore
    expect(await prendi(TOKEN_B, 1)).toHaveLength(1)
  })
})
