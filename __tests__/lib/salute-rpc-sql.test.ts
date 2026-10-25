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
 * colonne vere; `cron_ultimo_esito` e `cron_chiamate` NON sono finte: i due `CREATE TABLE` si
 * prendono dal file della migrazione della sessione 6. Se la 6 cambia una colonna che la RPC legge,
 * questo test diventa rosso qui e non in produzione. Gli esiti delle chiamate sono quelli che la 6
 * scrive davvero: 'ok', 'errore-http', 'errore-rete', 'timeout', 'esito-ignoto', o nessuno.
 *
 * I PRIVILEGI: qui i ruoli nascono senza i privilegi predefiniti di Supabase (dove una funzione nuova
 * di `postgres` in `public` è eseguibile da anon e authenticated finché non si revoca), quindi il
 * test dei permessi prova la forma, non la revoca contro quei default. La revoca contro i default
 * veri è provata a parte su un Postgres 17 locale (rapporto della sessione 7, nessun file nel repo).
 */

const CARTELLA = join(process.cwd(), 'supabase/migrations')

function migrazione(suffisso: string): string {
    const file = readdirSync(CARTELLA).find((f) => f.endsWith(suffisso))
    if (!file) throw new Error(`migrazione *${suffisso} non trovata`)
    return readFileSync(join(CARTELLA, file), 'utf8')
}

const MIGRAZIONE = migrazione('_salute_rpc_sola_lettura.sql')

function tabellaDellaSessione6(tabella: 'cron_ultimo_esito' | 'cron_chiamate'): string {
    const re = new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?public\\.${tabella}\\s*\\([\\s\\S]*?\\n\\);`, 'i')
    const m = re.exec(migrazione('_cron_esiti_osservati.sql'))
    if (!m) throw new Error(`CREATE TABLE public.${tabella} non trovato nella migrazione della sessione 6`)
    return m[0]
}

const TABELLA_ESITI = tabellaDellaSessione6('cron_ultimo_esito')
const TABELLA_CHIAMATE = tabellaDellaSessione6('cron_chiamate')

const RUOLI = `
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN BYPASSRLS;
`

const CRON_JOB = `
  CREATE SCHEMA cron;
  CREATE TABLE cron.job (
    jobid    bigserial PRIMARY KEY,
    schedule text NOT NULL,
    command  text NOT NULL,
    jobname  text,
    active   boolean NOT NULL DEFAULT true
  );
`

// Come in Supabase: `version` è la chiave, quindi una migrazione applicata due volte a mano lascia
// due righe con version DIVERSE (quella del file e l'orario del secondo giro) e lo stesso nome.
const SCHEMA_MIGRAZIONI = `
  CREATE SCHEMA supabase_migrations;
  CREATE TABLE supabase_migrations.schema_migrations (version text PRIMARY KEY, name text);
`

/** Un database con le parti richieste, e la migrazione applicata. */
async function nuovoDb(parti: { cron?: boolean; esiti?: boolean; chiamate?: boolean; migrazioni?: boolean } = {}): Promise<PGlite> {
    const b = new PGlite()
    await b.exec(RUOLI)
    if (parti.cron ?? true) await b.exec(CRON_JOB)
    if (parti.esiti ?? true) await b.exec(TABELLA_ESITI)
    if (parti.chiamate ?? true) await b.exec(TABELLA_CHIAMATE)
    if (parti.migrazioni ?? false) await b.exec(SCHEMA_MIGRAZIONI)
    await b.exec(MIGRAZIONE)
    return b
}

async function codiceErrore(db: PGlite, sql: string): Promise<string | null> {
    try {
        await db.exec(sql)
        return null
    } catch (e) {
        return (e as { code?: string }).code ?? 'errore'
    }
}

/** Le righe come le leggono le persone: minuti UTC. */
async function righeLeggibili(b: PGlite): Promise<unknown[]> {
    const { rows } = await b.query(`
      SELECT job, cadenza, esito,
             to_char(visto_il AT TIME ZONE 'UTC', 'MM-DD HH24:MI') AS visto,
             to_char(vivo_il  AT TIME ZONE 'UTC', 'MM-DD HH24:MI') AS vivo
        FROM public.salute_cron_esiti()
       ORDER BY job COLLATE "C"`)
    return rows
}

/** Le righe come le porta PostgREST (istanti in testo ISO), passate alla decisione vera. */
async function decisione(b: PGlite, adesso: number) {
    const { rows } = await b.query(`
      SELECT job, cadenza, esito,
             to_json(visto_il) #>> '{}' AS visto_il,
             to_json(vivo_il)  #>> '{}' AS vivo_il
        FROM public.salute_cron_esiti()
       ORDER BY job COLLATE "C"`)
    const righe = leggiRigheCronEsiti(rows)
    expect(righe).not.toBeNull()
    return valutaCronEsiti(righe ?? [], adesso)
}

let db: PGlite

beforeAll(async () => {
    db = new PGlite()
    await db.exec(RUOLI)
    await db.exec(CRON_JOB)
    await db.exec(SCHEMA_MIGRAZIONI)
    await db.exec(TABELLA_ESITI)
    await db.exec(TABELLA_CHIAMATE)
    await db.exec(MIGRAZIONE)
    await db.exec(MIGRAZIONE) // la seconda volta è la prova dell'idempotenza
    await db.exec(`
      INSERT INTO cron.job (jobid, schedule, command, jobname, active) VALUES
        (1, '*/10 * * * *', 'select 1', 'job-ok-http', true),
        (2, '*/10 * * * *', 'select 1', 'job-500', true),
        (3, '*/10 * * * *', 'select 1', 'job-rete', true),
        (4, '*/10 * * * *', 'select 1', 'job-timeout', true),
        (5, '*/10 * * * *', 'select 1', 'job-ignoto', true),
        (6, '0 6 * * *', 'select 1', 'job-sql-ok', true),
        (7, '0 6 * * *', 'select 1', 'job-sql-ko', true),
        (8, '0 6 * * *', 'select 1', 'job-nuovo', true),
        (9, '0 6 * * *', 'select 1', 'job-spento', false),
        (10, '*/10 * * * *', 'select 1', 'job-http-nullo', true),
        (11, '*/10 * * * *', 'select 1', 'job-pgnet-fermo', true),
        (12, '*/10 * * * *', 'select 1', 'job-aperta-recente', true),
        (99, '35 4 1 * *', 'select 1', NULL, true);
      INSERT INTO public.cron_ultimo_esito
        (job, http, ultima_chiamata_il, ultima_chiamata_esito, ultima_esecuzione_il, ultima_esecuzione_stato, ultimo_ok_il)
      VALUES
        ('job-ok-http',        true,  '2026-10-20 09:55+00', 'ok',           '2026-10-20 09:55+00', 'succeeded', '2026-10-20 09:55+00'),
        ('job-500',            true,  '2026-10-20 09:57+00', 'errore-http',  '2026-10-20 09:57+00', 'succeeded', '2026-10-20 09:20+00'),
        ('job-rete',           true,  '2026-10-20 09:56+00', 'errore-rete',  '2026-10-20 09:56+00', 'succeeded', NULL),
        ('job-timeout',        true,  '2026-10-20 09:58+00', 'timeout',      '2026-10-20 09:58+00', 'succeeded', '2026-10-20 08:20+00'),
        ('job-ignoto',         true,  '2026-10-20 09:59+00', 'esito-ignoto', '2026-10-20 09:59+00', 'succeeded', '2026-10-20 09:49+00'),
        ('job-sql-ok',         false, NULL, NULL, '2026-10-20 06:00+00', 'succeeded', '2026-10-20 06:00+00'),
        ('job-sql-ko',         false, NULL, NULL, '2026-10-20 06:00+00', 'failed',    '2026-10-19 06:00+00'),
        ('job-spento',         false, NULL, NULL, '2026-10-20 06:00+00', 'succeeded', '2026-10-20 06:00+00'),
        ('job-http-nullo',     true,  NULL, NULL, '2026-10-20 09:59+00', 'succeeded', NULL),
        ('job-pgnet-fermo',    true,  '2026-10-20 07:00+00', 'ok',           '2026-10-20 09:59+00', 'succeeded', '2026-10-20 07:00+00'),
        ('job-aperta-recente', true,  '2026-10-20 09:50+00', 'ok',           '2026-10-20 09:59+00', 'succeeded', '2026-10-20 09:50+00'),
        ('jobid-99',           false, NULL, NULL, '2026-10-01 04:35+00', 'succeeded', '2026-10-01 04:35+00');
      -- Le chiamate di cron_chiamate. Aperta = verificata_il nullo. Le età sono rispetto a now(): la
      -- guardia della RPC le misura così, e i 30 minuti stanno fra 20 e 40.
      INSERT INTO public.cron_chiamate (job, richiesta_id, percorso, timeout_ms, inviata_il, esito, verificata_il) VALUES
        ('job-pgnet-fermo',    11, '/api/x', 5000, now() - interval '40 minutes', 'in-attesa', NULL),
        ('job-pgnet-fermo',    12, '/api/x', 5000, now() - interval '20 minutes', 'in-attesa', NULL),
        ('job-aperta-recente', 20, '/api/y', 5000, '2026-10-20 09:50+00',         'ok',        '2026-10-20 09:54+00'),
        ('job-aperta-recente', 21, '/api/y', 5000, now() - interval '20 minutes', 'in-attesa', NULL);
    `)
})

afterAll(async () => {
    await db.close()
})

describe('salute_cron_esiti', () => {
    it('un job attivo per riga, con la chiave della sessione 6; per un job HTTP conta la chiamata, per uno SQL il giro', async () => {
        expect(await righeLeggibili(db)).toEqual([
            { job: 'job-500', cadenza: '*/10 * * * *', esito: 'fallito', visto: '10-20 09:57', vivo: '10-20 09:20' },
            // Una chiamata aperta da 20 minuti è ancora normale: l'esecuzione SQL riuscita delle 09:59 conta.
            { job: 'job-aperta-recente', cadenza: '*/10 * * * *', esito: 'ok', visto: '10-20 09:50', vivo: '10-20 09:59' },
            // `http` vero ma nessuna chiamata chiusa: il giro visto è l'esecuzione SQL, ed è viva.
            { job: 'job-http-nullo', cadenza: '*/10 * * * *', esito: null, visto: '10-20 09:59', vivo: '10-20 09:59' },
            // Esito ignoto (pg_net ha dimenticato la risposta): l'esecuzione SQL riuscita NON la copre.
            { job: 'job-ignoto', cadenza: '*/10 * * * *', esito: null, visto: '10-20 09:59', vivo: '10-20 09:49' },
            { job: 'job-nuovo', cadenza: '0 6 * * *', esito: null, visto: null, vivo: null },
            { job: 'job-ok-http', cadenza: '*/10 * * * *', esito: 'ok', visto: '10-20 09:55', vivo: '10-20 09:55' },
            // pg_net fermo: una chiamata aperta da 40 minuti, l'ultima chiusa ok alle 07:00. Le esecuzioni
            // SQL riuscite non contano: vivo resta l'ultimo ok.
            { job: 'job-pgnet-fermo', cadenza: '*/10 * * * *', esito: 'ok', visto: '10-20 07:00', vivo: '10-20 07:00' },
            { job: 'job-rete', cadenza: '*/10 * * * *', esito: 'fallito', visto: '10-20 09:56', vivo: null },
            { job: 'job-sql-ko', cadenza: '0 6 * * *', esito: 'fallito', visto: '10-20 06:00', vivo: '10-19 06:00' },
            { job: 'job-sql-ok', cadenza: '0 6 * * *', esito: 'ok', visto: '10-20 06:00', vivo: '10-20 06:00' },
            { job: 'job-timeout', cadenza: '*/10 * * * *', esito: 'timeout', visto: '10-20 09:58', vivo: '10-20 09:58' },
            { job: 'jobid-99', cadenza: '35 4 1 * *', esito: 'ok', visto: '10-01 04:35', vivo: '10-01 04:35' },
        ])
    })

    it('il timeout del client è vivo anche quando il giro SQL dopo è fallito (nel banco sopra lo copre l’esecuzione riuscita)', async () => {
        const b = await nuovoDb()
        await b.exec(`
          INSERT INTO cron.job (jobid, schedule, command, jobname, active) VALUES (1, '*/10 * * * *', 'select 1', 'job-timeout', true);
          INSERT INTO public.cron_ultimo_esito
            (job, http, ultima_chiamata_il, ultima_chiamata_esito, ultima_esecuzione_il, ultima_esecuzione_stato, ultimo_ok_il)
          VALUES ('job-timeout', true, '2026-10-20 09:58+00', 'timeout', '2026-10-20 09:59+00', 'failed', '2026-10-20 08:20+00');
        `)
        expect(await righeLeggibili(b)).toEqual([
            { job: 'job-timeout', cadenza: '*/10 * * * *', esito: 'timeout', visto: '10-20 09:58', vivo: '10-20 09:58' },
        ])
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

    interface Storici {
        chiamataIl?: string | null
        esito: 'ok' | 'errore-http' | 'errore-rete' | 'timeout' | 'esito-ignoto' | null
        stato?: 'succeeded' | 'failed'
        ultimoOk?: string | null
        /** Una chiamata ancora aperta, inviata a quest'ora (lontana da now(): pg_net fermo). */
        apertaDal?: string
    }

    async function banco(s: Storici): Promise<PGlite> {
        const b = await nuovoDb()
        await b.exec(`
          INSERT INTO cron.job (jobid, schedule, command, jobname, active) VALUES
            (1, '* * * * *', 'select 1', 'storici-stampe', true),
            (2, '4,14,24,34,44,54 * * * *', 'select 1', 'cron-esiti', true);
        `)
        await b.query(
            `INSERT INTO public.cron_ultimo_esito
               (job, http, ultima_chiamata_il, ultima_chiamata_esito, ultima_esecuzione_il, ultima_esecuzione_stato, ultimo_ok_il)
             VALUES
               ('storici-stampe', true, $1, $2, '2026-10-20 09:59+00', $3, $4),
               ('cron-esiti', false, NULL, NULL, '2026-10-20 09:54+00', 'succeeded', '2026-10-20 09:54+00')`,
            [
                s.chiamataIl === undefined ? '2026-10-20 07:58+00' : s.chiamataIl,
                s.esito,
                s.stato ?? 'succeeded',
                s.ultimoOk === undefined ? '2026-10-20 07:50+00' : s.ultimoOk,
            ],
        )
        if (s.apertaDal) {
            await b.query(
                `INSERT INTO public.cron_chiamate (job, richiesta_id, percorso, timeout_ms, inviata_il) VALUES ('storici-stampe', 7, '/api/admin/storici/cron', 300000, $1)`,
                [s.apertaDal],
            )
        }
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

    it('coda vuota da due ore, la funzione SQL riesce ogni minuto: vivo all’ultima esecuzione, e la salute dice ok', async () => {
        const b = await banco({ esito: 'ok' })
        expect(await storici(b)).toEqual([{ job: 'storici-stampe', esito: 'ok', visto: '10-20 07:58', vivo: '10-20 09:59' }])
        expect(await decisione(b, ADESSO)).toEqual({ esito: 'ok', dettaglio: '2 job attivi' })
        await b.close()
    })

    it('l’ultima chiamata è stata respinta (errore-http): le esecuzioni SQL riuscite non la coprono, e la salute dice degradato', async () => {
        const b = await banco({ esito: 'errore-http' })
        expect(await storici(b)).toEqual([{ job: 'storici-stampe', esito: 'fallito', visto: '10-20 07:58', vivo: '10-20 07:50' }])
        expect(await decisione(b, ADESSO)).toEqual({
            esito: 'degradato',
            dettaglio: '2 job attivi; senza un esito buono entro la finestra: storici-stampe',
        })
        await b.close()
    })

    it('un timeout del client resta vivo, come vuole la regola del modulo: le esecuzioni SQL riuscite dopo lo coprono', async () => {
        const b = await banco({ esito: 'timeout' })
        expect(await storici(b)).toEqual([{ job: 'storici-stampe', esito: 'timeout', visto: '10-20 07:58', vivo: '10-20 09:59' }])
        expect(await decisione(b, ADESSO)).toEqual({ esito: 'ok', dettaglio: '2 job attivi; timeout del client, vivi: storici-stampe' })
        await b.close()
    })

    it('pg_net fermo: una chiamata aperta dalle 08:00, l’ultima chiusa ok alle 07:58; le esecuzioni SQL riuscite non lo coprono', async () => {
        const b = await banco({ esito: 'ok', apertaDal: '2026-10-20 08:00+00' })
        expect(await storici(b)).toEqual([{ job: 'storici-stampe', esito: 'ok', visto: '10-20 07:58', vivo: '10-20 07:50' }])
        expect(await decisione(b, ADESSO)).toEqual({
            esito: 'degradato',
            dettaglio: '2 job attivi; senza un esito buono entro la finestra: storici-stampe',
        })
        await b.close()
    })

    it('esito ignoto (pg_net ha dimenticato la risposta): le esecuzioni SQL riuscite non lo coprono', async () => {
        const b = await banco({ esito: 'esito-ignoto' })
        expect(await storici(b)).toEqual([{ job: 'storici-stampe', esito: null, visto: '10-20 07:58', vivo: '10-20 07:50' }])
        expect(await decisione(b, ADESSO)).toEqual({
            esito: 'degradato',
            dettaglio: '2 job attivi; senza un esito buono entro la finestra: storici-stampe',
        })
        await b.close()
    })

    it('esito ignoto, esecuzioni SQL fallite e mai un esito buono: visto girare, quindi allarme e non «in attesa»', async () => {
        const b = await banco({ esito: 'esito-ignoto', stato: 'failed', ultimoOk: null })
        expect(await storici(b)).toEqual([{ job: 'storici-stampe', esito: null, visto: '10-20 07:58', vivo: null }])
        expect(await decisione(b, ADESSO)).toEqual({
            esito: 'degradato',
            dettaglio: '2 job attivi; senza un esito buono entro la finestra: storici-stampe',
        })
        await b.close()
    })

    it('`http` vero e nessuna chiamata chiusa ancora: vale l’esecuzione SQL riuscita, e la salute dice ok', async () => {
        const b = await banco({ chiamataIl: null, esito: null, ultimoOk: null })
        expect(await storici(b)).toEqual([{ job: 'storici-stampe', esito: null, visto: '10-20 09:59', vivo: '10-20 09:59' }])
        expect(await decisione(b, ADESSO)).toEqual({ esito: 'ok', dettaglio: '2 job attivi' })
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
        const b = await nuovoDb()
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
        expect(await decisione(b, ADESSO)).toEqual({
            esito: 'ok',
            dettaglio: '3 job attivi; in attesa del primo esito: app-log-bonifica-pii,notifiche-retention',
        })
        await b.close()
    })
})

describe('salute_migrazioni', () => {
    it('la versione più alta e il numero delle righe; una migrazione riapplicata a mano cambia il numero, non la versione', async () => {
        await db.exec(`INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES
          ('20261001000000', 'a'), ('20261020000000', 'c'), ('20261010000000', 'b')`)
        expect((await db.query('SELECT * FROM public.salute_migrazioni()')).rows).toEqual([
            { ultima: '20261020000000', numero: 3 },
        ])

        // La stessa migrazione «b» applicata una seconda volta a mano: version diversa, stesso nome.
        await db.exec(`INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('20261015000000', 'b')`)
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
        const vuoto = await nuovoDb({ cron: false, esiti: false, chiamate: false })
        expect(await codiceErrore(vuoto, 'SELECT * FROM public.salute_cron_esiti()')).toBe('P0001')
        expect(await codiceErrore(vuoto, 'SELECT * FROM public.salute_migrazioni()')).toBe('P0001')
        await vuoto.close()
    })

    it('con pg_cron ma senza cron_ultimo_esito (la sessione 6 non applicata) la chiamata alza P0001, non 42P01', async () => {
        const mezzo = await nuovoDb({ esiti: false })
        await mezzo.exec(`INSERT INTO cron.job (schedule, command, jobname) VALUES ('*/10 * * * *', 'select 1', 'job-qualsiasi')`)
        expect(await codiceErrore(mezzo, 'SELECT * FROM public.salute_cron_esiti()')).toBe('P0001')
        await mezzo.close()
    })

    it('con cron_ultimo_esito ma senza cron_chiamate la chiamata alza P0001, non 42P01', async () => {
        const mezzo = await nuovoDb({ chiamate: false })
        await mezzo.exec(`INSERT INTO cron.job (schedule, command, jobname) VALUES ('*/10 * * * *', 'select 1', 'job-qualsiasi')`)
        expect(await codiceErrore(mezzo, 'SELECT * FROM public.salute_cron_esiti()')).toBe('P0001')
        await mezzo.close()
    })
})
