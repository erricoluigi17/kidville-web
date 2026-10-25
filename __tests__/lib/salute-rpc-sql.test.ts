// @vitest-environment node

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { leggiRigheCronEsiti, valutaCronEsiti } from '@/lib/health/cron-esiti'

/**
 * LE DUE RPC DELLA SALUTE (sessione 7 della seconda serie) PROVATE SU UN POSTGRES VERO.
 *
 * `cron.job` e `supabase_migrations.schema_migrations` sono finte (PGlite non ha pg_cron) ma con le
 * colonne vere; `cron_ultimo_esito` NON è finta: il `CREATE TABLE` si prende dal file della
 * migrazione della sessione 6. Se la 6 cambia una colonna che la RPC legge, questo test diventa
 * rosso qui e non in produzione.
 */

const CARTELLA = join(process.cwd(), 'supabase/migrations')

function migrazione(suffisso: string): string {
    const file = readdirSync(CARTELLA).find((f) => f.endsWith(suffisso))
    if (!file) throw new Error(`migrazione *${suffisso} non trovata`)
    return readFileSync(join(CARTELLA, file), 'utf8')
}

const MIGRAZIONE = migrazione('_salute_rpc_sola_lettura.sql')

const TABELLA_DELLA_SESSIONE_6 = (() => {
    const m = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?public\.cron_ultimo_esito\s*\([\s\S]*?\n\);/i.exec(
        migrazione('_cron_esiti_osservati.sql'),
    )
    if (!m) throw new Error('CREATE TABLE public.cron_ultimo_esito non trovato nella migrazione della sessione 6')
    return m[0]
})()

const RUOLI = `
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN BYPASSRLS;
`

async function codiceErrore(db: PGlite, sql: string): Promise<string | null> {
    try {
        await db.exec(sql)
        return null
    } catch (e) {
        return (e as { code?: string }).code ?? 'errore'
    }
}

let db: PGlite

beforeAll(async () => {
    db = new PGlite()
    await db.exec(RUOLI)
    await db.exec(`
      CREATE SCHEMA cron;
      CREATE TABLE cron.job (
        jobid    bigserial PRIMARY KEY,
        schedule text NOT NULL,
        command  text NOT NULL,
        jobname  text,
        active   boolean NOT NULL DEFAULT true
      );
      CREATE SCHEMA supabase_migrations;
      CREATE TABLE supabase_migrations.schema_migrations (version text NOT NULL, name text);
    `)
    await db.exec(TABELLA_DELLA_SESSIONE_6)
    await db.exec(MIGRAZIONE)
    await db.exec(MIGRAZIONE) // la seconda volta è la prova dell'idempotenza
    await db.exec(`
      INSERT INTO cron.job (jobid, schedule, command, jobname, active) VALUES
        (1, '*/10 * * * *', 'select 1', 'job-ok-http', true),
        (2, '*/10 * * * *', 'select 1', 'job-500', true),
        (3, '*/10 * * * *', 'select 1', 'job-rete', true),
        (4, '*/10 * * * *', 'select 1', 'job-timeout', true),
        (5, '*/10 * * * *', 'select 1', 'job-attesa', true),
        (6, '0 6 * * *', 'select 1', 'job-sql-ok', true),
        (7, '0 6 * * *', 'select 1', 'job-sql-ko', true),
        (8, '0 6 * * *', 'select 1', 'job-nuovo', true),
        (9, '0 6 * * *', 'select 1', 'job-spento', false),
        (99, '35 4 1 * *', 'select 1', NULL, true);
      INSERT INTO public.cron_ultimo_esito
        (job, http, ultima_chiamata_il, ultima_chiamata_esito, ultima_esecuzione_il, ultima_esecuzione_stato, ultimo_ok_il)
      VALUES
        ('job-ok-http', true,  '2026-10-20 09:55+00', 'ok',          '2026-10-20 09:55+00', 'succeeded', '2026-10-20 09:55+00'),
        ('job-500',     true,  '2026-10-20 09:57+00', 'errore-http', '2026-10-20 09:57+00', 'succeeded', '2026-10-20 09:20+00'),
        ('job-rete',    true,  '2026-10-20 09:56+00', 'errore-rete', '2026-10-20 09:56+00', 'succeeded', NULL),
        ('job-timeout', true,  '2026-10-20 09:58+00', 'timeout',     '2026-10-20 09:58+00', 'succeeded', '2026-10-20 08:20+00'),
        ('job-attesa',  true,  '2026-10-20 09:59+00', 'in-attesa',   '2026-10-20 09:59+00', 'succeeded', '2026-10-20 09:49+00'),
        ('job-sql-ok',  false, NULL, NULL, '2026-10-20 06:00+00', 'succeeded', '2026-10-20 06:00+00'),
        ('job-sql-ko',  false, NULL, NULL, '2026-10-20 06:00+00', 'failed',    '2026-10-19 06:00+00'),
        ('job-spento',  false, NULL, NULL, '2026-10-20 06:00+00', 'succeeded', '2026-10-20 06:00+00'),
        ('jobid-99',    false, NULL, NULL, '2026-10-01 04:35+00', 'succeeded', '2026-10-01 04:35+00');
    `)
})

afterAll(async () => {
    await db.close()
})

describe('salute_cron_esiti', () => {
    it('un job attivo per riga, con la chiave della sessione 6; per un job HTTP conta la chiamata, per uno SQL il giro', async () => {
        const { rows } = await db.query(`
          SELECT job, cadenza, esito,
                 to_char(visto_il AT TIME ZONE 'UTC', 'MM-DD HH24:MI') AS visto,
                 to_char(vivo_il  AT TIME ZONE 'UTC', 'MM-DD HH24:MI') AS vivo
            FROM public.salute_cron_esiti()
           ORDER BY job COLLATE "C"`)
        expect(rows).toEqual([
            { job: 'job-500', cadenza: '*/10 * * * *', esito: 'fallito', visto: '10-20 09:57', vivo: '10-20 09:20' },
            // La chiamata delle 09:59 non ha ancora un esito, ma la funzione SQL che l'ha mandata è riuscita: vivo.
            { job: 'job-attesa', cadenza: '*/10 * * * *', esito: null, visto: '10-20 09:59', vivo: '10-20 09:59' },
            { job: 'job-nuovo', cadenza: '0 6 * * *', esito: null, visto: null, vivo: null },
            { job: 'job-ok-http', cadenza: '*/10 * * * *', esito: 'ok', visto: '10-20 09:55', vivo: '10-20 09:55' },
            { job: 'job-rete', cadenza: '*/10 * * * *', esito: 'fallito', visto: '10-20 09:56', vivo: null },
            { job: 'job-sql-ko', cadenza: '0 6 * * *', esito: 'fallito', visto: '10-20 06:00', vivo: '10-19 06:00' },
            { job: 'job-sql-ok', cadenza: '0 6 * * *', esito: 'ok', visto: '10-20 06:00', vivo: '10-20 06:00' },
            { job: 'job-timeout', cadenza: '*/10 * * * *', esito: 'timeout', visto: '10-20 09:58', vivo: '10-20 09:58' },
            { job: 'jobid-99', cadenza: '35 4 1 * *', esito: 'ok', visto: '10-01 04:35', vivo: '10-01 04:35' },
        ])
    })

    it('il timeout del client è vivo anche quando il giro SQL dopo è fallito (nel banco sopra lo copre l’esecuzione riuscita)', async () => {
        const b = new PGlite()
        await b.exec(RUOLI)
        await b.exec(`
          CREATE SCHEMA cron;
          CREATE TABLE cron.job (jobid bigserial PRIMARY KEY, schedule text NOT NULL, command text NOT NULL, jobname text, active boolean NOT NULL DEFAULT true);
        `)
        await b.exec(TABELLA_DELLA_SESSIONE_6)
        await b.exec(MIGRAZIONE)
        await b.exec(`
          INSERT INTO cron.job (jobid, schedule, command, jobname, active) VALUES (1, '*/10 * * * *', 'select 1', 'job-timeout', true);
          INSERT INTO public.cron_ultimo_esito
            (job, http, ultima_chiamata_il, ultima_chiamata_esito, ultima_esecuzione_il, ultima_esecuzione_stato, ultimo_ok_il)
          VALUES ('job-timeout', true, '2026-10-20 09:58+00', 'timeout', '2026-10-20 09:59+00', 'failed', '2026-10-20 08:20+00');
        `)
        const { rows } = await b.query(`
          SELECT job, esito,
                 to_char(visto_il AT TIME ZONE 'UTC', 'MM-DD HH24:MI') AS visto,
                 to_char(vivo_il  AT TIME ZONE 'UTC', 'MM-DD HH24:MI') AS vivo
            FROM public.salute_cron_esiti()`)
        expect(rows).toEqual([{ job: 'job-timeout', esito: 'timeout', visto: '10-20 09:58', vivo: '10-20 09:58' }])
        await b.close()
    })
})

describe('vivo_il di un job HTTP che chiama solo quando ha lavoro', () => {
    // Dopo la sessione 8 `storici_tick` (job `storici-stampe`, ogni minuto) chiama
    // /api/admin/storici/cron solo se c'è una stampa in coda: con la coda vuota la funzione SQL gira
    // e riesce, e nessuna chiamata parte. Per la sessione 6 `ultimo_ok_il` di un job HTTP cambia solo
    // con le chiamate, e `http` non torna mai false: senza l'ultima esecuzione SQL riuscita in
    // `vivo_il`, due ore di coda vuota sarebbero un allarme. `cron-esiti` (sola SQL, 09:54) è il
    // testimone della freschezza: senza, la salute direbbe «cron-esiti fermo» per la ragione sbagliata.
    const ADESSO = Date.parse('2026-10-20T10:00:00Z')

    async function banco(ultimaChiamataEsito: 'ok' | 'errore-http' | 'timeout'): Promise<PGlite> {
        const b = new PGlite()
        await b.exec(RUOLI)
        await b.exec(`
          CREATE SCHEMA cron;
          CREATE TABLE cron.job (
            jobid    bigserial PRIMARY KEY,
            schedule text NOT NULL,
            command  text NOT NULL,
            jobname  text,
            active   boolean NOT NULL DEFAULT true
          );
        `)
        await b.exec(TABELLA_DELLA_SESSIONE_6)
        await b.exec(MIGRAZIONE)
        await b.exec(`
          INSERT INTO cron.job (jobid, schedule, command, jobname, active) VALUES
            (1, '* * * * *', 'select 1', 'storici-stampe', true),
            (2, '4,14,24,34,44,54 * * * *', 'select 1', 'cron-esiti', true);
        `)
        await b.query(
            `INSERT INTO public.cron_ultimo_esito
               (job, http, ultima_chiamata_il, ultima_chiamata_esito, ultima_esecuzione_il, ultima_esecuzione_stato, ultimo_ok_il)
             VALUES
               ('storici-stampe', true, '2026-10-20 07:58+00', $1, '2026-10-20 09:59+00', 'succeeded', '2026-10-20 07:50+00'),
               ('cron-esiti', false, NULL, NULL, '2026-10-20 09:54+00', 'succeeded', '2026-10-20 09:54+00')`,
            [ultimaChiamataEsito],
        )
        return b
    }

    /** La riga di `storici-stampe` come la leggono le persone: minuti UTC. */
    async function storici(b: PGlite): Promise<unknown[]> {
        const { rows } = await b.query(`
          SELECT job, esito,
                 to_char(visto_il AT TIME ZONE 'UTC', 'MM-DD HH24:MI') AS visto,
                 to_char(vivo_il  AT TIME ZONE 'UTC', 'MM-DD HH24:MI') AS vivo
            FROM public.salute_cron_esiti() WHERE job = 'storici-stampe'`)
        return rows
    }

    /** Le righe come le porta PostgREST (istanti in testo ISO), passate alla decisione vera. */
    async function decisione(b: PGlite) {
        const { rows } = await b.query(`
          SELECT job, cadenza, esito,
                 to_json(visto_il) #>> '{}' AS visto_il,
                 to_json(vivo_il)  #>> '{}' AS vivo_il
            FROM public.salute_cron_esiti()
           ORDER BY job COLLATE "C"`)
        const righe = leggiRigheCronEsiti(rows)
        expect(righe).not.toBeNull()
        return valutaCronEsiti(righe ?? [], ADESSO)
    }

    it('coda vuota da due ore, la funzione SQL riesce ogni minuto: vivo all’ultima esecuzione, e la salute dice ok', async () => {
        const b = await banco('ok')
        expect(await storici(b)).toEqual([{ job: 'storici-stampe', esito: 'ok', visto: '10-20 07:58', vivo: '10-20 09:59' }])
        expect(await decisione(b)).toEqual({ esito: 'ok', dettaglio: '2 job attivi' })
        await b.close()
    })

    it('l’ultima chiamata è stata respinta (errore-http): le esecuzioni SQL riuscite non la coprono, e la salute dice degradato', async () => {
        const b = await banco('errore-http')
        expect(await storici(b)).toEqual([{ job: 'storici-stampe', esito: 'fallito', visto: '10-20 07:58', vivo: '10-20 07:50' }])
        expect(await decisione(b)).toEqual({
            esito: 'degradato',
            dettaglio: '2 job attivi; senza un esito buono entro la finestra: storici-stampe',
        })
        await b.close()
    })

    it('un timeout del client resta vivo, come vuole la regola del modulo: le esecuzioni SQL riuscite dopo lo coprono', async () => {
        const b = await banco('timeout')
        expect(await storici(b)).toEqual([{ job: 'storici-stampe', esito: 'timeout', visto: '10-20 07:58', vivo: '10-20 09:59' }])
        expect(await decisione(b)).toEqual({ esito: 'ok', dettaglio: '2 job attivi; timeout del client, vivi: storici-stampe' })
        await b.close()
    })
})

describe('i job che il lettore della sessione 6 non ha mai visto girare', () => {
    // Misura del 25/10 (Passo 0, sola lettura): 8 righe di cron_ultimo_esito hanno
    // ultima_esecuzione_stato nullo perché cron_esiti() legge solo le ultime 5.000 esecuzioni e non vi
    // trova una corsa chiusa: i mensili (che girano il 1° del mese), app-log-bonifica-pii (il lunedì),
    // cron-esiti appena installato, il job spento. La riga c'è (passo 4 della 6: una per job di
    // cron.job), con tutte le date nulle. Non è un guasto: devono uscire «in attesa», mai «fallito».
    const ADESSO = Date.parse('2026-10-25T13:00:00Z')

    it('riga presente con le date nulle: esito nullo, nessuna data, e la decisione dice ok «in attesa»', async () => {
        const b = new PGlite()
        await b.exec(RUOLI)
        await b.exec(`
          CREATE SCHEMA cron;
          CREATE TABLE cron.job (
            jobid    bigserial PRIMARY KEY,
            schedule text NOT NULL,
            command  text NOT NULL,
            jobname  text,
            active   boolean NOT NULL DEFAULT true
          );
        `)
        await b.exec(TABELLA_DELLA_SESSIONE_6)
        await b.exec(MIGRAZIONE)
        await b.exec(`
          INSERT INTO cron.job (jobid, schedule, command, jobname, active) VALUES
            (1, '4,14,24,34,44,54 * * * *', 'select 1', 'cron-esiti', true),
            (2, '35 4 1 * *', 'select 1', 'notifiche-retention', true),
            (3, '11 5 * * 1', 'select 1', 'app-log-bonifica-pii', true),
            (4, '0 8 1 * *', 'select 1', 'news-digest', false);
          INSERT INTO public.cron_ultimo_esito (job, attivo, pianificazione, http, ultima_esecuzione_il, ultima_esecuzione_stato, ultimo_ok_il) VALUES
            ('cron-esiti', true, '4,14,24,34,44,54 * * * *', false, '2026-10-25 12:54+00', 'succeeded', '2026-10-25 12:54+00'),
            ('notifiche-retention', true, '35 4 1 * *', false, NULL, NULL, NULL),
            ('app-log-bonifica-pii', true, '11 5 * * 1', false, NULL, NULL, NULL),
            ('news-digest', false, '0 8 1 * *', false, NULL, NULL, NULL);
        `)
        const { rows } = await b.query(`
          SELECT job, cadenza, esito,
                 to_json(visto_il) #>> '{}' AS visto_il,
                 to_json(vivo_il)  #>> '{}' AS vivo_il
            FROM public.salute_cron_esiti()
           ORDER BY job COLLATE "C"`)
        expect(rows.filter((r) => (r as { job: string }).job !== 'cron-esiti')).toEqual([
            { job: 'app-log-bonifica-pii', cadenza: '11 5 * * 1', esito: null, visto_il: null, vivo_il: null },
            { job: 'notifiche-retention', cadenza: '35 4 1 * *', esito: null, visto_il: null, vivo_il: null },
        ])
        const righe = leggiRigheCronEsiti(rows)
        expect(righe).not.toBeNull()
        expect(valutaCronEsiti(righe ?? [], ADESSO)).toEqual({
            esito: 'ok',
            dettaglio: '3 job attivi; in attesa del primo esito: app-log-bonifica-pii,notifiche-retention',
        })
        await b.close()
    })
})

describe('salute_migrazioni', () => {
    it('la versione più alta e il numero delle righe; una riga doppia cambia il numero, non la versione', async () => {
        await db.exec(`INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES
          ('20261001000000', 'a'), ('20261020000000', 'c'), ('20261010000000', 'b')`)
        expect((await db.query('SELECT * FROM public.salute_migrazioni()')).rows).toEqual([
            { ultima: '20261020000000', numero: 3 },
        ])

        await db.exec(`INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('20261010000000', 'b')`)
        expect((await db.query('SELECT * FROM public.salute_migrazioni()')).rows).toEqual([
            { ultima: '20261020000000', numero: 4 },
        ])
    })
})

describe('le due funzioni', () => {
    it('le chiama solo service_role', async () => {
        const { rows } = await db.query(`
          SELECT r AS ruolo,
                 has_function_privilege(r, 'public.salute_cron_esiti()', 'EXECUTE') AS cron,
                 has_function_privilege(r, 'public.salute_migrazioni()', 'EXECUTE') AS migrazioni
            FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r
           ORDER BY r`)
        expect(rows).toEqual([
            { ruolo: 'anon', cron: false, migrazioni: false },
            { ruolo: 'authenticated', cron: false, migrazioni: false },
            { ruolo: 'service_role', cron: true, migrazioni: true },
        ])
    })

    it('SECURITY DEFINER, STABLE, con search_path vuoto', async () => {
        const { rows } = await db.query<{ proname: string; prosecdef: boolean; provolatile: string; proconfig: string[] | null }>(`
          SELECT proname, prosecdef, provolatile, proconfig
            FROM pg_proc WHERE proname IN ('salute_cron_esiti', 'salute_migrazioni') ORDER BY proname`)
        expect(rows.map((r) => [r.proname, r.prosecdef, r.provolatile])).toEqual([
            ['salute_cron_esiti', true, 's'],
            ['salute_migrazioni', true, 's'],
        ])
        for (const r of rows) expect(r.proconfig?.[0]).toMatch(/^search_path=(""|)$/)
    })

    it('senza le tabelle di pg_cron e di supabase_migrations la migrazione si applica e la chiamata alza P0001', async () => {
        // È il database della CI: la migrazione deve passare, e la salute deve vedere il guasto.
        const vuoto = new PGlite()
        await vuoto.exec(RUOLI)
        await vuoto.exec(MIGRAZIONE)
        expect(await codiceErrore(vuoto, 'SELECT * FROM public.salute_cron_esiti()')).toBe('P0001')
        expect(await codiceErrore(vuoto, 'SELECT * FROM public.salute_migrazioni()')).toBe('P0001')
        await vuoto.close()
    })

    it('con pg_cron ma senza cron_ultimo_esito (la sessione 6 non applicata) la chiamata alza P0001, non 42P01', async () => {
        const mezzo = new PGlite()
        await mezzo.exec(RUOLI)
        await mezzo.exec(`
          CREATE SCHEMA cron;
          CREATE TABLE cron.job (jobid bigserial PRIMARY KEY, schedule text NOT NULL, command text NOT NULL, jobname text, active boolean NOT NULL DEFAULT true);
          INSERT INTO cron.job (schedule, command, jobname) VALUES ('*/10 * * * *', 'select 1', 'job-qualsiasi');
        `)
        await mezzo.exec(MIGRAZIONE)
        expect(await codiceErrore(mezzo, 'SELECT * FROM public.salute_cron_esiti()')).toBe('P0001')
        await mezzo.close()
    })
})
