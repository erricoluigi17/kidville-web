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
        (5, '0 4 * * *', 'select 1', 'job-ignoto', true),
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
        ('job-ignoto',         true,  '2026-10-20 04:00+00', 'esito-ignoto', '2026-10-20 04:00+00', 'succeeded', '2026-10-19 04:00+00'),
        ('job-sql-ok',         false, NULL, NULL, '2026-10-20 06:00+00', 'succeeded', '2026-10-20 06:00+00'),
        ('job-sql-ko',         false, NULL, NULL, '2026-10-20 06:00+00', 'failed',    '2026-10-19 06:00+00'),
        ('job-spento',         false, NULL, NULL, '2026-10-20 06:00+00', 'succeeded', '2026-10-20 06:00+00'),
        ('job-http-nullo',     true,  NULL, NULL, '2026-10-20 09:59+00', 'succeeded', NULL),
        -- Due job HTTP senza NESSUNA chiamata chiusa, gli unici per cui l'esecuzione SQL riuscita può
        -- valere: lì decide la guardia delle chiamate aperte.
        ('job-pgnet-fermo',    true,  NULL, NULL, '2026-10-20 09:59+00', 'succeeded', NULL),
        ('job-aperta-recente', true,  NULL, NULL, '2026-10-20 09:59+00', 'succeeded', NULL),
        ('jobid-99',           false, NULL, NULL, '2026-10-01 04:35+00', 'succeeded', '2026-10-01 04:35+00');
      -- Le chiamate aperte di cron_chiamate (verificata_il nullo). Le età sono rispetto a now(): la
      -- guardia della RPC le misura così, e i 30 minuti stanno fra 20 e 40.
      INSERT INTO public.cron_chiamate (job, richiesta_id, percorso, timeout_ms, inviata_il, esito, verificata_il) VALUES
        ('job-pgnet-fermo',    11, '/api/x', 5000, now() - interval '40 minutes', 'in-attesa', NULL),
        ('job-pgnet-fermo',    12, '/api/x', 5000, now() - interval '20 minutes', 'in-attesa', NULL),
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
            // Nessuna chiamata chiusa e una aperta da 20 minuti, ancora normale: l'esecuzione SQL
            // riuscita delle 09:59 conta.
            { job: 'job-aperta-recente', cadenza: '*/10 * * * *', esito: null, visto: '10-20 09:59', vivo: '10-20 09:59' },
            // `http` vero ma nessuna chiamata chiusa: il giro visto è l'esecuzione SQL, ed è viva.
            { job: 'job-http-nullo', cadenza: '*/10 * * * *', esito: null, visto: '10-20 09:59', vivo: '10-20 09:59' },
            // Esito ignoto (nessuna risposta letta entro 6 ore): un esito suo, e mai vivo; vivo resta
            // l'ultimo ok, del giorno prima.
            { job: 'job-ignoto', cadenza: '0 4 * * *', esito: 'ignoto', visto: '10-20 04:00', vivo: '10-19 04:00' },
            { job: 'job-nuovo', cadenza: '0 6 * * *', esito: null, visto: null, vivo: null },
            { job: 'job-ok-http', cadenza: '*/10 * * * *', esito: 'ok', visto: '10-20 09:55', vivo: '10-20 09:55' },
            // pg_net fermo prima della prima risposta: nessuna chiamata chiusa, una aperta da 40 minuti.
            // L'esecuzione SQL riuscita non conta: visto girare, mai vivo.
            { job: 'job-pgnet-fermo', cadenza: '*/10 * * * *', esito: null, visto: '10-20 09:59', vivo: null },
            { job: 'job-rete', cadenza: '*/10 * * * *', esito: 'fallito', visto: '10-20 09:56', vivo: null },
            { job: 'job-sql-ko', cadenza: '0 6 * * *', esito: 'fallito', visto: '10-20 06:00', vivo: '10-19 06:00' },
            { job: 'job-sql-ok', cadenza: '0 6 * * *', esito: 'ok', visto: '10-20 06:00', vivo: '10-20 06:00' },
            { job: 'job-timeout', cadenza: '*/10 * * * *', esito: 'timeout', visto: '10-20 09:58', vivo: '10-20 09:58' },
            { job: 'jobid-99', cadenza: '35 4 1 * *', esito: 'ok', visto: '10-01 04:35', vivo: '10-01 04:35' },
        ])
    })

    it('il timeout del client è vivo anche quando il giro SQL dopo è fallito', async () => {
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

describe('vivo_il di un job HTTP: l’esecuzione SQL riuscita conta solo prima della prima chiamata chiusa', () => {
    // `storici_tick` (job `storici-stampe`, ogni minuto) chiama /api/admin/storici/cron a ogni giro,
    // dentro un `exception when others` che inghiotte un fallimento di net.http_post. Per la
    // sessione 6 `ultimo_ok_il` di un job HTTP cambia solo con le chiamate, e `http` non torna mai
    // false. Un giro SQL riuscito non dice che il server ha risposto: dopo la prima chiamata chiusa
    // vive solo la chiamata. Quando la sessione 8 farà chiamare `storici_tick` solo con la coda piena,
    // dichiarerà il job «a coda vuota» nella RPC. `cron-esiti` (sola SQL, 09:54) è il testimone della
    // freschezza: senza, la salute direbbe «cron-esiti fermo» per la ragione sbagliata.
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
        const chiamataIl = s.chiamataIl === undefined ? '2026-10-20 07:58+00' : s.chiamataIl
        // Come scrive la sessione 6: con l'ultima chiamata 'ok', l'ultimo ok è quella chiamata.
        const ultimoOk = s.ultimoOk !== undefined ? s.ultimoOk : s.esito === 'ok' ? chiamataIl : '2026-10-20 07:50+00'
        await b.query(
            `INSERT INTO public.cron_ultimo_esito
               (job, http, ultima_chiamata_il, ultima_chiamata_esito, ultima_esecuzione_il, ultima_esecuzione_stato, ultimo_ok_il)
             VALUES
               ('storici-stampe', true, $1, $2, '2026-10-20 09:59+00', $3, $4),
               ('cron-esiti', false, NULL, NULL, '2026-10-20 09:54+00', 'succeeded', '2026-10-20 09:54+00')`,
            [chiamataIl, s.esito, s.stato ?? 'succeeded', ultimoOk],
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

    it('chiamate chiuse, l’ultima ok alle 07:58 e fuori finestra; la funzione SQL riesce ogni minuto senza chiamare: vivo resta alla chiamata, e la salute dice degradato', async () => {
        const b = await banco({ esito: 'ok' })
        expect(await storici(b)).toEqual([{ job: 'storici-stampe', esito: 'ok', visto: '10-20 07:58', vivo: '10-20 07:58' }])
        expect(await decisione(b, ADESSO)).toEqual({
            esito: 'degradato',
            dettaglio: '2 job attivi; senza un esito buono entro la finestra: storici-stampe',
        })
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

    it('un timeout del client è vivo all’istante della chiamata, non alle esecuzioni SQL dopo: fuori finestra, degradato', async () => {
        const b = await banco({ esito: 'timeout' })
        expect(await storici(b)).toEqual([{ job: 'storici-stampe', esito: 'timeout', visto: '10-20 07:58', vivo: '10-20 07:58' }])
        expect(await decisione(b, ADESSO)).toEqual({
            esito: 'degradato',
            dettaglio: '2 job attivi; senza un esito buono entro la finestra: storici-stampe',
        })
        await b.close()
    })

    it('pg_net fermo dopo una chiamata ok: una aperta dalle 08:00, l’ultima chiusa ok alle 07:58; le esecuzioni SQL riuscite non lo coprono', async () => {
        const b = await banco({ esito: 'ok', apertaDal: '2026-10-20 08:00+00' })
        expect(await storici(b)).toEqual([{ job: 'storici-stampe', esito: 'ok', visto: '10-20 07:58', vivo: '10-20 07:58' }])
        expect(await decisione(b, ADESSO)).toEqual({
            esito: 'degradato',
            dettaglio: '2 job attivi; senza un esito buono entro la finestra: storici-stampe',
        })
        await b.close()
    })

    it('pg_net fermo prima della prima risposta: nessuna chiamata chiusa, una aperta dalle 08:00; l’esecuzione SQL riuscita non conta', async () => {
        const b = await banco({ chiamataIl: null, esito: null, ultimoOk: null, apertaDal: '2026-10-20 08:00+00' })
        expect(await storici(b)).toEqual([{ job: 'storici-stampe', esito: null, visto: '10-20 09:59', vivo: null }])
        expect(await decisione(b, ADESSO)).toEqual({
            esito: 'degradato',
            dettaglio: '2 job attivi; senza un esito buono entro la finestra: storici-stampe',
        })
        await b.close()
    })

    // Un esito ignoto la sessione 6 lo scrive solo a 6 ore dall'invio: la chiamata è delle 03:58.
    const IGNOTO = 'di questi, ultima chiamata a esito ignoto (lettore fermo oltre 6 ore attorno al giro): storici-stampe'

    it('esito ignoto (la risposta non è stata letta entro 6 ore): le esecuzioni SQL riuscite non lo coprono, e il dettaglio lo dice', async () => {
        const b = await banco({ chiamataIl: '2026-10-20 03:58+00', esito: 'esito-ignoto', ultimoOk: '2026-10-20 03:50+00' })
        expect(await storici(b)).toEqual([{ job: 'storici-stampe', esito: 'ignoto', visto: '10-20 03:58', vivo: '10-20 03:50' }])
        expect(await decisione(b, ADESSO)).toEqual({
            esito: 'degradato',
            dettaglio: `2 job attivi; senza un esito buono entro la finestra: storici-stampe; ${IGNOTO}`,
        })
        await b.close()
    })

    it('esito ignoto, esecuzioni SQL fallite e mai un esito buono: visto girare, quindi allarme e non «in attesa»', async () => {
        const b = await banco({ chiamataIl: '2026-10-20 03:58+00', esito: 'esito-ignoto', stato: 'failed', ultimoOk: null })
        expect(await storici(b)).toEqual([{ job: 'storici-stampe', esito: 'ignoto', visto: '10-20 03:58', vivo: null }])
        expect(await decisione(b, ADESSO)).toEqual({
            esito: 'degradato',
            dettaglio: `2 job attivi; senza un esito buono entro la finestra: storici-stampe; ${IGNOTO}`,
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

describe('un job HTTP che smette di chiamare il server mentre la sua funzione SQL riesce', () => {
    // Le due forme del falso «ok» trovate dalla seconda revisione: con la regola di prima l'ultima
    // esecuzione SQL riuscita teneva vivo il job, e la salute diceva ok per giorni.

    it('mensile, l’URL del Vault sparito: ultima chiamata ok 39 giorni fa, l’ultimo giro SQL (9 giorni fa) è uscito con RETURN senza chiamare: degradato', async () => {
        // `iscrizioni_retention_http` con l'URL assente scrive `url-assente` in app_log e fa RETURN:
        // per pg_cron il giro è 'succeeded', e nessuna riga nasce in cron_chiamate.
        const b = await nuovoDb()
        await b.exec(`
          INSERT INTO cron.job (jobid, schedule, command, jobname, active) VALUES
            (1, '41 4 1 * *', 'select 1', 'iscrizioni-retention', true),
            (2, '4,14,24,34,44,54 * * * *', 'select 1', 'cron-esiti', true);
          INSERT INTO public.cron_ultimo_esito
            (job, http, ultima_chiamata_il, ultima_chiamata_esito, ultima_esecuzione_il, ultima_esecuzione_stato, ultimo_ok_il)
          VALUES
            ('iscrizioni-retention', true, '2026-09-01 04:41+00', 'ok', '2026-10-01 04:41+00', 'succeeded', '2026-09-01 04:41+00'),
            ('cron-esiti', false, NULL, NULL, '2026-10-10 11:54+00', 'succeeded', '2026-10-10 11:54+00');
        `)
        const { rows } = await b.query(`
          SELECT esito, to_char(vivo_il AT TIME ZONE 'UTC', 'MM-DD HH24:MI') AS vivo
            FROM public.salute_cron_esiti() WHERE job = 'iscrizioni-retention'`)
        expect(rows).toEqual([{ esito: 'ok', vivo: '09-01 04:41' }])
        expect(await decisione(b, Date.parse('2026-10-10T12:00:00Z'))).toEqual({
            esito: 'degradato',
            dettaglio: '2 job attivi; senza un esito buono entro la finestra: iscrizioni-retention',
        })
        await b.close()
    })

    it('ogni minuto, net.http_post fallita e inghiottita da EXCEPTION WHEN OTHERS: ultima chiamata ok 3 ore fa, ultimo giro SQL riuscito 1 minuto fa: degradato', async () => {
        // L'accodamento fallisce prima di cron_chiamate: nessuna chiamata aperta, la guardia dei 30
        // minuti non vede niente. Vive solo la chiamata delle 07:00.
        const b = await nuovoDb()
        await b.exec(`
          INSERT INTO cron.job (jobid, schedule, command, jobname, active) VALUES
            (1, '* * * * *', 'select 1', 'storici-stampe', true),
            (2, '4,14,24,34,44,54 * * * *', 'select 1', 'cron-esiti', true);
          INSERT INTO public.cron_ultimo_esito
            (job, http, ultima_chiamata_il, ultima_chiamata_esito, ultima_esecuzione_il, ultima_esecuzione_stato, ultimo_ok_il)
          VALUES
            ('storici-stampe', true, '2026-10-20 07:00+00', 'ok', '2026-10-20 09:59+00', 'succeeded', '2026-10-20 07:00+00'),
            ('cron-esiti', false, NULL, NULL, '2026-10-20 09:54+00', 'succeeded', '2026-10-20 09:54+00');
        `)
        const { rows } = await b.query(`
          SELECT esito, to_char(vivo_il AT TIME ZONE 'UTC', 'MM-DD HH24:MI') AS vivo
            FROM public.salute_cron_esiti() WHERE job = 'storici-stampe'`)
        expect(rows).toEqual([{ esito: 'ok', vivo: '10-20 07:00' }])
        expect(await decisione(b, Date.parse('2026-10-20T10:00:00Z'))).toEqual({
            esito: 'degradato',
            dettaglio: '2 job attivi; senza un esito buono entro la finestra: storici-stampe',
        })
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

describe('dopo la sessione 8: storici-stampe chiama il server solo con la coda piena, e la salute lo sa', () => {
    // Con 20261025151929_storici_tick_solo_con_lavoro.sql `storici_tick` chiama
    // /api/admin/storici/cron solo quando `storici_generazioni` ha lavoro: a coda vuota l'ultima
    // chiamata chiusa invecchia per ore, il giro SQL riesce ogni minuto, e per la RPC della sessione 7
    // il job sarebbe «senza un esito buono» (salute `degradato` dopo 31 minuti di coda vuota). La
    // stessa migrazione riscrive salute_cron_esiti con un elenco dichiarato dei job «a coda vuota»
    // (oggi solo `storici-stampe`), per i quali l'esecuzione SQL riuscita torna a valere. Qui la
    // migrazione della 7 e poi quella della 8, due volte; gli istanti sono relativi a now(), perché
    // il limite dei 30 minuti sulla chiamata aperta si misura da now() e va provato davvero.
    const DOPO_LA_8 = migrazione('_storici_tick_solo_con_lavoro.sql')

    interface Riga {
        job: string
        stato: 'succeeded' | 'failed'
        /** L'ultima chiamata chiusa, a quanti minuti fa (120 = coda vuota da 2 ore), e il suo esito. */
        chiamataMinutiFa?: number
        esito: 'ok' | 'errore-http' | 'errore-rete' | 'timeout' | 'esito-ignoto'
        /** Una chiamata ancora aperta, inviata a quanti minuti fa. */
        apertaMinutiFa?: number
    }

    async function bancoDopoLa8(righe: Riga[]): Promise<PGlite> {
        const b = await nuovoDb()
        await b.exec(DOPO_LA_8)
        await b.exec(DOPO_LA_8) // idempotenza
        await b.exec(`INSERT INTO cron.job (schedule, command, jobname, active)
                      VALUES ('4,14,24,34,44,54 * * * *', 'select 1', 'cron-esiti', true)`)
        await b.exec(`INSERT INTO public.cron_ultimo_esito
                        (job, http, ultima_esecuzione_il, ultima_esecuzione_stato, ultimo_ok_il)
                      VALUES ('cron-esiti', false, now() - interval '6 minutes', 'succeeded', now() - interval '6 minutes')`)
        for (const r of righe) {
            const chiamata = r.chiamataMinutiFa ?? 120
            await b.query(`INSERT INTO cron.job (schedule, command, jobname, active) VALUES ('* * * * *', 'select 1', $1, true)`, [r.job])
            // Come scrive la sessione 6: con l'ultima chiamata 'ok' l'ultimo ok è quella chiamata,
            // altrimenti uno più vecchio (qui 3 ore fa).
            await b.query(
                `INSERT INTO public.cron_ultimo_esito
                   (job, http, ultima_chiamata_il, ultima_chiamata_esito, ultima_esecuzione_il, ultima_esecuzione_stato, ultimo_ok_il)
                 VALUES ($1, true, now() - make_interval(mins => $2::int), $3, now() - interval '1 minute', $4,
                         now() - make_interval(mins => CASE WHEN $3 = 'ok' THEN $2::int ELSE 180 END))`,
                [r.job, chiamata, r.esito, r.stato],
            )
            if (r.apertaMinutiFa !== undefined) {
                await b.query(
                    `INSERT INTO public.cron_chiamate (job, richiesta_id, percorso, timeout_ms, inviata_il)
                     VALUES ($1, 7, '/api/x', 300000, now() - make_interval(mins => $2::int))`,
                    [r.job, r.apertaMinutiFa],
                )
            }
        }
        return b
    }

    /** Minuti da `vivo_il` per job (null = mai vivo). */
    async function vivoMinutiFa(b: PGlite): Promise<Record<string, number | null>> {
        const { rows } = await b.query<{ job: string; minuti: number | null }>(`
          SELECT job, round(extract(epoch FROM now() - vivo_il) / 60)::int AS minuti
            FROM public.salute_cron_esiti() WHERE job <> 'cron-esiti'`)
        return Object.fromEntries(rows.map((r) => [r.job, r.minuti]))
    }

    it('(a) coda vuota da 2 ore, ultima chiamata ok 2 ore fa, giro SQL riuscito 1 minuto fa: vivo, e la salute dice ok', async () => {
        const b = await bancoDopoLa8([{ job: 'storici-stampe', stato: 'succeeded', esito: 'ok' }])
        expect(await vivoMinutiFa(b)).toEqual({ 'storici-stampe': 1 })
        expect(await decisione(b, Date.now())).toEqual({ esito: 'ok', dettaglio: '2 job attivi' })
        await b.close()
    })

    it('(b) controllo negativo: un job HTTP fuori dall’elenco, nella stessa situazione, resta senza esito buono', async () => {
        const b = await bancoDopoLa8([
            { job: 'storici-stampe', stato: 'succeeded', esito: 'ok' },
            { job: 'altro-http', stato: 'succeeded', esito: 'ok' },
        ])
        expect(await vivoMinutiFa(b)).toEqual({ 'altro-http': 120, 'storici-stampe': 1 })
        expect(await decisione(b, Date.now())).toEqual({
            esito: 'degradato',
            dettaglio: '3 job attivi; senza un esito buono entro la finestra: altro-http',
        })
        await b.close()
    })

    it('(c) un giro SQL FALLITO di storici-stampe non lo rende vivo', async () => {
        const b = await bancoDopoLa8([{ job: 'storici-stampe', stato: 'failed', esito: 'ok' }])
        expect(await vivoMinutiFa(b)).toEqual({ 'storici-stampe': 120 })
        expect(await decisione(b, Date.now())).toEqual({
            esito: 'degradato',
            dettaglio: '2 job attivi; senza un esito buono entro la finestra: storici-stampe',
        })
        await b.close()
    })

    it('(d) una chiamata aperta da più di 30 minuti (pg_net fermo) non lo rende vivo; una aperta da 10 sì', async () => {
        const ferma = await bancoDopoLa8([{ job: 'storici-stampe', stato: 'succeeded', esito: 'ok', apertaMinutiFa: 45 }])
        expect(await vivoMinutiFa(ferma)).toEqual({ 'storici-stampe': 120 })
        expect((await decisione(ferma, Date.now())).esito).toBe('degradato')
        await ferma.close()

        const inVolo = await bancoDopoLa8([{ job: 'storici-stampe', stato: 'succeeded', esito: 'ok', apertaMinutiFa: 10 }])
        expect(await vivoMinutiFa(inVolo)).toEqual({ 'storici-stampe': 1 })
        expect((await decisione(inVolo, Date.now())).esito).toBe('ok')
        await inVolo.close()
    })

    it('(e) la coda ha lavoro e il server respinge ogni chiamata: il giro SQL che accoda e basta non copre il rifiuto', async () => {
        // Con lavoro in coda storici_tick chiama a ogni minuto; se la route risponde 500 la riga
        // resta da prendere e il giro dopo richiama. Il giro SQL riesce sempre (cron_http_post accoda
        // e torna): se valesse, la salute direbbe ok per sempre, con «ultimo esito fallito» che non
        // esce mai dalla finestra. Lo stesso per una risposta mai letta (esito-ignoto, «mai vivo»
        // per la sessione 7). Il timeout del client invece è vivo (la route può aver finito).
        const b = await bancoDopoLa8([
            { job: 'storici-stampe', stato: 'succeeded', esito: 'errore-http', chiamataMinutiFa: 5 },
        ])
        expect(await vivoMinutiFa(b)).toEqual({ 'storici-stampe': 180 })
        expect(await decisione(b, Date.now())).toEqual({
            esito: 'degradato',
            dettaglio: '2 job attivi; senza un esito buono entro la finestra: storici-stampe',
        })
        await b.close()

        for (const esito of ['errore-rete', 'esito-ignoto'] as const) {
            const c = await bancoDopoLa8([{ job: 'storici-stampe', stato: 'succeeded', esito }])
            expect(await vivoMinutiFa(c), esito).toEqual({ 'storici-stampe': 180 })
            await c.close()
        }
        const t = await bancoDopoLa8([{ job: 'storici-stampe', stato: 'succeeded', esito: 'timeout' }])
        expect(await vivoMinutiFa(t)).toEqual({ 'storici-stampe': 1 })
        await t.close()
    })

    it('la riscrittura tiene firma, SECURITY DEFINER, STABLE, search_path vuoto e permessi della sessione 7', async () => {
        const b = await bancoDopoLa8([])
        const { rows } = await b.query<{ n: number; prosecdef: boolean; provolatile: string; proconfig: string[] | null; risultato: string }>(`
          SELECT count(*) OVER () AS n, prosecdef, provolatile, proconfig, pg_get_function_result(oid) AS risultato
            FROM pg_proc WHERE proname = 'salute_cron_esiti'`)
        expect(rows).toHaveLength(1)
        expect([Number(rows[0].n), rows[0].prosecdef, rows[0].provolatile]).toEqual([1, true, 's'])
        expect(rows[0].proconfig?.[0]).toMatch(/^search_path=(""|)$/)
        expect(rows[0].risultato).toBe(
            'TABLE(job text, cadenza text, esito text, visto_il timestamp with time zone, vivo_il timestamp with time zone)',
        )
        const permessi = await b.query(`
          SELECT r AS ruolo, has_function_privilege(r, 'public.salute_cron_esiti()', 'EXECUTE') AS esegue
            FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r ORDER BY r`)
        expect(permessi.rows).toEqual([
            { ruolo: 'anon', esegue: false },
            { ruolo: 'authenticated', esegue: false },
            { ruolo: 'service_role', esegue: true },
        ])
        expect(await codiceErrore(b, `SET ROLE anon; SELECT * FROM public.salute_cron_esiti()`)).toBe('42501')
        await b.close()
    })

    it('senza le tabelle di pg_cron (il DB della CI) la migrazione della 8 si applica e la chiamata alza ancora P0001', async () => {
        const vuoto = await nuovoDb({ cron: false, esiti: false, chiamate: false })
        await vuoto.exec(DOPO_LA_8)
        expect(await codiceErrore(vuoto, 'SELECT * FROM public.salute_cron_esiti()')).toBe('P0001')
        await vuoto.close()
    })
})
