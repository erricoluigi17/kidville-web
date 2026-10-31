// @vitest-environment node

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist'
import { MIGRAZIONI_ATTESE_AL_MERGE, senzaCommenti } from '../../architecture/soglia-fotografia'

/**
 * CRM DELLA SEGRETERIA · LA MIGRAZIONE.
 *
 * Due letture dello stesso file, perché una sola non basta:
 *
 *  1. TESTUALE — il file `supabase/migrations/<UTC>_crm_segreteria.sql` ha la forma che il resto del
 *     sistema presuppone: sette tabelle `crm_*`, ognuna con `scuola_id` e RLS accesa SENZA policy
 *     (le legge solo il service-role, con il gate dell'applicazione), le figlie agganciate alla
 *     scheda con la chiave composta `(scheda_id, scuola_id)`, l'EXCLUDE contro gli appuntamenti
 *     sovrapposti, le chiavi verso le domande di iscrizione `ON DELETE SET NULL`.
 *  2. ESEGUITA — lo stesso file applicato DUE volte su un Postgres vero (PGlite, in memoria): la
 *     seconda è la prova dell'idempotenza, e i vincoli che la lettura del testo non può provare
 *     (l'EXCLUDE che dà davvero 23P01, la chiave composta che impedisce a un figlio di cambiare sede,
 *     i CHECK, `SET NULL`, `CASCADE`) vengono messi alla prova con righe finte.
 *
 * ⚠️ PGlite è PostgreSQL 18, la produzione è PostgreSQL 17. Qui si provano vincoli che non cambiano
 * fra le due versioni.
 *
 * Solo dati finti: uuid inventati, nessuna anagrafica.
 */

const CARTELLA = join(process.cwd(), 'supabase', 'migrations')

const TABELLE = [
    'crm_appuntamenti',
    'crm_azioni',
    'crm_bambini',
    'crm_disponibilita',
    'crm_eventi',
    'crm_indisponibilita',
    'crm_schede',
] as const

const FIGLIE = ['crm_bambini', 'crm_appuntamenti', 'crm_azioni', 'crm_eventi'] as const

const FILE = readdirSync(CARTELLA).filter((f) => /^\d{14}_crm_segreteria\.sql$/.test(f))
const NOME_FILE = FILE[0] ?? ''
const SQL_GREZZO = FILE.length === 1 ? readFileSync(join(CARTELLA, NOME_FILE), 'utf8') : ''
const SQL = senzaCommenti(SQL_GREZZO)

/** Il corpo di ogni `create table … ( … )`, per nome senza schema. */
function corpiDelleTabelle(sql: string): Record<string, string> {
    const out: Record<string, string> = {}
    const re = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?(\w+)\s*\(/gi
    for (let m = re.exec(sql); m; m = re.exec(sql)) {
        let livello = 1
        let j = re.lastIndex
        while (j < sql.length && livello > 0) {
            if (sql[j] === '(') livello++
            if (sql[j] === ')') livello--
            j++
        }
        out[m[1].toLowerCase()] = sql.slice(re.lastIndex, j - 1)
    }
    return out
}

describe('migrazione CRM · forma del file', () => {
    it('esiste un solo file *_crm_segreteria.sql', () => {
        expect(FILE).toHaveLength(1)
    })

    it('crea le sette tabelle crm_*', () => {
        const trovate = Object.keys(corpiDelleTabelle(SQL))
            .filter((t) => t.startsWith('crm_'))
            .sort()
        expect(trovate).toEqual([...TABELLE])
    })

    it('ogni tabella crm_* ha scuola_id con FK a schools e RLS attiva', () => {
        const corpi = corpiDelleTabelle(SQL)
        for (const t of TABELLE) {
            expect(corpi[t], `${t} manca`).toBeDefined()
            expect(corpi[t], `${t}: scuola_id uuid not null references public.schools(id)`).toMatch(
                /\bscuola_id\s+uuid\s+not\s+null\s+references\s+public\.schools\s*\(\s*id\s*\)/i,
            )
            expect(corpi[t], `${t}: chiave primaria`).toMatch(
                /\bid\s+uuid\s+primary\s+key\s+default\s+gen_random_uuid\(\)/i,
            )
            expect(SQL, `${t}: enable row level security`).toMatch(
                new RegExp(`alter\\s+table\\s+(?:if\\s+exists\\s+)?public\\.${t}\\s+enable\\s+row\\s+level\\s+security`, 'i'),
            )
            expect(SQL, `${t}: comment on table`).toMatch(new RegExp(`comment\\s+on\\s+table\\s+public\\.${t}\\s+is\\s+'`, 'i'))
        }
    })

    it('nessuna create policy', () => {
        expect(SQL).not.toMatch(/create\s+policy/i)
        // e nessuna funzione che scavalca la RLS
        expect(SQL).not.toMatch(/security\s+definer/i)
    })

    it('le figlie hanno la FK composta (scheda_id, scuola_id)', () => {
        const corpi = corpiDelleTabelle(SQL)
        expect(corpi.crm_schede).toMatch(/unique\s*\(\s*id\s*,\s*scuola_id\s*\)/i)
        for (const t of FIGLIE) {
            expect(corpi[t], `${t}: scheda_id uuid not null`).toMatch(/\bscheda_id\s+uuid\s+not\s+null\b/i)
            expect(corpi[t], `${t}: foreign key composta`).toMatch(
                /foreign\s+key\s*\(\s*scheda_id\s*,\s*scuola_id\s*\)\s*references\s+public\.crm_schede\s*\(\s*id\s*,\s*scuola_id\s*\)\s*on\s+delete\s+cascade/i,
            )
        }
    })

    it('crm_appuntamenti ha l’exclude su assegnata_a e tstzrange(inizio, fine) limitato a in_programma', () => {
        const corpo = corpiDelleTabelle(SQL).crm_appuntamenti
        expect(corpo).toMatch(
            /exclude\s+using\s+gist\s*\(\s*assegnata_a\s+with\s*=\s*,\s*tstzrange\s*\(\s*inizio\s*,\s*fine\s*\)\s+with\s*&&\s*\)\s*where\s*\(\s*stato\s*=\s*'in_programma'\s*\)/i,
        )
        expect(SQL).toMatch(/create\s+extension\s+if\s+not\s+exists\s+btree_gist\b/i)
    })

    it('le FK verso enrollment_submissions sono on delete set null', () => {
        const tutte = [...SQL.matchAll(/references\s+public\.enrollment_submissions\s*\(\s*id\s*\)([^,\n]*)/gi)]
        // domanda_da_associare (scheda) e domanda_id (bambino)
        expect(tutte.length).toBeGreaterThanOrEqual(2)
        for (const m of tutte) expect(m[1]).toMatch(/on\s+delete\s+set\s+null/i)
    })

    it('è dichiarata in MIGRAZIONI_ATTESE_AL_MERGE', () => {
        expect(Object.keys(MIGRAZIONI_ATTESE_AL_MERGE)).toContain(NOME_FILE)
        expect(MIGRAZIONI_ATTESE_AL_MERGE[NOME_FILE]).toMatch(/integrazione/i)
    })

    it('niente uuid di sede cablato e niente dati personali', () => {
        expect(SQL_GREZZO).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)
    })
})

// ─── la migrazione ESEGUITA ───────────────────────────────────────────────────

const SEDE_A = '00000000-0000-4000-8000-0000000000a1'
const SEDE_B = '00000000-0000-4000-8000-0000000000b1'
const UTENTE_1 = '00000000-0000-4000-8000-0000000000c1'
const UTENTE_2 = '00000000-0000-4000-8000-0000000000c2'
const DOMANDA_1 = '00000000-0000-4000-8000-0000000000d1'
const DOMANDA_2 = '00000000-0000-4000-8000-0000000000d2'
const SCHEDA_A = '00000000-0000-4000-8000-0000000000e1'
const SCHEDA_A2 = '00000000-0000-4000-8000-0000000000e2'

let db: PGlite

type PgErr = { code?: string; message: string }

async function errore(sql: string): Promise<PgErr | null> {
    try {
        await db.exec(sql)
        return null
    } catch (e) {
        return e as PgErr
    }
}

async function numero(sql: string): Promise<number> {
    const { rows } = await db.query<{ n: number }>(`SELECT (${sql})::int AS n`)
    return rows[0].n
}

beforeAll(async () => {
    db = new PGlite({ extensions: { btree_gist } })
    // Lo schema MINIMO che la migrazione presuppone: le tre tabelle a cui punta e lo schema `extensions`.
    await db.exec(`
    CREATE SCHEMA IF NOT EXISTS extensions;
    CREATE TABLE public.schools (id uuid PRIMARY KEY);
    CREATE TABLE public.utenti (id uuid PRIMARY KEY);
    CREATE TABLE public.enrollment_submissions (id uuid PRIMARY KEY);
    INSERT INTO public.schools VALUES ('${SEDE_A}'), ('${SEDE_B}');
    INSERT INTO public.utenti VALUES ('${UTENTE_1}'), ('${UTENTE_2}');
    INSERT INTO public.enrollment_submissions VALUES ('${DOMANDA_1}'), ('${DOMANDA_2}');
  `)
    // DUE volte: la seconda è la prova dell'idempotenza (nessun errore, nessun doppione)
    await db.exec(SQL_GREZZO)
    await db.exec(SQL_GREZZO)
    await db.exec(`
    INSERT INTO public.crm_schede (id, scuola_id, genitore_nome, origine)
    VALUES ('${SCHEDA_A}', '${SEDE_A}', 'Famiglia Prova', 'telefonata'),
           ('${SCHEDA_A2}', '${SEDE_A}', 'Famiglia Prova Due', 'sito');
  `)
}, 60_000)

afterAll(async () => {
    await db.close()
})

const appuntamento = (inizio: string, fine: string, stato = 'in_programma', utente = UTENTE_1) =>
    `INSERT INTO public.crm_appuntamenti (scheda_id, scuola_id, inizio, fine, assegnata_a, stato)
     VALUES ('${SCHEDA_A}', '${SEDE_A}', '${inizio}', '${fine}', '${utente}', '${stato}');`

describe('migrazione CRM · eseguita su Postgres', () => {
    it('le sette tabelle esistono, con la RLS accesa e nessuna policy', async () => {
        const { rows } = await db.query<{ relname: string; relrowsecurity: boolean }>(
            `SELECT c.relname, c.relrowsecurity FROM pg_class c
               JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'crm\\_%'
              ORDER BY c.relname`,
        )
        expect(rows.map((r) => r.relname)).toEqual([...TABELLE])
        expect(rows.every((r) => r.relrowsecurity)).toBe(true)
        expect(await numero(`(SELECT count(*) FROM pg_policies WHERE tablename LIKE 'crm\\_%')`)).toBe(0)
    })

    it('due appuntamenti sovrapposti per la stessa persona: 23P01', async () => {
        await db.exec(appuntamento('2026-11-10 09:00+01', '2026-11-10 09:45+01'))
        const e = await errore(appuntamento('2026-11-10 09:30+01', '2026-11-10 10:15+01'))
        expect(e?.code).toBe('23P01')
    })

    it('adiacenti, o di un’altra persona, o non più in programma: nessun conflitto', async () => {
        // adiacente: la fine di uno è l'inizio dell'altro (intervallo semiaperto)
        expect(await errore(appuntamento('2026-11-10 09:45+01', '2026-11-10 10:30+01'))).toBeNull()
        // stessa ora, altra persona
        expect(await errore(appuntamento('2026-11-10 09:00+01', '2026-11-10 09:45+01', 'in_programma', UTENTE_2))).toBeNull()
        // sovrapposto ma annullato: non blocca
        expect(await errore(appuntamento('2026-11-10 09:00+01', '2026-11-10 09:45+01', 'annullato'))).toBeNull()
    })

    it('uno slot liberato dall’annullamento si può rioccupare', async () => {
        await db.exec(appuntamento('2026-11-11 09:00+01', '2026-11-11 09:45+01'))
        await db.exec(
            `UPDATE public.crm_appuntamenti SET stato = 'annullato'
              WHERE inizio = '2026-11-11 09:00+01' AND assegnata_a = '${UTENTE_1}'`,
        )
        expect(await errore(appuntamento('2026-11-11 09:00+01', '2026-11-11 09:45+01'))).toBeNull()
    })

    it('fine non dopo inizio, o durata fuori da 15–240 minuti: 23514', async () => {
        const fine = await errore(appuntamento('2026-11-12 09:00+01', '2026-11-12 09:00+01'))
        expect(fine?.code).toBe('23514')
        const durata = await errore(
            `INSERT INTO public.crm_appuntamenti (scheda_id, scuola_id, inizio, fine, durata_min, assegnata_a)
             VALUES ('${SCHEDA_A}', '${SEDE_A}', '2026-11-12 09:00+01', '2026-11-12 09:45+01', 5, '${UTENTE_1}');`,
        )
        expect(durata?.code).toBe('23514')
    })

    it('un figlio non può dichiarare una sede diversa da quella della sua scheda: 23503', async () => {
        const e = await errore(
            `INSERT INTO public.crm_bambini (scheda_id, scuola_id, nome) VALUES ('${SCHEDA_A}', '${SEDE_B}', 'Bimbo Prova');`,
        )
        expect(e?.code).toBe('23503')
        const ev = await errore(
            `INSERT INTO public.crm_eventi (scheda_id, scuola_id, tipo, autore_via)
             VALUES ('${SCHEDA_A}', '${SEDE_B}', 'creata', 'segreteria');`,
        )
        expect(ev?.code).toBe('23503')
    })

    it('un valore fuori vocabolario è rifiutato dal CHECK: 23514', async () => {
        const origine = await errore(
            `INSERT INTO public.crm_schede (scuola_id, genitore_nome, origine) VALUES ('${SEDE_A}', 'Famiglia Prova', 'piccione');`,
        )
        expect(origine?.code).toBe('23514')
        const esito = await errore(
            `INSERT INTO public.crm_bambini (scheda_id, scuola_id, esito) VALUES ('${SCHEDA_A}', '${SEDE_A}', 'forse');`,
        )
        expect(esito?.code).toBe('23514')
        const tipo = await errore(
            `INSERT INTO public.crm_eventi (scheda_id, scuola_id, tipo, autore_via) VALUES ('${SCHEDA_A}', '${SEDE_A}', 'inventato', 'segreteria');`,
        )
        expect(tipo?.code).toBe('23514')
    })

    it('la stessa domanda non può essere collegata due volte allo stesso figlio della domanda: 23505', async () => {
        await db.exec(
            `INSERT INTO public.crm_bambini (scheda_id, scuola_id, domanda_id, domanda_figlio) VALUES ('${SCHEDA_A}', '${SEDE_A}', '${DOMANDA_1}', 1);`,
        )
        const e = await errore(
            `INSERT INTO public.crm_bambini (scheda_id, scuola_id, domanda_id, domanda_figlio) VALUES ('${SCHEDA_A2}', '${SEDE_A}', '${DOMANDA_1}', 1);`,
        )
        expect(e?.code).toBe('23505')
        // un altro figlio della stessa domanda va bene
        expect(
            await errore(
                `INSERT INTO public.crm_bambini (scheda_id, scuola_id, domanda_id, domanda_figlio) VALUES ('${SCHEDA_A2}', '${SEDE_A}', '${DOMANDA_1}', 2);`,
            ),
        ).toBeNull()
    })

    it('se la domanda sparisce, il collegamento si scioglie e la scheda resta (SET NULL)', async () => {
        await db.exec(
            `INSERT INTO public.crm_bambini (scheda_id, scuola_id, domanda_id, domanda_figlio) VALUES ('${SCHEDA_A}', '${SEDE_A}', '${DOMANDA_2}', 1);
             UPDATE public.crm_schede SET domanda_da_associare = '${DOMANDA_2}' WHERE id = '${SCHEDA_A2}';`,
        )
        await db.exec(`DELETE FROM public.enrollment_submissions WHERE id = '${DOMANDA_2}';`)
        expect(await numero(`(SELECT count(*) FROM public.crm_bambini WHERE domanda_id = '${DOMANDA_2}')`)).toBe(0)
        expect(
            await numero(`(SELECT count(*) FROM public.crm_bambini WHERE scheda_id = '${SCHEDA_A}' AND domanda_id IS NULL)`),
        ).toBeGreaterThan(0)
        expect(
            await numero(`(SELECT count(*) FROM public.crm_schede WHERE id = '${SCHEDA_A2}' AND domanda_da_associare IS NULL)`),
        ).toBe(1)
    })

    it('eliminare la scheda porta via figli, appuntamenti, azioni e storico (CASCADE)', async () => {
        await db.exec(`
      INSERT INTO public.crm_eventi (scheda_id, scuola_id, tipo, autore_via) VALUES ('${SCHEDA_A2}', '${SEDE_A}', 'creata', 'sistema');
      INSERT INTO public.crm_azioni (scheda_id, scuola_id, tipo, scadenza, responsabile)
        VALUES ('${SCHEDA_A2}', '${SEDE_A}', 'follow_up_1', '2026-11-20 10:30+01', '${UTENTE_1}');
      DELETE FROM public.crm_schede WHERE id = '${SCHEDA_A2}';
    `)
        for (const t of ['crm_bambini', 'crm_appuntamenti', 'crm_azioni', 'crm_eventi']) {
            expect(await numero(`(SELECT count(*) FROM public.${t} WHERE scheda_id = '${SCHEDA_A2}')`), t).toBe(0)
        }
    })

    it('disponibilità e indisponibilità hanno i loro CHECK', async () => {
        const giorno = await errore(
            `INSERT INTO public.crm_disponibilita (scuola_id, utente_id, giorno_settimana, ora_inizio, ora_fine)
             VALUES ('${SEDE_A}', '${UTENTE_1}', 8, '09:00', '12:00');`,
        )
        expect(giorno?.code).toBe('23514')
        const ore = await errore(
            `INSERT INTO public.crm_disponibilita (scuola_id, utente_id, giorno_settimana, ora_inizio, ora_fine)
             VALUES ('${SEDE_A}', '${UTENTE_1}', 1, '12:00', '09:00');`,
        )
        expect(ore?.code).toBe('23514')
        expect(
            await errore(
                `INSERT INTO public.crm_disponibilita (scuola_id, utente_id, giorno_settimana, ora_inizio, ora_fine)
                 VALUES ('${SEDE_A}', '${UTENTE_1}', 1, '09:00', '12:00');`,
            ),
        ).toBeNull()
        const al = await errore(
            `INSERT INTO public.crm_indisponibilita (scuola_id, utente_id, dal, al, motivo)
             VALUES ('${SEDE_A}', NULL, '2026-12-24 00:00+01', '2026-12-24 00:00+01', 'chiusura');`,
        )
        expect(al?.code).toBe('23514')
        // utente_id nullo = tutta la sede
        expect(
            await errore(
                `INSERT INTO public.crm_indisponibilita (scuola_id, utente_id, dal, al, motivo)
                 VALUES ('${SEDE_A}', NULL, '2026-12-24 00:00+01', '2026-12-27 00:00+01', 'chiusura');`,
            ),
        ).toBeNull()
    })
})
