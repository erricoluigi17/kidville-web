// @vitest-environment node

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { senzaCommenti } from '../architecture/soglia-fotografia'

/**
 * IGIENE DEL DATABASE (sessione 8 della seconda serie di robustezza).
 *
 *  · T7: in `app_log` le righe `error` restano 90 giorni, `info` e `warn` 30 come prima.
 *  · `cron.job_run_details` tiene 14 giorni, ma solo per i job il cui ultimo giro è già al sicuro
 *    in `cron_ultimo_esito` (sessione 6), cioè con `ultimo_runid` valorizzato. Il lettore
 *    `cron_esiti()` lo valorizza solo dentro la sua finestra di 5000 esecuzioni: un mensile ha la
 *    riga ma `ultimo_runid` nullo finché non rigira, e non perde la sua ultima esecuzione.
 *  · `idle_in_transaction_session_timeout = 60s` su service_role, authenticated, anon; se chi
 *    applica la migrazione non può, una riga `error` in app_log e la migrazione prosegue.
 *
 * Il file della migrazione è LETTO DAL DISCO e applicato DUE volte. `cron` è uno schema finto con
 * le sole colonne che la funzione legge. Controllo negativo: la purge del 13/07 toglieva anche
 * l'errore di 31 giorni. Solo dati finti.
 */

const CARTELLA = join(process.cwd(), 'supabase/migrations')
function migrazione(suffisso: string): string {
  const f = readdirSync(CARTELLA).find((x) => x.endsWith(suffisso))
  if (!f) throw new Error(`migrazione *${suffisso} non trovata`)
  return readFileSync(join(CARTELLA, f), 'utf8')
}
const NUOVA = migrazione('_igiene_cron_log_ruoli.sql')

function bloccoTimeoutRuoli(): string {
  const inizio = NUOVA.indexOf('-- inizio: timeout-ruoli')
  const fine = NUOVA.indexOf('-- fine: timeout-ruoli')
  if (inizio < 0 || fine < 0) throw new Error('marcatori timeout-ruoli non trovati')
  return NUOVA.slice(inizio, fine)
}

function bloccoProgrammaJob(): string {
  const inizio = NUOVA.indexOf('-- inizio: programma-job')
  const fine = NUOVA.indexOf('-- fine: programma-job')
  if (inizio < 0 || fine < 0) throw new Error('marcatori programma-job non trovati')
  return NUOVA.slice(inizio, fine)
}

function purgeDel1307(): string {
  const testo = readFileSync(join(CARTELLA, '20260713090000_app_log.sql'), 'utf8')
  const inizio = testo.indexOf('CREATE OR REPLACE FUNCTION public.app_log_purge()')
  const fine = testo.indexOf('END $$;', inizio)
  if (inizio < 0 || fine < 0) throw new Error('app_log_purge del 13/07 non trovata')
  return testo.slice(inizio, fine + 'END $$;'.length)
}

const TRE_RUOLI = ['anon', 'authenticated', 'service_role']
let db: PGlite

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
    CREATE ROLE backup_lettura NOLOGIN;
    ALTER ROLE backup_lettura SET statement_timeout = '30min';
    ALTER ROLE backup_lettura SET idle_in_transaction_session_timeout = '30min';

    CREATE TABLE public.app_log (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      creato_il timestamptz NOT NULL DEFAULT now(),
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

    CREATE SCHEMA cron;
    -- Come in pg_cron, jobname può mancare: per la sessione 6 quel job si chiama 'jobid-<jobid>'.
    CREATE TABLE cron.job (jobid bigint PRIMARY KEY, jobname text);
    CREATE TABLE cron.job_run_details (
      runid bigserial PRIMARY KEY, jobid bigint NOT NULL, status text,
      start_time timestamptz, end_time timestamptz
    );
    -- Solo le due colonne di \`cron_ultimo_esito\` (sessione 6) che la funzione legge.
    CREATE TABLE public.cron_ultimo_esito (job text PRIMARY KEY, ultimo_runid bigint);
  `)
  await db.exec(NUOVA)
  await db.exec(NUOVA) // la seconda volta è la prova dell'idempotenza
})

afterAll(async () => {
  await db.close()
})

beforeEach(async () => {
  await db.exec(`
    DELETE FROM public.app_log;
    DELETE FROM cron.job_run_details;
    DELETE FROM cron.job;
    DELETE FROM public.cron_ultimo_esito;
  `)
})

async function riga(fingerprint: string, livello: string, giorniFa: number): Promise<void> {
  await db.query(
    `INSERT INTO public.app_log (creato_il, giorno, livello, evento, messaggio, fingerprint)
     VALUES (now() - make_interval(days => $3::int), (now() - make_interval(days => $3::int))::date,
             $2, 'prova', 'riga di prova', $1)`,
    [fingerprint, livello, giorniFa],
  )
}

async function campiDel(fingerprint: string) {
  return (await db.query<{ livello: string; occorrenze: number; campi: Record<string, unknown> }>(
    `SELECT livello, occorrenze, contesto->'campi' AS campi FROM public.app_log WHERE fingerprint = $1`,
    [fingerprint],
  )).rows
}

describe('T7 — app_log tiene gli errori 90 giorni', () => {
  it('error 90 giorni; info e warn 30 come prima; battito con i conteggi', async () => {
    await riga('info-29', 'info', 29)
    await riga('info-31', 'info', 31)
    await riga('warn-31', 'warn', 31)
    await riga('error-31', 'error', 31)
    await riga('error-89', 'error', 89)
    await riga('error-91', 'error', 91)
    const { rows } = await db.query<{ n: number }>('SELECT public.app_log_purge() AS n')
    expect(rows[0].n).toBe(3)
    const restano = (await db.query<{ fingerprint: string }>(
      `SELECT fingerprint FROM public.app_log WHERE evento = 'prova' ORDER BY 1`,
    )).rows.map((r) => r.fingerprint)
    expect(restano).toEqual(['error-31', 'error-89', 'info-29'])
    expect(await campiDel('cron:app-log-purge')).toEqual([{
      livello: 'info', occorrenze: 1,
      campi: { operazione: 'app-log-purge', esito: 'ok', n_righe: 3, n_errori: 1 },
    }])
  })

  it('due giri nello stesso giorno: una riga di battito con occorrenze 2', async () => {
    await db.query('SELECT public.app_log_purge()')
    await db.query('SELECT public.app_log_purge()')
    expect((await campiDel('cron:app-log-purge'))[0].occorrenze).toBe(2)
  })

  it('CONTROLLO NEGATIVO: la purge del 13/07 toglieva anche l’errore di 31 giorni', async () => {
    await riga('error-31', 'error', 31)
    await db.exec('BEGIN')
    try {
      await db.exec(purgeDel1307())
      await db.query('SELECT public.app_log_purge()')
      expect((await db.query(`SELECT 1 FROM public.app_log WHERE fingerprint = 'error-31'`)).rows).toEqual([])
    } finally {
      await db.exec('ROLLBACK')
    }
  })
})

describe('cron.job_run_details tiene 14 giorni', () => {
  it('cancella oltre i 14 giorni solo per i job con l’ultimo giro al sicuro, e per i job tolti', async () => {
    // 1: ultimo giro in cron_ultimo_esito (ultimo_runid) → si pulisce.
    // 2: riga in cron_ultimo_esito ma ultimo_runid nullo (il mensile fuori finestra) → si trattiene.
    // 3: nessuna riga in cron_ultimo_esito → si trattiene.
    // 99: job non più in cron.job → si pulisce.
    await db.exec(`
      INSERT INTO cron.job VALUES (1, 'storici-stampe'), (2, 'news-digest'), (3, 'iscrizioni-retention');
      INSERT INTO public.cron_ultimo_esito VALUES ('storici-stampe', 2), ('news-digest', NULL);
      INSERT INTO cron.job_run_details (jobid, status, start_time, end_time) VALUES
        (1,  'succeeded', now() - interval '20 days', now() - interval '20 days'),
        (1,  'succeeded', now() - interval '10 days', now() - interval '10 days'),
        (2,  'succeeded', now() - interval '20 days', now() - interval '20 days'),
        (3,  'succeeded', now() - interval '20 days', now() - interval '20 days'),
        (99, 'succeeded', now() - interval '20 days', now() - interval '20 days');
    `)
    const { rows } = await db.query<{ n: number }>('SELECT public.cron_storico_purge() AS n')
    expect(rows[0].n).toBe(2)
    const restano = (await db.query<{ jobid: number; giorni: number }>(
      `SELECT jobid::int AS jobid, extract(day FROM now() - start_time)::int AS giorni
         FROM cron.job_run_details ORDER BY 1, 2`,
    )).rows
    expect(restano).toEqual([{ jobid: 1, giorni: 10 }, { jobid: 2, giorni: 20 }, { jobid: 3, giorni: 20 }])
    expect(await campiDel('cron:cron-storico-purge')).toEqual([{
      livello: 'info', occorrenze: 1,
      campi: { operazione: 'cron-storico-purge', esito: 'ok', n_righe: 2, n_job_trattenuti: 2 },
    }])
  })

  it('un job senza nome è «jobid-N», la stessa chiave della sessione 6', async () => {
    // 4: senza nome, ultimo giro al sicuro come 'jobid-4' → si pulisce, e non è trattenuto.
    // 5: senza nome e senza riga → si trattiene.
    await db.exec(`
      INSERT INTO cron.job VALUES (4, NULL), (5, NULL);
      INSERT INTO public.cron_ultimo_esito VALUES ('jobid-4', 7);
      INSERT INTO cron.job_run_details (jobid, status, start_time, end_time) VALUES
        (4, 'succeeded', now() - interval '20 days', now() - interval '20 days'),
        (4, 'succeeded', now() - interval '2 days', now() - interval '2 days'),
        (5, 'succeeded', now() - interval '20 days', now() - interval '20 days');
    `)
    expect((await db.query<{ n: number }>('SELECT public.cron_storico_purge() AS n')).rows[0].n).toBe(1)
    const restano = (await db.query<{ jobid: number; giorni: number }>(
      `SELECT jobid::int AS jobid, extract(day FROM now() - start_time)::int AS giorni
         FROM cron.job_run_details ORDER BY 1, 2`,
    )).rows
    expect(restano).toEqual([{ jobid: 4, giorni: 2 }, { jobid: 5, giorni: 20 }])
    expect((await campiDel('cron:cron-storico-purge'))[0].campi).toMatchObject({ n_righe: 1, n_job_trattenuti: 1 })
  })

  it('senza cron_ultimo_esito non cancella niente, e lo dice a livello error', async () => {
    await db.exec(`
      INSERT INTO cron.job VALUES (1, 'storici-stampe');
      INSERT INTO cron.job_run_details (jobid, status, start_time, end_time)
        VALUES (1, 'succeeded', now() - interval '20 days', now() - interval '20 days');
    `)
    await db.exec('BEGIN')
    try {
      await db.exec('DROP TABLE public.cron_ultimo_esito')
      expect((await db.query<{ n: number }>('SELECT public.cron_storico_purge() AS n')).rows[0].n).toBe(0)
      expect((await db.query('SELECT 1 FROM cron.job_run_details')).rows).toHaveLength(1)
      expect((await campiDel('cron:cron-storico-purge:tabelle-assenti'))[0]).toMatchObject({
        livello: 'error', campi: { operazione: 'cron-storico-purge', esito: 'tabelle-assenti' },
      })
    } finally {
      await db.exec('ROLLBACK')
    }
  })
})

describe('il job cron-storico-purge', () => {
  const FINTO_UNSCHEDULE = `CREATE FUNCTION cron.unschedule(bigint) RETURNS boolean LANGUAGE sql
                              AS $f$ DELETE FROM cron.job WHERE jobid = $1 RETURNING true $f$;`

  it('se cron.schedule fallisce: una riga error in app_log, solo codici, e la migrazione prosegue', async () => {
    await db.exec('BEGIN')
    try {
      await db.exec(`${FINTO_UNSCHEDULE}
        CREATE FUNCTION cron.schedule(text, text, text) RETURNS bigint LANGUAGE plpgsql
          AS $f$ BEGIN RAISE EXCEPTION 'finto' USING ERRCODE = '42501'; END $f$;`)
      await db.exec(bloccoProgrammaJob())
      await db.exec(bloccoProgrammaJob())
      expect(await campiDel('migrazione:cron-storico-purge-non-programmato')).toEqual([{
        livello: 'error', occorrenze: 2,
        campi: { operazione: 'cron-storico-purge', esito: 'non-programmato', sqlstate: '42501' },
      }])
    } finally {
      await db.exec('ROLLBACK')
    }
  })

  it('con pg_cron si programma una volta sola, anche riapplicando, e senza righe error', async () => {
    await db.exec('BEGIN')
    try {
      await db.exec(`${FINTO_UNSCHEDULE}
        CREATE SEQUENCE cron.jobid_seq;
        CREATE TABLE cron.programmati (jobid bigint, cadenza text, comando text);
        CREATE FUNCTION cron.schedule(text, text, text) RETURNS bigint LANGUAGE sql AS $f$
          WITH n AS (SELECT nextval('cron.jobid_seq') AS id),
               p AS (INSERT INTO cron.programmati SELECT id, $2, $3 FROM n)
          INSERT INTO cron.job SELECT id, $1 FROM n RETURNING jobid $f$;`)
      await db.exec(bloccoProgrammaJob())
      await db.exec(bloccoProgrammaJob())
      expect((await db.query(`SELECT jobname FROM cron.job`)).rows).toEqual([{ jobname: 'cron-storico-purge' }])
      const { rows } = await db.query<{ cadenza: string; comando: string }>(
        `SELECT p.cadenza, trim(p.comando) AS comando FROM cron.programmati p JOIN cron.job j USING (jobid)`)
      expect(rows).toEqual([{ cadenza: '41 3 * * *', comando: 'SELECT public.cron_storico_purge();' }])
      expect(await campiDel('migrazione:cron-storico-purge-non-programmato')).toEqual([])
    } finally {
      await db.exec('ROLLBACK')
    }
  })

  it('senza pg_cron (il DB della CI): nessun job e nessuna riga error', async () => {
    await db.exec(bloccoProgrammaJob())
    expect((await db.query(`SELECT 1 FROM cron.job`)).rows).toEqual([])
    expect(await campiDel('migrazione:cron-storico-purge-non-programmato')).toEqual([])
  })
})

describe('idle_in_transaction_session_timeout sui tre ruoli dell’API', () => {
  async function config() {
    return (await db.query<{ rolname: string; rolconfig: string[] | null }>(
      `SELECT rolname, rolconfig FROM pg_roles
        WHERE rolname IN ('anon', 'authenticated', 'service_role', 'backup_lettura', current_user)
        ORDER BY 1`,
    )).rows
  }

  it('60 s sui tre ruoli; il ruolo del backup e chi applica la migrazione non si toccano', async () => {
    const righe = await config()
    for (const r of TRE_RUOLI) {
      expect(righe.find((x) => x.rolname === r)?.rolconfig).toEqual(['idle_in_transaction_session_timeout=60s'])
    }
    expect(righe.find((x) => x.rolname === 'backup_lettura')?.rolconfig)
      .toEqual(['statement_timeout=30min', 'idle_in_transaction_session_timeout=30min'])
    const io = (await db.query<{ u: string }>('SELECT current_user AS u')).rows[0].u
    expect(righe.find((x) => x.rolname === io)?.rolconfig ?? null).toBeNull()
  })

  it('se chi applica la migrazione non può (42501), lo scrive in app_log e prosegue', async () => {
    await db.exec(`
      ALTER ROLE anon RESET idle_in_transaction_session_timeout;
      ALTER ROLE authenticated RESET idle_in_transaction_session_timeout;
      ALTER ROLE service_role RESET idle_in_transaction_session_timeout;
      DROP ROLE IF EXISTS migratore_finto;
      CREATE ROLE migratore_finto NOLOGIN;
      GRANT USAGE ON SCHEMA public TO migratore_finto;
      GRANT SELECT, INSERT, UPDATE ON public.app_log TO migratore_finto;
    `)
    await db.exec('SET ROLE migratore_finto')
    try {
      await db.exec(bloccoTimeoutRuoli())
    } finally {
      await db.exec('RESET ROLE')
    }
    const righe = await config()
    for (const r of TRE_RUOLI) expect(righe.find((x) => x.rolname === r)?.rolconfig ?? null).toBeNull()
    const log = (await db.query<{ fingerprint: string; livello: string; sqlstate: string }>(
      `SELECT fingerprint, livello, contesto->'campi'->>'sqlstate' AS sqlstate FROM public.app_log
        WHERE fingerprint LIKE 'migrazione:idle-timeout-non-applicato:%' ORDER BY 1`,
    )).rows
    expect(log).toEqual(TRE_RUOLI.map((r) => ({
      fingerprint: `migrazione:idle-timeout-non-applicato:${r}`, livello: 'error', sqlstate: '42501',
    })))
    await db.exec(bloccoTimeoutRuoli()) // di nuovo come superuser: lo stato che il resto del file si aspetta
  })

  it('mai ALTER DATABASE, mai postgres né il ruolo del backup', () => {
    const istruzioni = senzaCommenti(NUOVA)
    expect(istruzioni).not.toMatch(/alter\s+database/i)
    expect(istruzioni).not.toMatch(/'postgres'|"postgres"|\bbackup_lettura\b/i)
    expect(istruzioni).toContain("ARRAY['service_role', 'authenticated', 'anon']")
  })
})
