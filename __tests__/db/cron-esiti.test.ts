// @vitest-environment node
/**
 * La migrazione della sessione 6 (esiti dei cron), eseguita su PGlite dal FILE VERO della
 * cartella delle migrazioni, con `net` e `cron` finti che hanno le firme vere (misura 0.3).
 *
 * Cosa prova:
 *  · la migrazione gira anche dove pg_net e pg_cron non ci sono (il DB della CI);
 *  · l'involucro passa a pg_net gli stessi argomenti, ne conserva il numero, e se il registro non
 *    si scrive la richiesta parte lo stesso (la registrazione non può fermare un job);
 *  · il lettore classifica le risposte, scrive in app_log col nome del job, non conta due volte,
 *    non copia mai il corpo di una risposta, e se si guasta lascia una traccia;
 *  · `cron_ultimo_esito` ha una riga per job, HTTP o solo SQL, anche per quelli spenti.
 * Il Compito 5 aggiunge l'equivalenza prima/dopo di ogni funzione ridefinita.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'

const CARTELLA = join(process.cwd(), 'supabase/migrations')
const FILE = readdirSync(CARTELLA).filter((f) => f.endsWith('_cron_esiti_osservati.sql'))
const MIGRAZIONE = FILE.length === 1 ? readFileSync(join(CARTELLA, FILE[0]), 'utf8') : ''
const URL_FINTO = 'https://kidville.invalid/api/finto'

const aperti: PGlite[] = []
afterEach(async () => {
  while (aperti.length > 0) await aperti.pop()!.close()
})

async function nuovoDatabase(opzioni: { net?: boolean; cron?: boolean } = {}): Promise<PGlite> {
  const { net = true, cron = false } = opzioni
  const db = new PGlite()
  aperti.push(db)
  await db.exec(`
    -- Le funzioni generate dalla produzione possono nominare tabelle che qui non esistono: come in
    -- produzione, il corpo si risolve quando la funzione gira, non quando nasce.
    SET check_function_bodies = off;
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    -- I privilegi predefiniti del baseline (20260704120000_baseline.sql): tabelle, sequenze e
    -- funzioni nuove nascono aperte ai ruoli client. Senza, un REVOKE mancante non si vedrebbe.
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;

    -- app_log: le colonne che la migrazione scrive, più la chiave della deduplica.
    CREATE TABLE public.app_log (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      creato_il timestamptz NOT NULL DEFAULT now(),
      giorno date NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')::date,
      livello text NOT NULL CHECK (livello IN ('info','warn','error')),
      evento text NOT NULL,
      sorgente text NOT NULL DEFAULT 'server',
      messaggio text NOT NULL,
      codice text,
      route text,
      stato_http int,
      fingerprint text NOT NULL,
      occorrenze int NOT NULL DEFAULT 1,
      visto_l_ultima timestamptz NOT NULL DEFAULT now(),
      contesto jsonb NOT NULL DEFAULT '{}'::jsonb
    );
    CREATE UNIQUE INDEX app_log_impronta_giorno_key ON public.app_log (fingerprint, giorno);

    -- Il Vault finto: le funzioni dei cron leggono URL e segreto da cron_config.
    CREATE TABLE public.vault_finto (nome text PRIMARY KEY, valore text);
    INSERT INTO public.vault_finto (nome, valore) VALUES
      ('app.cron_secret', 'segreto-di-prova'),
      ('app.push_dispatch_url', '${URL_FINTO}'),
      ('app.notifiche_promemoria_url', '${URL_FINTO}'),
      ('app.mensa_allergie_url', '${URL_FINTO}'),
      ('app.fattura_sync_url', '${URL_FINTO}'),
      ('app.retention_iscrizioni_url', '${URL_FINTO}');
    CREATE SCHEMA vault;
    CREATE VIEW vault.decrypted_secrets AS SELECT nome AS name, valore AS decrypted_secret FROM public.vault_finto;
    CREATE FUNCTION public.cron_config(p_nome text) RETURNS text
    LANGUAGE sql AS $$ SELECT valore FROM public.vault_finto WHERE nome = p_nome $$;
  `)
  if (net) {
    await db.exec(`
      CREATE SCHEMA net;
      CREATE TABLE net.chiamate (
        n bigserial PRIMARY KEY, url text, body jsonb, params jsonb, headers jsonb, timeout_milliseconds int
      );
      CREATE FUNCTION net.http_post(
        url text,
        body jsonb DEFAULT '{}'::jsonb,
        params jsonb DEFAULT '{}'::jsonb,
        headers jsonb DEFAULT '{"Content-Type": "application/json"}'::jsonb,
        timeout_milliseconds integer DEFAULT 5000
      ) RETURNS bigint
      LANGUAGE sql AS $$
        INSERT INTO net.chiamate (url, body, params, headers, timeout_milliseconds)
        VALUES ($1, $2, $3, $4, $5) RETURNING n
      $$;
      CREATE TABLE net._http_response (
        id bigint, status_code integer, content_type text, headers jsonb, content text,
        timed_out boolean, error_msg text, created timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE net.http_request_queue (id bigint PRIMARY KEY);
    `)
  }
  if (cron) {
    await db.exec(`
      CREATE SCHEMA cron;
      CREATE TABLE cron.job (
        jobid bigserial PRIMARY KEY, jobname text, schedule text, command text, active boolean NOT NULL DEFAULT true
      );
      CREATE TABLE cron.job_run_details (
        runid bigserial PRIMARY KEY, jobid bigint, status text, return_message text,
        start_time timestamptz DEFAULT now(), end_time timestamptz
      );
      CREATE FUNCTION cron.schedule(text, text, text) RETURNS bigint
      LANGUAGE sql AS $$ INSERT INTO cron.job (jobname, schedule, command) VALUES ($1, $2, $3) RETURNING jobid $$;
      CREATE FUNCTION cron.unschedule(bigint) RETURNS boolean
      LANGUAGE sql AS $$ DELETE FROM cron.job WHERE jobid = $1 RETURNING true $$;
    `)
  }
  return db
}

async function righe<T = Record<string, unknown>>(db: PGlite, sql: string, parametri: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(sql, parametri)).rows
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

type Risposta = { status_code?: number; timed_out?: boolean; error_msg?: string; content?: string }

/** Una chiamata passata dall'involucro e, se `risposta` non è null, la riga che pg_net scriverebbe. */
async function chiamata(db: PGlite, job: string, risposta: Risposta | null): Promise<number> {
  const [{ id }] = await righe<{ id: number }>(db, 'SELECT public.cron_http_post($1, $2) AS id', [job, `${URL_FINTO}/${job}`])
  if (risposta) {
    await db.query(
      'INSERT INTO net._http_response (id, status_code, timed_out, error_msg, content) VALUES ($1, $2, $3, $4, $5)',
      [id, risposta.status_code ?? null, risposta.timed_out ?? false, risposta.error_msg ?? null, risposta.content ?? null],
    )
  }
  return Number(id)
}

const esitoDelLettore = async (db: PGlite) =>
  (await righe<{ esito: Record<string, unknown> }>(db, 'SELECT public.cron_esiti() AS esito'))[0].esito

describe('la migrazione della sessione 6', () => {
  it('esiste, ed è una sola', () => {
    expect(FILE).toHaveLength(1)
  })

  it('gira senza pg_net e senza pg_cron (il DB della CI), e il lettore lascia comunque il battito', async () => {
    const db = await nuovoDatabase({ net: false, cron: false })
    await db.exec(MIGRAZIONE)
    expect(await esitoDelLettore(db)).toMatchObject({ operazione: 'cron-esiti', esito: 'ok', net: false, cron: false, chiuse: 0 })
    expect(await righe(db, "SELECT livello, evento, occorrenze FROM app_log WHERE fingerprint = 'cron:cron-esiti'"))
      .toEqual([{ livello: 'info', evento: 'cron', occorrenze: 1 }])
  })

  it('installa un solo job cron-esiti, 4 minuti dopo ogni decina, anche se rieseguita', async () => {
    const db = await nuovoDatabase({ cron: true })
    await db.exec(MIGRAZIONE)
    await db.exec(MIGRAZIONE)
    expect(await righe(db, "SELECT schedule, command FROM cron.job WHERE jobname = 'cron-esiti'"))
      .toEqual([{ schedule: '4,14,24,34,44,54 * * * *', command: 'SELECT public.cron_esiti();' }])
  })
})

describe('l’involucro cron_http_post', () => {
  it('ha gli argomenti di net.http_post dopo il nome del job (misura 0.3)', async () => {
    const db = await nuovoDatabase()
    await db.exec(MIGRAZIONE)
    expect(await righe(db, "SELECT pg_get_function_arguments('public.cron_http_post'::regproc) AS a")).toEqual([{
      a: `job text, url text, body jsonb DEFAULT '{}'::jsonb, params jsonb DEFAULT '{}'::jsonb, headers jsonb DEFAULT '{"Content-Type": "application/json"}'::jsonb, timeout_milliseconds integer DEFAULT 5000`,
    }])
  })

  it('passa a pg_net gli stessi argomenti e conserva il numero della richiesta', async () => {
    const db = await nuovoDatabase()
    await db.exec(MIGRAZIONE)
    await db.query(`SELECT public.cron_http_post('news-tick',
      url := '${URL_FINTO}/news/cron?giro=1', headers := '{"x-cron-secret": "s"}'::jsonb,
      body := '{"a": 1}'::jsonb, timeout_milliseconds := 120000)`)
    expect(await righe(db, 'SELECT url, body, params, headers, timeout_milliseconds FROM net.chiamate')).toEqual([{
      url: `${URL_FINTO}/news/cron?giro=1`, body: { a: 1 }, params: {}, headers: { 'x-cron-secret': 's' }, timeout_milliseconds: 120000,
    }])
    expect(await righe(db, `SELECT job, percorso, timeout_ms, esito,
        richiesta_id = (SELECT max(n) FROM net.chiamate) AS stessa_richiesta FROM public.cron_chiamate`))
      .toEqual([{ job: 'news-tick', percorso: '/api/finto/news/cron', timeout_ms: 120000, esito: 'in-attesa', stessa_richiesta: true }])
    await db.query(`SELECT public.cron_http_post('x', '${URL_FINTO}/y')`)
    expect(await righe(db, 'SELECT body, params, headers, timeout_milliseconds FROM net.chiamate ORDER BY n DESC LIMIT 1'))
      .toEqual([{ body: {}, params: {}, headers: { 'Content-Type': 'application/json' }, timeout_milliseconds: 5000 }])
  })

  it('se il registro non si scrive la richiesta parte lo stesso, e resta un error in app_log', async () => {
    const db = await nuovoDatabase()
    await db.exec(MIGRAZIONE)
    await db.exec("ALTER TABLE public.cron_chiamate ADD CONSTRAINT guasto_di_prova CHECK (job <> 'rotto')")
    await db.query(`SELECT public.cron_http_post('rotto', '${URL_FINTO}/z')`)
    expect(await righe(db, 'SELECT count(*)::int AS n FROM net.chiamate')).toEqual([{ n: 1 }])
    expect(await righe(db, 'SELECT count(*)::int AS n FROM public.cron_chiamate')).toEqual([{ n: 0 }])
    expect(await righe(db, `SELECT livello, evento, codice, contesto->'campi'->>'job' AS job
        FROM app_log WHERE fingerprint = 'cron-http:registro-non-scritto'`))
      .toEqual([{ livello: 'error', evento: 'cron', codice: '23514', job: 'rotto' }])
  })

  it('un errore di pg_net arriva a chi chiama, come prima, e non lascia righe', async () => {
    const db = await nuovoDatabase()
    await db.exec(MIGRAZIONE)
    await db.exec(`CREATE OR REPLACE FUNCTION net.http_post(
        url text, body jsonb DEFAULT '{}'::jsonb, params jsonb DEFAULT '{}'::jsonb,
        headers jsonb DEFAULT '{"Content-Type": "application/json"}'::jsonb, timeout_milliseconds integer DEFAULT 5000
      ) RETURNS bigint LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'coda piena' USING ERRCODE = '53400'; END $$`)
    expect((await erroreDi(db.query(`SELECT public.cron_http_post('x', '${URL_FINTO}/y')`)))?.code).toBe('53400')
    expect(await righe(db, 'SELECT count(*)::int AS n FROM public.cron_chiamate')).toEqual([{ n: 0 }])
  })
})

describe('il lettore cron_esiti', () => {
  it('classifica ok, errore HTTP, timeout, rete; lascia aperte quelle in volo; non conta due volte', async () => {
    const db = await nuovoDatabase()
    await db.exec(MIGRAZIONE)
    await chiamata(db, 'news-tick', { status_code: 200 })
    await chiamata(db, 'storici-stampe', { status_code: 500, content: '{"errore":"x","codice":"STORICI_GUASTO"}' })
    await chiamata(db, 'storici-stampe', { status_code: 401, content: 'Il nome di un bambino che non deve uscire' })
    await chiamata(db, 'fatture-coda-tick', { timed_out: true, error_msg: 'Timeout of 300000 ms reached' })
    await chiamata(db, 'mensa-check-allergie', { error_msg: "Couldn't resolve host name" })
    const inVolo = await chiamata(db, 'video-runner-tick', null)

    expect(await esitoDelLettore(db)).toMatchObject({ esito: 'ok', chiuse: 5, ignote: 0 })
    expect(await righe(db, 'SELECT job, esito, codice_http, codice_errore FROM public.cron_chiamate ORDER BY id')).toEqual([
      { job: 'news-tick', esito: 'ok', codice_http: 200, codice_errore: null },
      { job: 'storici-stampe', esito: 'errore-http', codice_http: 500, codice_errore: 'STORICI_GUASTO' },
      { job: 'storici-stampe', esito: 'errore-http', codice_http: 401, codice_errore: null },
      { job: 'fatture-coda-tick', esito: 'timeout', codice_http: null, codice_errore: null },
      { job: 'mensa-check-allergie', esito: 'errore-rete', codice_http: null, codice_errore: null },
      { job: 'video-runner-tick', esito: 'in-attesa', codice_http: null, codice_errore: null },
    ])
    expect(await righe(db, `SELECT fingerprint, livello, evento, codice, route, stato_http, occorrenze
        FROM app_log WHERE fingerprint <> 'cron:cron-esiti' ORDER BY fingerprint COLLATE "C"`)).toEqual([
      { fingerprint: 'cron-http-timeout:fatture-coda-tick', livello: 'info', evento: 'cron', codice: 'TIMEOUT_PG_NET', route: '/api/finto/fatture-coda-tick', stato_http: null, occorrenze: 1 },
      { fingerprint: 'cron-http:mensa-check-allergie', livello: 'error', evento: 'cron', codice: 'ERRORE_RETE', route: '/api/finto/mensa-check-allergie', stato_http: null, occorrenze: 1 },
      { fingerprint: 'cron-http:storici-stampe', livello: 'error', evento: 'cron', codice: 'STORICI_GUASTO', route: '/api/finto/storici-stampe', stato_http: 500, occorrenze: 2 },
    ])
    const tutto = JSON.stringify([await righe(db, 'SELECT * FROM app_log'), await righe(db, 'SELECT * FROM public.cron_chiamate')])
    expect(tutto).not.toContain('bambino')

    expect(await esitoDelLettore(db)).toMatchObject({ esito: 'ok', chiuse: 0 })
    expect(await righe(db, "SELECT occorrenze FROM app_log WHERE fingerprint = 'cron-http:storici-stampe'")).toEqual([{ occorrenze: 2 }])
    expect(await righe(db, "SELECT occorrenze FROM app_log WHERE fingerprint = 'cron:cron-esiti'")).toEqual([{ occorrenze: 2 }])

    await db.query('INSERT INTO net._http_response (id, status_code) VALUES ($1, 202)', [inVolo])
    expect(await esitoDelLettore(db)).toMatchObject({ chiuse: 1 })
    expect(await righe(db, "SELECT esito FROM public.cron_chiamate WHERE job = 'video-runner-tick'")).toEqual([{ esito: 'ok' }])
  })

  it('un 3xx non è un errore (la specifica: 4xx, 5xx, rete); un 400 sì', async () => {
    const db = await nuovoDatabase()
    await db.exec(MIGRAZIONE)
    await chiamata(db, 'news-tick', { status_code: 302, content: '{"codice":"NON_DEVE_ESSERE_LETTO"}' })
    await chiamata(db, 'news-digest', { status_code: 400, content: '{"codice":"RICHIESTA_NON_VALIDA"}' })

    expect(await esitoDelLettore(db)).toMatchObject({ esito: 'ok', chiuse: 2 })
    expect(await righe(db, 'SELECT job, esito, codice_http, codice_errore FROM public.cron_chiamate ORDER BY id')).toEqual([
      { job: 'news-tick', esito: 'ok', codice_http: 302, codice_errore: null },
      { job: 'news-digest', esito: 'errore-http', codice_http: 400, codice_errore: 'RICHIESTA_NON_VALIDA' },
    ])
    expect(await righe(db, `SELECT fingerprint, livello, codice, stato_http FROM app_log
        WHERE fingerprint LIKE 'cron-http%' ORDER BY fingerprint COLLATE "C"`)).toEqual([
      { fingerprint: 'cron-http:news-digest', livello: 'error', codice: 'RICHIESTA_NON_VALIDA', stato_http: 400 },
    ])
  })

  it('dopo la vita delle risposte e senza risposta: esito-ignoto, salvo se è ancora in coda', async () => {
    const db = await nuovoDatabase()
    await db.exec(MIGRAZIONE)
    await chiamata(db, 'news-tick', null)
    const inCoda = await chiamata(db, 'news-digest', null)
    await db.query('INSERT INTO net.http_request_queue (id) VALUES ($1)', [inCoda])
    await db.exec("UPDATE public.cron_chiamate SET inviata_il = now() - interval '7 hours'")
    expect(await esitoDelLettore(db)).toMatchObject({ ignote: 1 })
    expect(await righe(db, 'SELECT job, esito FROM public.cron_chiamate ORDER BY id'))
      .toEqual([{ job: 'news-tick', esito: 'esito-ignoto' }, { job: 'news-digest', esito: 'in-attesa' }])
    expect(await righe(db, "SELECT livello, codice, occorrenze FROM app_log WHERE fingerprint = 'cron-esiti:esiti-persi'"))
      .toEqual([{ livello: 'warn', codice: 'ESITO_IGNOTO', occorrenze: 1 }])
  })

  it('cron_ultimo_esito: una riga per job, SQL e HTTP, attivi e spenti; un fallimento SQL nuovo diventa un error', async () => {
    const db = await nuovoDatabase({ cron: true })
    await db.exec(`INSERT INTO cron.job (jobname, schedule, command, active) VALUES
      ('app-log-purge', '17 3 * * *', 'SELECT 1', true),
      ('news-tick', '*/10 * * * *', 'SELECT public.news_tick()', true),
      ('news-digest', '0 7 * * *', 'SELECT public.news_digest_tick()', false)`)
    await db.exec(MIGRAZIONE)
    await db.exec(`
      INSERT INTO cron.job_run_details (jobid, status, start_time, end_time)
      SELECT jobid, 'failed', now() - interval '2 minutes', now() - interval '119 seconds' FROM cron.job WHERE jobname = 'app-log-purge';
      INSERT INTO cron.job_run_details (jobid, status, start_time, end_time)
      SELECT jobid, 'succeeded', now() - interval '1 minute', now() - interval '59 seconds'
        FROM cron.job WHERE jobname IN ('app-log-purge', 'news-tick');
    `)
    await chiamata(db, 'news-tick', { status_code: 200 })
    await esitoDelLettore(db)
    expect(await righe(db, `SELECT job, attivo, http, ultima_esecuzione_stato,
        ultimo_ok_il IS NOT NULL AS ok, ultimo_errore_il IS NOT NULL AS errore, ultima_chiamata_esito
        FROM public.cron_ultimo_esito ORDER BY job COLLATE "C"`)).toEqual([
      { job: 'app-log-purge', attivo: true, http: false, ultima_esecuzione_stato: 'succeeded', ok: true, errore: true, ultima_chiamata_esito: null },
      { job: 'cron-esiti', attivo: true, http: false, ultima_esecuzione_stato: null, ok: false, errore: false, ultima_chiamata_esito: null },
      { job: 'news-digest', attivo: false, http: false, ultima_esecuzione_stato: null, ok: false, errore: false, ultima_chiamata_esito: null },
      { job: 'news-tick', attivo: true, http: true, ultima_esecuzione_stato: 'succeeded', ok: true, errore: false, ultima_chiamata_esito: 'ok' },
    ])
    // Il fallimento visto al primo giro IN ASSOLUTO (cron_ultimo_esito ancora vuota) è storia di
    // prima dell'installazione: non diventa un error.
    expect(await righe(db, "SELECT count(*)::int AS n FROM app_log WHERE fingerprint LIKE 'cron-sql:%'")).toEqual([{ n: 0 }])

    await db.exec(`INSERT INTO cron.job_run_details (jobid, status, return_message, start_time, end_time)
      SELECT jobid, 'failed', 'ERROR: testo che non deve uscire', now(), now() FROM cron.job WHERE jobname = 'app-log-purge'`)
    await esitoDelLettore(db)
    expect(await righe(db, "SELECT livello, evento, codice, occorrenze FROM app_log WHERE fingerprint = 'cron-sql:app-log-purge'"))
      .toEqual([{ livello: 'error', evento: 'cron', codice: 'CRON_ESECUZIONE_FALLITA', occorrenze: 1 }])
    expect(await righe(db, "SELECT ultima_esecuzione_stato FROM public.cron_ultimo_esito WHERE job = 'app-log-purge'"))
      .toEqual([{ ultima_esecuzione_stato: 'failed' }])
    expect(JSON.stringify(await righe(db, 'SELECT * FROM app_log'))).not.toContain('non deve uscire')

    await db.exec("DELETE FROM cron.job WHERE jobname = 'news-tick'")
    await esitoDelLettore(db)
    expect(await righe(db, "SELECT attivo FROM public.cron_ultimo_esito WHERE job = 'news-tick'")).toEqual([{ attivo: false }])
  })

  it('un mensile mai visto dal lettore: la sua prima corsa fallita dopo l’installazione è un error; il primo giro in assoluto non scrive', async () => {
    const db = await nuovoDatabase({ cron: true })
    await db.exec(`INSERT INTO cron.job (jobname, schedule, command) VALUES
      ('news-tick', '*/10 * * * *', 'SELECT public.news_tick()'),
      ('notifiche-retention', '35 4 1 * *', 'SELECT public.notifiche_retention_tick()')`)
    // Storia di prima dell'installazione: il mensile è fallito un mese fa, e dopo sono passate più
    // esecuzioni di quante il lettore ne scorra (v_finestra_run = 5000): quel giro non si vede, e il
    // suo ultimo_runid resta nullo anche dopo il primo giro.
    await db.exec(`
      INSERT INTO cron.job_run_details (jobid, status, start_time, end_time)
      SELECT jobid, 'failed', now() - interval '30 days', now() - interval '30 days'
        FROM cron.job WHERE jobname = 'notifiche-retention';
      INSERT INTO cron.job_run_details (jobid, status, start_time, end_time)
      SELECT j.jobid, 'succeeded', now() - interval '1 minute', now() - interval '1 minute'
        FROM cron.job AS j CROSS JOIN generate_series(1, 5001) WHERE j.jobname = 'news-tick';
    `)
    await db.exec(MIGRAZIONE)

    // Il primo giro in assoluto: cron_ultimo_esito era vuota. Si popola, e niente diventa un error.
    expect(await righe(db, 'SELECT count(*)::int AS n FROM public.cron_ultimo_esito')).toEqual([{ n: 0 }])
    expect(await esitoDelLettore(db)).toMatchObject({ esito: 'ok', primo_giro: true, fallite: 0 })
    expect(await righe(db, `SELECT job, ultimo_runid IS NULL AS mai_visto
        FROM public.cron_ultimo_esito ORDER BY job COLLATE "C"`)).toEqual([
      { job: 'cron-esiti', mai_visto: true },
      { job: 'news-tick', mai_visto: false },
      { job: 'notifiche-retention', mai_visto: true },
    ])
    expect(await righe(db, "SELECT count(*)::int AS n FROM app_log WHERE fingerprint LIKE 'cron-sql:%'")).toEqual([{ n: 0 }])

    // La prima corsa del mensile dopo l'installazione fallisce. Il suo ultimo_runid era nullo, ma la
    // tabella era già popolata: è un error, e conta una volta sola (il fallimento di un mese fa no).
    await db.exec(`INSERT INTO cron.job_run_details (jobid, status, return_message, start_time, end_time)
      SELECT jobid, 'failed', 'ERROR: testo che non deve uscire', now(), now()
        FROM cron.job WHERE jobname = 'notifiche-retention'`)
    expect(await esitoDelLettore(db)).toMatchObject({ esito: 'ok', primo_giro: false, fallite: 1 })
    expect(await righe(db, `SELECT livello, evento, codice, occorrenze, contesto->'campi'->>'job' AS job
        FROM app_log WHERE fingerprint = 'cron-sql:notifiche-retention'`))
      .toEqual([{ livello: 'error', evento: 'cron', codice: 'CRON_ESECUZIONE_FALLITA', occorrenze: 1, job: 'notifiche-retention' }])
    expect(await righe(db, `SELECT ultima_esecuzione_stato, ultimo_runid IS NULL AS mai_visto
        FROM public.cron_ultimo_esito WHERE job = 'notifiche-retention'`))
      .toEqual([{ ultima_esecuzione_stato: 'failed', mai_visto: false }])
    expect(JSON.stringify(await righe(db, 'SELECT * FROM app_log'))).not.toContain('non deve uscire')
  })

  it('se si guasta lascia cron-esiti:fallito; se non può scrivere neanche quello, l’errore esce', async () => {
    const db = await nuovoDatabase()
    await db.exec(MIGRAZIONE)
    await db.exec('ALTER TABLE public.cron_chiamate RENAME TO cron_chiamate_altrove')
    expect(await esitoDelLettore(db)).toEqual({ operazione: 'cron-esiti', esito: 'fallito', sqlstate: '42P01' })
    expect(await righe(db, "SELECT livello, codice FROM app_log WHERE fingerprint = 'cron-esiti:fallito'"))
      .toEqual([{ livello: 'error', codice: '42P01' }])
    expect(await righe(db, "SELECT count(*)::int AS n FROM app_log WHERE fingerprint = 'cron:cron-esiti'")).toEqual([{ n: 0 }])
    await db.exec('ALTER TABLE public.app_log RENAME TO app_log_altrove')
    expect((await erroreDi(db.query('SELECT public.cron_esiti()')))?.code).toBe('42P01')
  })

  it('involucro e lettore: SECURITY DEFINER, search_path fisso, nessun ruolo client; tabelle chiuse', async () => {
    const db = await nuovoDatabase()
    await db.exec(MIGRAZIONE)
    expect(await righe(db, `SELECT p.proname, p.prosecdef, array_to_string(p.proconfig, ',') AS config,
        has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
        has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
        has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role
        FROM pg_proc p WHERE p.proname IN ('cron_http_post', 'cron_esiti') ORDER BY 1`)).toEqual([
      { proname: 'cron_esiti', prosecdef: true, config: 'search_path=public, pg_temp', anon: false, authenticated: false, service_role: false },
      { proname: 'cron_http_post', prosecdef: true, config: 'search_path=public, pg_temp', anon: false, authenticated: false, service_role: false },
    ])
    expect(await righe(db, `SELECT c.relname, c.relrowsecurity,
        has_table_privilege('anon', c.oid, 'SELECT') AS anon,
        has_table_privilege('authenticated', c.oid, 'SELECT') AS authenticated,
        has_table_privilege('service_role', c.oid, 'SELECT') AS service_select,
        has_table_privilege('service_role', c.oid, 'INSERT') AS service_insert
        FROM pg_class c WHERE c.relname IN ('cron_chiamate', 'cron_ultimo_esito') ORDER BY 1`)).toEqual([
      { relname: 'cron_chiamate', relrowsecurity: true, anon: false, authenticated: false, service_select: true, service_insert: false },
      { relname: 'cron_ultimo_esito', relrowsecurity: true, anon: false, authenticated: false, service_select: true, service_insert: false },
    ])
    expect(await righe(db, `SELECT has_sequence_privilege('anon', 'public.cron_chiamate_id_seq', 'USAGE') AS anon,
        has_sequence_privilege('authenticated', 'public.cron_chiamate_id_seq', 'USAGE') AS authenticated`))
      .toEqual([{ anon: false, authenticated: false }])
  })
})
