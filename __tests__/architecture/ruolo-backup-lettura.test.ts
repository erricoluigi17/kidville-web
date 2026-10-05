import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { senzaCommenti } from './soglia-fotografia'

/**
 * LOCK — il ruolo `backup_lettura` può SOLO leggere, e la sua password non sta nel repo.
 *
 * ─── PERCHÉ ESISTE ──────────────────────────────────────────────────────────
 * Roadmap di robustezza, fase 2 (problema D1): il backup notturno esterno gira su GitHub
 * Actions, senza persone davanti, e per leggere il database ha bisogno di una connessione.
 * Dargli quella dell'utente `postgres` significherebbe tenere in un segreto di GitHub una
 * credenziale che può CANCELLARE tutto. Un utente apposta, che legge e basta, riduce quel che
 * una fuga del segreto può fare a «leggere», che è già grave ma non distrugge niente.
 *
 * ─── COSA PRETENDE QUESTO LOCK ──────────────────────────────────────────────
 *  1. La migrazione esiste ed è una sola.
 *  2. Il ruolo nasce `NOLOGIN` e con `BYPASSRLS` (senza, `pg_dump` si ferma sulle tabelle con
 *     RLS). Il LOGIN e la password si danno a mano nel pannello: **una password in un file
 *     tracciato di un repository PUBBLICO è una password pubblica**.
 *  3. L'unica appartenenza concessa è `pg_read_all_data`: nessun'altra `GRANT … TO backup_lettura`.
 *  4. Nessun attributo che dia poteri di scrittura o di gestione (`SUPERUSER`, `CREATEROLE`,
 *     `CREATEDB`, `REPLICATION`) e nessun `PASSWORD`.
 *  5. È rieseguibile (`IF NOT EXISTS`) e non distrugge niente (`DROP`, `DELETE`, `TRUNCATE`).
 *
 * ─── COME LEGGE IL FILE ─────────────────────────────────────────────────────
 * Si tolgono i commenti PRIMA di cercare (`senzaCommenti`): la migrazione spiega proprio le
 * cose che vieta, e un lock che legge anche la prosa si immunizza da solo. Le prove gemelle
 * in fondo rompono ogni regola a turno e pretendono che il lock diventi rosso.
 */

const CARTELLA = join(process.cwd(), 'supabase', 'migrations')
const RUOLO = 'backup_lettura'

/** Le violazioni dell'SQL di una migrazione del ruolo di backup; vuoto = a posto. */
function violazioni(sql: string): string[] {
    const s = senzaCommenti(sql)
    const v: string[] = []

    if (!new RegExp(`create\\s+role\\s+${RUOLO}\\s+nologin\\s+bypassrls\\b`, 'i').test(s)) {
        v.push('il ruolo deve nascere `CREATE ROLE backup_lettura NOLOGIN BYPASSRLS`')
    }
    if (!/if\s+not\s+exists\s*\(\s*select\s+1\s+from\s+pg_roles\s+where\s+rolname\s*=\s*'backup_lettura'/i.test(s)) {
        v.push('la creazione deve essere rieseguibile (`IF NOT EXISTS (SELECT 1 FROM pg_roles …)`)')
    }
    if (/\bpassword\b/i.test(s)) v.push('la parola PASSWORD non deve comparire: la password non sta nel repo')
    if (/\blogin\b/i.test(s)) v.push('LOGIN non si concede nella migrazione: lo dà a mano il titolare')
    for (const attributo of ['superuser', 'createrole', 'createdb', 'replication']) {
        if (new RegExp(`\\b${attributo}\\b`, 'i').test(s)) v.push(`attributo vietato: ${attributo.toUpperCase()}`)
    }
    for (const verbo of ['drop', 'delete', 'truncate']) {
        if (new RegExp(`\\b${verbo}\\b`, 'i').test(s)) v.push(`istruzione distruttiva vietata: ${verbo.toUpperCase()}`)
    }

    // Ogni `GRANT <qualcosa> TO backup_lettura` deve concedere SOLO `pg_read_all_data`
    // (o il `CONNECT` sul database, che è un'altra forma di GRANT: «ON DATABASE»).
    const grant = [...s.matchAll(/grant\s+([^;]+?)\s+to\s+([^;]+);/gi)]
    let leggeTutto = false
    let connette = false
    for (const [, cosa, a] of grant) {
        if (!new RegExp(`\\b${RUOLO}\\b`, 'i').test(a)) continue
        const c = cosa.trim().toLowerCase()
        if (c === 'pg_read_all_data') leggeTutto = true
        else if (/^connect\s+on\s+database\s+postgres$/.test(c)) connette = true
        else v.push(`GRANT non ammesso a ${RUOLO}: «${cosa.trim()}»`)
    }
    if (!leggeTutto) v.push('manca `GRANT pg_read_all_data TO backup_lettura`')
    if (!connette) v.push('manca `GRANT CONNECT ON DATABASE postgres TO backup_lettura`')
    return v
}

const FILE_RUOLO = readdirSync(CARTELLA).filter((f) => /^\d{14}_ruolo_backup_lettura\.sql$/.test(f))

describe('LOCK · il ruolo backup_lettura legge e basta', () => {
    it('c\'è UNA migrazione `<version>_ruolo_backup_lettura.sql`', () => {
        expect(FILE_RUOLO).toHaveLength(1)
    })

    it('la migrazione reale non ha nessuna violazione', () => {
        const sql = readFileSync(join(CARTELLA, FILE_RUOLO[0]), 'utf8')
        expect(violazioni(sql)).toEqual([])
    })
})

describe('PROVE GEMELLE · il lock diventa rosso quando una regola si rompe', () => {
    const BUONO = `
        -- commento che nomina PASSWORD, LOGIN e DROP senza comandarli
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'backup_lettura') THEN
            CREATE ROLE backup_lettura NOLOGIN BYPASSRLS;
          END IF;
        END $$;
        GRANT pg_read_all_data TO backup_lettura;
        GRANT CONNECT ON DATABASE postgres TO backup_lettura;
        ALTER ROLE backup_lettura SET statement_timeout = '30min';
    `

    it('controllo positivo: lo SQL buono passa (e i commenti non contano)', () => {
        expect(violazioni(BUONO)).toEqual([])
    })

    const MUTAZIONI: Array<[string, (s: string) => string, RegExp]> = [
        ['con LOGIN', (s) => s.replace('NOLOGIN BYPASSRLS', 'LOGIN BYPASSRLS'), /NOLOGIN/],
        ['senza BYPASSRLS', (s) => s.replace('NOLOGIN BYPASSRLS', 'NOLOGIN'), /NOLOGIN BYPASSRLS/],
        ['con una password', (s) => s.replace('NOLOGIN BYPASSRLS;', "NOLOGIN BYPASSRLS PASSWORD 'x';"), /PASSWORD/],
        ['con SUPERUSER', (s) => s.replace('NOLOGIN BYPASSRLS;', 'NOLOGIN BYPASSRLS SUPERUSER;'), /SUPERUSER/],
        ['con CREATEROLE', (s) => s.replace('NOLOGIN BYPASSRLS;', 'NOLOGIN BYPASSRLS CREATEROLE;'), /CREATEROLE/],
        ['non rieseguibile', (s) => s.replace('IF NOT EXISTS (SELECT', 'IF EXISTS (SELECT'), /rieseguibile/],
        ['senza pg_read_all_data', (s) => s.replace('GRANT pg_read_all_data TO backup_lettura;', ''), /pg_read_all_data/],
        ['con un altro GRANT', (s) => s + '\nGRANT pg_write_all_data TO backup_lettura;', /GRANT non ammesso/],
        ['con service_role', (s) => s + '\nGRANT service_role TO backup_lettura;', /GRANT non ammesso/],
        ['senza CONNECT', (s) => s.replace('GRANT CONNECT ON DATABASE postgres TO backup_lettura;', ''), /CONNECT/],
        ['con un DROP', (s) => s + '\nDROP ROLE IF EXISTS vecchio;', /DROP/],
        ['con un DELETE', (s) => s + "\nDELETE FROM public.app_log WHERE true;", /DELETE/],
        ['con un TRUNCATE', (s) => s + '\nTRUNCATE public.app_log;', /TRUNCATE/],
    ]

    for (const [nome, rompi, atteso] of MUTAZIONI) {
        it(`mutazione «${nome}» → rosso`, () => {
            const mutato = rompi(BUONO)
            expect(mutato).not.toBe(BUONO) // la mutazione ha davvero cambiato qualcosa
            const trovate = violazioni(mutato).join(' | ')
            expect(trovate).toMatch(atteso)
        })
    }
})
