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
 *  · `cron_ultimo_esito` ha una riga per job, HTTP o solo SQL, anche per quelli spenti;
 *  · (Compito 5) ogni funzione ridefinita è, svolta, la definizione della produzione byte per byte;
 *    fa la stessa chiamata di prima, anche quando pg_net solleva o il Vault è vuoto; conserva
 *    proprietario, permessi, SECURITY DEFINER e search_path; la migrazione inversa la rimette
 *    com'era in produzione.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { NON_SI_AVVOLGONO, corpoDi, inversa, mascheraSql, md5, minimoAvvolte, svolgi } from '../../scripts/cron-esiti/involucro.mjs'

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

    -- Quello che tre corpi della produzione toccano PRIMA di chiamare il server, con le firme del
    -- repo e tabelle vuote: senza, storici_tick, iscrizioni_retention_http e video_runner_kick si
    -- fermerebbero prima di pg_net e il confronto prima/dopo non le proverebbe.
    CREATE TABLE public.iscrizioni_retention_esecuzioni (request_id bigint);
    CREATE TABLE public.alunni (id uuid, stato text, stato_cambiato_il timestamptz);
    CREATE TABLE public.storici_revisioni (alunno_id uuid, modulo text, giorno_competenza date, contenuto jsonb);
    CREATE FUNCTION public.alunno_uscita_consolidata(text, timestamptz) RETURNS boolean
    LANGUAGE sql AS $$ SELECT false $$;
    CREATE FUNCTION public._video_job_transition_log(
      p_operazione text, p_livello text, p_job uuid, p_altro uuid, p_codice text, p_campi jsonb DEFAULT '{}'::jsonb
    ) RETURNS void
    LANGUAGE sql AS $$
      INSERT INTO public.app_log (livello, evento, messaggio, codice, fingerprint)
      VALUES (p_livello, 'video', 'transizione di prova', p_codice, p_operazione || ':' || coalesce(p_codice, 'ok'))
      ON CONFLICT (fingerprint, giorno) DO UPDATE SET occorrenze = public.app_log.occorrenze + 1
    $$;
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

  it('del corpo di una risposta passa solo il campo JSON «codice» o «code» in forma di codice; mai una parola trovata nel testo', async () => {
    const db = await nuovoDatabase()
    await db.exec(MIGRAZIONE)
    await chiamata(db, 'j-codice', { status_code: 500, content: '{ "error" : "x", "codice" :  "ERRORE_INTERNO" }' })
    await chiamata(db, 'j-code', { status_code: 403, content: '{"code":"NON_AUTORIZZATO","error":"x"}' })
    // una parola in maiuscolo con un trattino basso nel testo, anche se somiglia a un nome: non è un codice
    await chiamata(db, 'j-testo', { status_code: 500, content: 'Utente ROSSI_MARIO_80 non trovato' })
    await chiamata(db, 'j-html', { status_code: 500, content: '<script id="__NEXT_DATA__" type="application/json">{}</script>' })
    // il campo c'è ma non è un codice: minuscolo, troppo corto, con uno spazio, più lungo di 64 caratteri
    await chiamata(db, 'j-minuscolo', { status_code: 500, content: '{"codice":"non_un_codice"}' })
    await chiamata(db, 'j-corto', { status_code: 500, content: '{"codice":"AB"}' })
    await chiamata(db, 'j-spazio', { status_code: 500, content: '{"codice":"ROSSI MARIO"}' })
    await chiamata(db, 'j-lungo', { status_code: 500, content: `{"codice":"${'A'.repeat(65)}"}` })
    // un campo che si chiama in un altro modo non conta, nemmeno se il valore sembra un codice
    await chiamata(db, 'j-altro', { status_code: 500, content: '{"messaggio":"ERRORE_INTERNO","nome":"ROSSI_MARIO_80"}' })

    expect(await esitoDelLettore(db)).toMatchObject({ esito: 'ok', chiuse: 9 })
    expect(await righe(db, 'SELECT job, codice_errore FROM public.cron_chiamate ORDER BY id')).toEqual([
      { job: 'j-codice', codice_errore: 'ERRORE_INTERNO' },
      { job: 'j-code', codice_errore: 'NON_AUTORIZZATO' },
      { job: 'j-testo', codice_errore: null },
      { job: 'j-html', codice_errore: null },
      { job: 'j-minuscolo', codice_errore: null },
      { job: 'j-corto', codice_errore: null },
      { job: 'j-spazio', codice_errore: null },
      { job: 'j-lungo', codice_errore: null },
      { job: 'j-altro', codice_errore: null },
    ])
    // senza codice, in app_log resta il codice di ripiego («HTTP_<stato>»): mai un pezzo del corpo
    expect(await righe(db, "SELECT codice FROM app_log WHERE fingerprint = 'cron-http:j-testo'")).toEqual([{ codice: 'HTTP_500' }])
    expect(JSON.stringify(await righe(db, 'SELECT * FROM app_log'))).not.toMatch(/ROSSI|NEXT_DATA/)
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

/** Le funzioni che la migrazione ridefinisce, con la definizione di prima (svolta) e l'etichetta. */
function ridefinite(): { nome: string; prima: string; dopo: string; job: string }[] {
  const codice = mascheraSql(MIGRAZIONE)
  const trovate: { nome: string; prima: string; dopo: string; job: string }[] = []
  for (const m of codice.matchAll(/\bCREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.([a-z_][a-z0-9_]*)\s*\(/gi)) {
    if (m[1] === 'cron_http_post' || m[1] === 'cron_esiti') continue
    const fine = codice.indexOf(';', m.index)
    const { definizione, job } = svolgi(MIGRAZIONE.slice(m.index, fine))
    trovate.push({ nome: m[1], prima: definizione, dopo: MIGRAZIONE.slice(m.index, fine), job })
  }
  return trovate
}

describe('le funzioni ridefinite fanno la stessa chiamata di prima', () => {
  const RIDEFINITE = ridefinite()

  it('sono almeno quelle attese, nessuna è fra le escluse, nessun nome due volte', () => {
    expect(RIDEFINITE.length).toBeGreaterThanOrEqual(minimoAvvolte())
    for (const r of RIDEFINITE) expect(Object.hasOwn(NON_SI_AVVOLGONO, r.nome), r.nome).toBe(false)
    expect(new Set(RIDEFINITE.map((r) => r.nome)).size).toBe(RIDEFINITE.length)
  })

  it('prima e dopo: stesse chiamate a pg_net, stessi errori, stesse righe in app_log', { timeout: 120_000 }, async () => {
    const prima = await nuovoDatabase()
    await prima.exec(RIDEFINITE.map((r) => `${r.prima};`).join('\n\n'))
    const dopo = await nuovoDatabase()
    await dopo.exec(MIGRAZIONE)
    let raggiunte = 0
    for (const r of RIDEFINITE) {
      const esiti: unknown[] = []
      for (const db of [prima, dopo]) {
        await db.exec('DELETE FROM net.chiamate; DELETE FROM public.app_log;')
        const [{ n, trigger }] = await righe<{ n: number; trigger: boolean }>(db,
          `SELECT p.pronargs::int AS n, p.prorettype = 'trigger'::regtype AS trigger
             FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace
            WHERE s.nspname = 'public' AND p.proname = $1`, [r.nome])
        if (trigger) { esiti.push('funzione di trigger: non si chiama da sola'); continue }
        const errore = await erroreDi(db.query(`SELECT public.${r.nome}(${Array(n).fill('NULL').join(', ')})`))
        esiti.push({
          errore: errore?.code ?? null,
          chiamate: await righe(db, 'SELECT url, body, params, headers, timeout_milliseconds FROM net.chiamate ORDER BY n'),
          log: await righe(db, 'SELECT fingerprint, livello FROM public.app_log ORDER BY fingerprint COLLATE "C"'),
        })
      }
      expect(esiti[1], r.nome).toEqual(esiti[0])
      if ((await righe<{ n: number }>(dopo, 'SELECT count(*)::int AS n FROM net.chiamate'))[0].n > 0) {
        raggiunte++
        expect(await righe(dopo,
          'SELECT DISTINCT job FROM public.cron_chiamate WHERE richiesta_id IN (SELECT n FROM net.chiamate)'), r.nome)
          .toEqual([{ job: r.job }])
      }
    }
    // Le cinque più semplici (dispatch, promemoria, allergie, news, digest) leggono il Vault e chiamano:
    // se nemmeno quelle arrivano a pg_net, il banco di prova non sta provando niente.
    expect(raggiunte).toBeGreaterThanOrEqual(5)
  })

  it('la migrazione inversa rimette ogni funzione com’era e toglie job, funzioni e tabelle', async () => {
    const db = await nuovoDatabase({ cron: true })
    await db.exec(MIGRAZIONE)
    await db.exec(inversa(MIGRAZIONE))
    for (const r of RIDEFINITE) {
      expect(await righe(db, `SELECT md5(p.prosrc) AS m FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace
          WHERE s.nspname = 'public' AND p.proname = $1`, [r.nome]), r.nome).toEqual([{ m: md5(corpoDi(r.prima).corpo) }])
    }
    expect(await righe(db, `SELECT to_regclass('public.cron_chiamate') IS NULL AS a, to_regclass('public.cron_ultimo_esito') IS NULL AS b,
        (SELECT count(*)::int FROM pg_proc WHERE proname IN ('cron_http_post', 'cron_esiti')) AS f,
        (SELECT count(*)::int FROM cron.job WHERE jobname = 'cron-esiti') AS j`)).toEqual([{ a: true, b: true, f: 0, j: 0 }])
  })
})

/*
 * ─── IL CONFRONTO CON LA PRODUZIONE, FUORI DAL GENERATORE ───────────────────────────────
 *
 * I test qui sopra confrontano la migrazione con sé stessa: «prima» è la definizione SVOLTA dalla
 * migrazione. Se il generatore perdesse un argomento, un SECURITY DEFINER, un search_path o
 * sbagliasse l'etichetta, prima e dopo sbaglierebbero insieme e resterebbero uguali. Serve un
 * termine di paragone che il generatore non scrive: questi valori, letti in produzione con una
 * SELECT sui cataloghi il 2026-10-25 (misura 0.6 delle 09:37 UTC, riletta prima delle 10:40 UTC con
 * proacl e proconfig: impronte identiche). Non sono segreti: nomi di job, md5 e attributi delle funzioni.
 *   impronta = md5(pg_get_functiondef(oid))   corpo = md5(prosrc)
 */
const SP_PUBBLICO = 'search_path=public, pg_temp'
const PRODUZIONE: Record<string, { job: string; config: string; impronta: string; corpo: string }> = {
  candidature_retention_http: { job: 'candidature-retention', config: SP_PUBBLICO, impronta: 'c762e40438b84280e14924fcedd7aedd', corpo: 'b7491ac3bce08c20c207a2158460ca60' },
  cestino_registro_retention_http: { job: 'cestino-registro-retention', config: SP_PUBBLICO, impronta: 'bd84dced9db5ede86b8f9d2c06335290', corpo: '5d137079eabefed8f717ab1bd709bd1a' },
  fatture_coda_tick_http: { job: 'fatture-coda-tick', config: SP_PUBBLICO, impronta: '970a522c9b6c849e605d73f6e6f5c8e9', corpo: '592674f892575c13c40fb2cb6917852c' },
  fatture_sdi_sync_tick: { job: 'fatture-sdi-sync', config: SP_PUBBLICO, impronta: '8fe958ce0969e2537034cb8ba1f8e369', corpo: '1897a6782ef333ce2b1c8f9462840ed9' },
  galleria_retention_http: { job: 'galleria-retention', config: SP_PUBBLICO, impronta: 'cdc1ab1a9c2beca05e5229317eb6a0ad', corpo: '7de21f00e9d2ae256770701bd29f04ac' },
  iscrizioni_import_invio_http: { job: 'iscrizioni-import-invio', config: SP_PUBBLICO, impronta: '6d8ee4729625b9315ff16cb17fa3ebde', corpo: '1795a2ff1bb81657ebf8b6f64d053602' },
  iscrizioni_retention_http: { job: 'iscrizioni-retention', config: 'search_path=public', impronta: '514d45f2aad549ee0bc320b4d72c9d0e', corpo: '3e6ede9fa467cfb3f9771eb345777a6a' },
  mensa_check_allergie_giornaliero: { job: 'mensa-check-allergie', config: SP_PUBBLICO, impronta: 'b2168ad1b3891ff90b251c389e728bce', corpo: '173f6c012f0d3d9f72251b02aca0a485' },
  news_digest_tick: { job: 'news-digest', config: SP_PUBBLICO, impronta: '2620c0072b57dca04b1d60b742ad4ea3', corpo: 'd1516c87408a3edfb473bbf6632c5a11' },
  news_tick: { job: 'news-tick', config: SP_PUBBLICO, impronta: '3940b637ff299873a9fa249ff5f6c206', corpo: '8af5eb9e91272b8167b7019cce1a4584' },
  notifiche_dispatch_tick: { job: 'notifiche-dispatch', config: 'search_path=public', impronta: '84f5a89da79915366f1ae73df137bbe8', corpo: '5039e0c2c518706de6b7d126ec148a26' },
  notifiche_promemoria_tick: { job: 'notifiche-promemoria', config: 'search_path=public', impronta: 'a73d0acf63fcc851c9932ac1479cc391', corpo: 'e7aa90e4386b72978c348fd48a248299' },
  pagamenti_solleciti_tick: { job: 'pagamenti-solleciti-run', config: SP_PUBBLICO, impronta: 'b5211511af519bd945ab72279c545323', corpo: '6c846648c20e7453ed715044406bb3a8' },
  retention_personale_http: { job: 'retention-personale', config: SP_PUBBLICO, impronta: '3e63c9c0240de82276689c8979266f3b', corpo: 'c9eb1d182b598c8f5031e1ea54faf55f' },
  scadenze_documenti_personale_http: { job: 'scadenze-documenti-personale', config: SP_PUBBLICO, impronta: 'b15b474c4e961b6b94007069136ec75f', corpo: '305f82bfc966f80165a50a675827e4b4' },
  storici_tick: { job: 'storici-stampe', config: SP_PUBBLICO, impronta: '80e35f9040eeb5436d1b55527000754d', corpo: '45f88f222e83f9652a4e730b4f57cb76' },
  video_retention_http: { job: 'video-retention', config: SP_PUBBLICO, impronta: '75ba17f3ac9c2b10d1d60ec49175aba7', corpo: 'bd6a099ab16c9fc7945f909a3c52c505' },
  // Nessun job la chiama (la usa la route dei video): l'etichetta è il nome della funzione.
  video_runner_kick: { job: 'video-runner-kick', config: 'search_path=pg_catalog', impronta: 'de2f2674c90af030b446137b36d7a0c4', corpo: 'cd6d4e5844b239d407cb9f26802d0849' },
  video_runner_tick_http: { job: 'video-runner-tick', config: SP_PUBBLICO, impronta: 'dad54fbb12e54be5344898160c5e5b73', corpo: '37a5bd2f94bdbad8b0502c7b145588c6' },
}
/** Uguali per tutte e 19 in produzione: EXECUTE solo al proprietario e a service_role. */
const COMUNI_IN_PRODUZIONE = {
  proprietario: 'postgres', acl: '{postgres=X/postgres,service_role=X/postgres}', definer: true, volatilita: 'v',
  parallelo: 'u', strict: false, leakproof: false, costo: '100', righe: '0', linguaggio: 'plpgsql',
}

type Attributi = Record<string, unknown> & { nome: string; corpo: string }

/** Gli attributi di catalogo delle funzioni nominate, in ordine di nome. */
async function attributi(db: PGlite, nomi: string[]): Promise<Attributi[]> {
  return righe<Attributi>(db, `
    SELECT p.proname AS nome, pg_get_userbyid(p.proowner) AS proprietario, coalesce(p.proacl::text, '-') AS acl,
           p.prosecdef AS definer, coalesce(array_to_string(p.proconfig, ';'), '-') AS config,
           p.provolatile AS volatilita, p.proparallel AS parallelo, p.proisstrict AS strict, p.proleakproof AS leakproof,
           p.procost::text AS costo, p.prorows::text AS righe, l.lanname AS linguaggio,
           pg_get_function_identity_arguments(p.oid) AS argomenti, pg_get_function_result(p.oid) AS risultato,
           md5(p.prosrc) AS corpo
      FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace JOIN pg_language l ON l.oid = p.prolang
     WHERE s.nspname = 'public' AND p.proname = ANY (string_to_array($1, ','))
     ORDER BY p.proname COLLATE "C"`, [nomi.join(',')])
}

/** Gli attributi senza le chiavi nominate. */
const senza = (a: Attributi, ...chiavi: string[]) => Object.fromEntries(Object.entries(a).filter(([k]) => !chiavi.includes(k)))

/** Le definizioni di prima, coi permessi che hanno in produzione: il database come era prima del merge. */
async function comeInProduzione(db: PGlite, ridefinite: { nome: string; prima: string }[]): Promise<void> {
  await db.exec(ridefinite.map((r) => `${r.prima};`).join('\n\n'))
  await db.exec(`DO $$
    DECLARE f regprocedure;
    BEGIN
      FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace
                WHERE s.nspname = 'public' AND p.proname IN (${ridefinite.map((r) => `'${r.nome}'`).join(', ')}) LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', f);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
      END LOOP;
    END $$`)
}

type Effetti = { errore: string | null; chiamate: Record<string, unknown>[]; log: Record<string, unknown>[] }

/**
 * Cosa lascia una chiamata alla funzione: l'errore, le richieste a pg_net, le righe in app_log.
 * Un argomento uuid riceve un uuid di prova (con NULL video_runner_kick si ferma su BAD_INPUT),
 * gli altri NULL.
 */
async function effetti(db: PGlite, nome: string): Promise<Effetti> {
  await db.exec('DELETE FROM net.chiamate; DELETE FROM public.app_log;')
  const [{ tipi }] = await righe<{ tipi: string[] }>(db, `SELECT ARRAY(SELECT format_type(t, NULL) FROM unnest(p.proargtypes) AS t) AS tipi
      FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname = 'public' AND p.proname = $1`, [nome])
  const argomenti = tipi.map((t) => (t === 'uuid' ? `'00000000-0000-4000-8000-000000000006'::uuid` : 'NULL'))
  const errore = await erroreDi(db.query(`SELECT public.${nome}(${argomenti.join(', ')})`))
  return {
    errore: errore ? `${errore.code} ${errore.message}` : null,
    chiamate: await righe(db, 'SELECT url, body, params, headers, timeout_milliseconds FROM net.chiamate ORDER BY n'),
    log: await righe(db, `SELECT fingerprint, livello, evento, codice, messaggio, contesto
        FROM public.app_log ORDER BY fingerprint COLLATE "C"`),
  }
}

const PG_NET_SOLLEVA = `CREATE OR REPLACE FUNCTION net.http_post(
    url text, body jsonb DEFAULT '{}'::jsonb, params jsonb DEFAULT '{}'::jsonb,
    headers jsonb DEFAULT '{"Content-Type": "application/json"}'::jsonb, timeout_milliseconds integer DEFAULT 5000
  ) RETURNS bigint LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'coda piena' USING ERRCODE = '53400'; END $$`

describe('le funzioni ridefinite, confrontate con la produzione', () => {
  const RIDEFINITE = ridefinite()
  const NOMI = RIDEFINITE.map((r) => r.nome)

  it('sono esattamente le 19 della produzione, ciascuna con l’etichetta del suo job', () => {
    expect([...NOMI].sort()).toEqual(Object.keys(PRODUZIONE).sort())
    for (const r of RIDEFINITE) expect(r.job, r.nome).toBe(PRODUZIONE[r.nome].job)
  })

  it('svolta, ogni definizione è quella della produzione byte per byte (impronta 0.6), e il commento lo dichiara', () => {
    expect(NOMI).toHaveLength(Object.keys(PRODUZIONE).length)
    for (const r of RIDEFINITE) {
      // Il generatore toglie l'a capo finale di pg_get_functiondef prima del «;».
      expect(md5(`${r.prima}\n`), r.nome).toBe(PRODUZIONE[r.nome].impronta)
      expect(md5(corpoDi(r.prima).corpo), r.nome).toBe(PRODUZIONE[r.nome].corpo)
      expect(MIGRAZIONE, r.nome).toContain(
        `-- ${r.nome} · etichetta «${r.job}» · pg_get_functiondef, impronta ${PRODUZIONE[r.nome].impronta}\n`)
    }
  })

  it('sopra la produzione e in un database nuovo cambia solo il corpo: proprietario, permessi, SECURITY DEFINER, search_path, firma', async () => {
    const attese = NOMI.map((nome) => ({ nome, ...COMUNI_IN_PRODUZIONE, config: PRODUZIONE[nome].config }))
    const togli = (a: Attributi[]) => a.map((x) => senza(x, 'argomenti', 'risultato', 'corpo'))

    // Sopra la produzione: le definizioni di prima coi loro permessi, poi la migrazione.
    const db = await nuovoDatabase()
    await comeInProduzione(db, RIDEFINITE)
    const prima = await attributi(db, NOMI)
    expect(togli(prima)).toEqual(attese)
    expect(prima.map((a) => a.corpo)).toEqual(NOMI.map((nome) => PRODUZIONE[nome].corpo))
    await db.exec(MIGRAZIONE)
    const dopo = await attributi(db, NOMI)
    expect(dopo.map((x) => senza(x, 'corpo'))).toEqual(prima.map((x) => senza(x, 'corpo')))
    for (const [i, r] of RIDEFINITE.entries()) {
      expect(dopo[i].corpo, r.nome).toBe(md5(corpoDi(r.dopo).corpo))
      expect(dopo[i].corpo, r.nome).not.toBe(prima[i].corpo)
    }

    // Il database della CI: le funzioni nascono dalla migrazione, coi privilegi predefiniti del
    // baseline accesi. Devono nascere come sono in produzione, non aperte ai ruoli client.
    const nuovo = await nuovoDatabase()
    await nuovo.exec(MIGRAZIONE)
    expect(await attributi(nuovo, NOMI)).toEqual(dopo)
  })

  it('la migrazione inversa, sopra la produzione migrata, rimette corpi e permessi della produzione', async () => {
    const db = await nuovoDatabase({ cron: true })
    await comeInProduzione(db, RIDEFINITE)
    const prima = await attributi(db, NOMI)
    await db.exec(MIGRAZIONE)
    await db.exec(inversa(MIGRAZIONE))
    expect(await attributi(db, NOMI)).toEqual(prima)
    expect((await attributi(db, NOMI)).map((a) => a.corpo)).toEqual(NOMI.map((nome) => PRODUZIONE[nome].corpo))
  })

  it('ognuna chiama pg_net una volta, con gli stessi argomenti di prima, e la chiamata è registrata col job della produzione', { timeout: 120_000 }, async () => {
    const prima = await nuovoDatabase()
    await prima.exec(RIDEFINITE.map((r) => `${r.prima};`).join('\n\n'))
    const dopo = await nuovoDatabase()
    await dopo.exec(MIGRAZIONE)
    expect(NOMI).toHaveLength(Object.keys(PRODUZIONE).length)
    for (const r of RIDEFINITE) {
      const atteso = await effetti(prima, r.nome)
      expect(atteso.chiamate, `${r.nome}: il banco di prova non arriva a pg_net`).toHaveLength(1)
      expect(await effetti(dopo, r.nome), r.nome).toEqual(atteso)
      expect(await righe(dopo, `SELECT c.job, c.timeout_ms = n.timeout_milliseconds AS stesso_timeout
          FROM public.cron_chiamate c JOIN net.chiamate n ON n.n = c.richiesta_id`), r.nome)
        .toEqual([{ job: PRODUZIONE[r.nome].job, stesso_timeout: true }])
    }
  })

  it.each([
    ['pg_net solleva', PG_NET_SOLLEVA],
    ['il Vault è vuoto', 'DELETE FROM public.vault_finto'],
  ])('quando %s, ogni funzione si comporta come prima', { timeout: 120_000 }, async (_caso, guasto) => {
    const prima = await nuovoDatabase()
    await prima.exec(RIDEFINITE.map((r) => `${r.prima};`).join('\n\n'))
    const dopo = await nuovoDatabase()
    await dopo.exec(MIGRAZIONE)
    for (const db of [prima, dopo]) await db.exec(guasto)
    expect(NOMI).toHaveLength(Object.keys(PRODUZIONE).length)
    for (const r of RIDEFINITE) expect(await effetti(dopo, r.nome), r.nome).toEqual(await effetti(prima, r.nome))
    expect(await righe(dopo, 'SELECT count(*)::int AS n FROM public.cron_chiamate')).toEqual([{ n: 0 }])
  })

  it('se il registro non si scrive, la chiamata parte uguale e resta in più un solo error col nome del job', { timeout: 120_000 }, async () => {
    const prima = await nuovoDatabase()
    await prima.exec(RIDEFINITE.map((r) => `${r.prima};`).join('\n\n'))
    const dopo = await nuovoDatabase()
    await dopo.exec(MIGRAZIONE)
    await dopo.exec("ALTER TABLE public.cron_chiamate ADD CONSTRAINT guasto_di_prova CHECK (job = 'nessuno')")
    expect(NOMI).toHaveLength(Object.keys(PRODUZIONE).length)
    for (const r of RIDEFINITE) {
      const atteso = await effetti(prima, r.nome)
      const visto = await effetti(dopo, r.nome)
      expect(visto.chiamate, r.nome).toHaveLength(1)
      expect({ ...visto, log: visto.log.filter((l) => l.fingerprint !== 'cron-http:registro-non-scritto') }, r.nome)
        .toEqual(atteso)
      expect(await righe(dopo, `SELECT livello, codice, contesto->'campi'->>'job' AS job FROM public.app_log
          WHERE fingerprint = 'cron-http:registro-non-scritto'`), r.nome)
        .toEqual([{ livello: 'error', codice: '23514', job: PRODUZIONE[r.nome].job }])
    }
    expect(await righe(dopo, 'SELECT count(*)::int AS n FROM public.cron_chiamate')).toEqual([{ n: 0 }])
  })
})
