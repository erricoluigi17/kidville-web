// @vitest-environment node

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { MIGRAZIONI_ATTESE_AL_MERGE, senzaCommenti } from '../../architecture/soglia-fotografia'

/**
 * VOTAZIONI DEI RAPPRESENTANTI · LA MIGRAZIONE.
 *
 * Due letture dello stesso file, perché una sola non basta:
 *
 *  1. TESTUALE — il file `supabase/migrations/<UTC>_votazioni_rappresentanti.sql` ha la forma che il
 *     resto del sistema presuppone: quattro tabelle `votazioni*`, ognuna con `scuola_id` e RLS accesa
 *     SENZA policy (le legge solo il service-role, dopo il gate dell'applicazione), le figlie agganciate
 *     alla testata con la chiave COMPOSTA `(votazione_id, scuola_id)`, nessuna cancellazione.
 *  2. ESEGUITA — lo stesso file applicato DUE volte su un Postgres vero (PGlite, in memoria): la seconda
 *     è la prova dell'idempotenza, e i vincoli che la lettura del testo non può provare (l'unicità del
 *     voto che regge anche con `section_id` nullo, la chiave composta che impedisce a un voto di
 *     dichiarare un'altra sede, i CHECK, `CASCADE`) vengono messi alla prova con righe finte.
 *
 * ⚠️ PGlite è PostgreSQL 18, la produzione è PostgreSQL 17. `UNIQUE NULLS NOT DISTINCT` esiste dalla 15:
 * qui si provano vincoli che non cambiano fra le due versioni.
 *
 * Solo dati finti: uuid inventati, nessuna anagrafica.
 */

const CARTELLA = join(process.cwd(), 'supabase', 'migrations')

const TABELLE = ['votazioni', 'votazioni_candidati', 'votazioni_classi', 'votazioni_voti'] as const

const FIGLIE = ['votazioni_classi', 'votazioni_candidati', 'votazioni_voti'] as const

const FILE = readdirSync(CARTELLA).filter((f) => /^\d{14}_votazioni_rappresentanti\.sql$/.test(f))
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

describe('migrazione votazioni · forma del file', () => {
    it('esiste un solo file *_votazioni_rappresentanti.sql', () => {
        expect(FILE).toHaveLength(1)
    })

    it('crea le quattro tabelle votazioni*', () => {
        const trovate = Object.keys(corpiDelleTabelle(SQL))
            .filter((t) => t.startsWith('votazioni'))
            .sort()
        expect(trovate).toEqual([...TABELLE])
    })

    it('ogni tabella ha scuola_id con FK a schools, RLS attiva e il suo commento', () => {
        const corpi = corpiDelleTabelle(SQL)
        for (const t of TABELLE) {
            expect(corpi[t], `${t} manca`).toBeDefined()
            expect(corpi[t], `${t}: scuola_id uuid not null references public.schools(id)`).toMatch(
                /\bscuola_id\s+uuid\s+not\s+null\s+references\s+public\.schools\s*\(\s*id\s*\)/i,
            )
            expect(SQL, `${t}: enable row level security`).toMatch(
                new RegExp(`alter\\s+table\\s+(?:if\\s+exists\\s+)?public\\.${t}\\s+enable\\s+row\\s+level\\s+security`, 'i'),
            )
            expect(SQL, `${t}: comment on table`).toMatch(new RegExp(`comment\\s+on\\s+table\\s+public\\.${t}\\s+is\\s+'`, 'i'))
            expect(SQL, `${t}: revoke all`).toMatch(
                new RegExp(`revoke\\s+all\\s+on\\s+table\\s+public\\.${t}\\s+from\\s+public\\s*,\\s*anon\\s*,\\s*authenticated`, 'i'),
            )
            expect(SQL, `${t}: grant al solo service_role`).toMatch(
                new RegExp(
                    `grant\\s+select\\s*,\\s*insert\\s*,\\s*update\\s*,\\s*delete\\s+on\\s+table\\s+public\\.${t}\\s+to\\s+service_role`,
                    'i',
                ),
            )
        }
        // la testata e `votazioni_voti` hanno una chiave surrogata
        for (const t of ['votazioni', 'votazioni_voti']) {
            expect(corpi[t], `${t}: chiave primaria`).toMatch(/\bid\s+uuid\s+primary\s+key\s+default\s+gen_random_uuid\(\)/i)
        }
    })

    it('nessuna create policy, nessuna funzione che scavalca la RLS, nessun trigger', () => {
        expect(SQL).not.toMatch(/create\s+policy/i)
        expect(SQL).not.toMatch(/security\s+definer/i)
        expect(SQL).not.toMatch(/create\s+(or\s+replace\s+)?trigger/i)
    })

    it('le figlie hanno la FK composta (votazione_id, scuola_id) con ON DELETE CASCADE', () => {
        const corpi = corpiDelleTabelle(SQL)
        expect(corpi.votazioni).toMatch(/unique\s*\(\s*id\s*,\s*scuola_id\s*\)/i)
        for (const t of FIGLIE) {
            expect(corpi[t], `${t}: votazione_id uuid not null`).toMatch(/\bvotazione_id\s+uuid\s+not\s+null\b/i)
            expect(corpi[t], `${t}: foreign key composta`).toMatch(
                /foreign\s+key\s*\(\s*votazione_id\s*,\s*scuola_id\s*\)\s*references\s+public\.votazioni\s*\(\s*id\s*,\s*scuola_id\s*\)\s*on\s+delete\s+cascade/i,
            )
        }
    })

    it('votazioni_voti: ambito vincolato, CHECK ambito/section_id, UNIQUE NULLS NOT DISTINCT', () => {
        const corpo = corpiDelleTabelle(SQL).votazioni_voti
        expect(corpo).toMatch(/check\s*\(\s*ambito\s+in\s*\(\s*'classe'\s*,\s*'istituto'\s*\)\s*\)/i)
        expect(corpo).toMatch(/check\s*\(\s*\(\s*ambito\s*=\s*'classe'\s*\)\s*=\s*\(\s*section_id\s+is\s+not\s+null\s*\)\s*\)/i)
        expect(corpo).toMatch(
            /unique\s+nulls\s+not\s+distinct\s*\(\s*votazione_id\s*,\s*ambito\s*,\s*section_id\s*,\s*elettore_id\s*\)/i,
        )
    })

    it('la migrazione non distrugge niente: nessun DROP, nessun DELETE FROM, nessun TRUNCATE', () => {
        expect(SQL).not.toMatch(/\bdrop\s+(table|column|constraint|index|schema|policy|function|trigger)\b/i)
        expect(SQL).not.toMatch(/\bdelete\s+from\b/i)
        expect(SQL).not.toMatch(/\btruncate\b/i)
    })

    it('è idempotente nella forma: ogni CREATE ha il suo IF NOT EXISTS', () => {
        expect(SQL).not.toMatch(/create\s+table\s+(?!if\s+not\s+exists)/i)
        expect(SQL).not.toMatch(/create\s+(unique\s+)?index\s+(?!if\s+not\s+exists)/i)
    })

    it('una FK per ogni colonna che punta fuori ha un indice che comincia da quella colonna', () => {
        // Il lock `fk-nuove-con-indice` lo misura sull'intero repo; qui si nominano gli indici attesi,
        // così un indice tolto dal file fa cadere QUESTO test con un messaggio che dice quale.
        const attesi: [string, string][] = [
            ['votazioni', 'scuola_id'],
            ['votazioni', 'creata_da'],
            ['votazioni', 'aggiornata_da'],
            ['votazioni_classi', 'scuola_id'],
            ['votazioni_classi', 'section_id'],
            ['votazioni_candidati', 'scuola_id'],
            ['votazioni_candidati', 'utente_id'],
            ['votazioni_voti', 'votazione_id'],
            ['votazioni_voti', 'scuola_id'],
            ['votazioni_voti', 'section_id'],
            ['votazioni_voti', 'elettore_id'],
            ['votazioni_voti', 'candidato_id'],
        ]
        for (const [tabella, colonna] of attesi) {
            expect(SQL, `manca un indice su ${tabella} (${colonna}, …)`).toMatch(
                new RegExp(`create\\s+index\\s+if\\s+not\\s+exists\\s+\\w+\\s+on\\s+public\\.${tabella}\\s*\\(\\s*${colonna}\\b`, 'i'),
            )
        }
        // la FK composta delle figlie ha il suo indice (votazione_id, scuola_id), non solo la PK/UNIQUE che
        // comincia da votazione_id: l'advisor Supabase chiede che le colonne della FK stiano in testa
        for (const t of FIGLIE) {
            expect(SQL, `${t}: manca l'indice (votazione_id, scuola_id)`).toMatch(
                new RegExp(
                    `create\\s+index\\s+if\\s+not\\s+exists\\s+\\w+\\s+on\\s+public\\.${t}\\s*\\(\\s*votazione_id\\s*,\\s*scuola_id\\s*\\)`,
                    'i',
                ),
            )
        }
        // l'elenco per sede e scadenza della segreteria
        expect(SQL).toMatch(
            /create\s+index\s+if\s+not\s+exists\s+\w+\s+on\s+public\.votazioni\s*\(\s*scuola_id\s*,\s*scadenza\s*\)/i,
        )
    })

    it("è dichiarata fra le attese al merge, oppure è già nella fotografia delle migrazioni (mai nessuna delle due)", () => {
        // Fino al merge la applica l'integrazione e la si dichiara in MIGRAZIONI_ATTESE_AL_MERGE; dopo la
        // PR-B sta nella fotografia delle migrazioni, una riga sola e con la version del file. Questo
        // test regge entrambi gli stati, così la PR-B non deve riscriverlo (la prova gemella 2 di
        // `soglia-fotografia` impone già di svuotare la voce).
        const foto = JSON.parse(
            readFileSync(join(process.cwd(), '__tests__', 'fixtures', 'migrazioni-applicate-snapshot.json'), 'utf8'),
        ) as { migrazioni: { version: string; name: string }[] }
        const righe = foto.migrazioni.filter((m) => m.name === 'votazioni_rappresentanti')
        const dichiarata = Object.keys(MIGRAZIONI_ATTESE_AL_MERGE).includes(NOME_FILE)
        const applicata = righe.length > 0
        expect(dichiarata || applicata, 'né dichiarata attesa al merge né applicata').toBe(true)
        expect(dichiarata && applicata, 'dichiarata attesa E già applicata: togli la voce (PR-B)').toBe(false)
        if (applicata) expect(righe.map((m) => m.version)).toEqual([NOME_FILE.slice(0, 14)])
    })

    it('niente uuid di sede cablato e niente dati personali', () => {
        expect(SQL_GREZZO).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)
    })
})

// ─── la migrazione ESEGUITA ───────────────────────────────────────────────────

const SEDE_A = '00000000-0000-4000-8000-0000000000a1'
const SEDE_B = '00000000-0000-4000-8000-0000000000b1'
const CLASSE_1 = '00000000-0000-4000-8000-0000000000f1'
const CLASSE_2 = '00000000-0000-4000-8000-0000000000f2'
const UTENTE_1 = '00000000-0000-4000-8000-0000000000c1'
const UTENTE_2 = '00000000-0000-4000-8000-0000000000c2'
const UTENTE_3 = '00000000-0000-4000-8000-0000000000c3'
const VOTAZIONE_1 = '00000000-0000-4000-8000-0000000000e1'
const VOTAZIONE_2 = '00000000-0000-4000-8000-0000000000e2'

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
    db = new PGlite()
    // Lo schema MINIMO che la migrazione presuppone: le tre tabelle a cui punta e i tre ruoli di Supabase.
    await db.exec(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
    CREATE TABLE public.schools (id uuid PRIMARY KEY);
    CREATE TABLE public.utenti (id uuid PRIMARY KEY);
    CREATE TABLE public.sections (id uuid PRIMARY KEY);
    INSERT INTO public.schools VALUES ('${SEDE_A}'), ('${SEDE_B}');
    INSERT INTO public.utenti VALUES ('${UTENTE_1}'), ('${UTENTE_2}'), ('${UTENTE_3}');
    INSERT INTO public.sections VALUES ('${CLASSE_1}'), ('${CLASSE_2}');
  `)
    // DUE volte: la seconda è la prova dell'idempotenza (nessun errore, nessun doppione)
    await db.exec(SQL_GREZZO)
    await db.exec(SQL_GREZZO)
    await db.exec(`
    INSERT INTO public.votazioni (id, scuola_id, titolo, scadenza, rappresentante_istituto, creata_da)
    VALUES ('${VOTAZIONE_1}', '${SEDE_A}', 'Elezione di prova', now() + interval '7 days', true, '${UTENTE_1}'),
           ('${VOTAZIONE_2}', '${SEDE_A}', 'Elezione da cancellare', now() + interval '7 days', true, '${UTENTE_1}');
  `)
}, 60_000)

afterAll(async () => {
    await db.close()
})

const votoClasse = (elettore: string, candidato: string, sezione = CLASSE_1, votazione = VOTAZIONE_1, sede = SEDE_A) =>
    `INSERT INTO public.votazioni_voti (votazione_id, scuola_id, ambito, section_id, elettore_id, candidato_id)
     VALUES ('${votazione}', '${sede}', 'classe', '${sezione}', '${elettore}', '${candidato}');`

const votoIstituto = (elettore: string, candidato: string, votazione = VOTAZIONE_1, sede = SEDE_A) =>
    `INSERT INTO public.votazioni_voti (votazione_id, scuola_id, ambito, section_id, elettore_id, candidato_id)
     VALUES ('${votazione}', '${sede}', 'istituto', NULL, '${elettore}', '${candidato}');`

describe('migrazione votazioni · eseguita su Postgres', () => {
    it('le quattro tabelle esistono, con la RLS accesa e nessuna policy', async () => {
        const { rows } = await db.query<{ relname: string; relrowsecurity: boolean }>(
            `SELECT c.relname, c.relrowsecurity FROM pg_class c
               JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'votazioni%'
              ORDER BY c.relname`,
        )
        expect(rows.map((r) => r.relname)).toEqual([...TABELLE])
        expect(rows.every((r) => r.relrowsecurity)).toBe(true)
        expect(await numero(`(SELECT count(*) FROM pg_policies WHERE tablename LIKE 'votazioni%')`)).toBe(0)
    })

    it('applicata due volte: nessun oggetto doppio (4 tabelle, nessun indice ripetuto per nome)', async () => {
        expect(
            await numero(`(SELECT count(*) FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'votazioni%')`),
        ).toBe(4)
        expect(
            await numero(
                `(SELECT count(*) FROM (SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename LIKE 'votazioni%'
                                         GROUP BY indexname HAVING count(*) > 1) d)`,
            ),
        ).toBe(0)
    })

    it('anon e authenticated non hanno nessun privilegio, service_role ha tutti e quattro', async () => {
        for (const t of TABELLE) {
            for (const ruolo of ['anon', 'authenticated']) {
                for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
                    const { rows } = await db.query<{ ok: boolean }>(`SELECT has_table_privilege('${ruolo}', 'public.${t}', '${p}') AS ok`)
                    expect(rows[0].ok, `${ruolo} ha ${p} su ${t}`).toBe(false)
                }
            }
            for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
                const { rows } = await db.query<{ ok: boolean }>(`SELECT has_table_privilege('service_role', 'public.${t}', '${p}') AS ok`)
                expect(rows[0].ok, `service_role non ha ${p} su ${t}`).toBe(true)
            }
        }
    })

    it('ogni FK ha un indice che comincia dalla sua colonna, compreso (votazione_id, scuola_id)', async () => {
        const { rows } = await db.query<{ tablename: string; indexdef: string }>(
            `SELECT tablename, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename LIKE 'votazioni%'`,
        )
        const primaColonna = (def: string) => /\(\s*"?(\w+)"?/.exec(def.slice(def.indexOf('(')))?.[1]
        const coperte = new Set(rows.map((r) => `${r.tablename}.${primaColonna(r.indexdef)}`))
        const fk = await db.query<{ tabella: string; colonna: string }>(
            `SELECT c.conrelid::regclass::text AS tabella, a.attname AS colonna
               FROM pg_constraint c
               JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
              WHERE c.contype = 'f' AND c.conrelid::regclass::text LIKE 'votazioni%'`,
        )
        expect(fk.rows.length).toBeGreaterThan(8)
        const scoperte = fk.rows.filter((f) => !coperte.has(`${f.tabella.replace(/^public\./, '')}.${f.colonna}`))
        expect(scoperte).toEqual([])
        // la FK composta: per le tre figlie un indice con (votazione_id, scuola_id) in testa, in quest'ordine
        const { rows: composti } = await db.query<{ tabella: string }>(
            `SELECT c.relname AS tabella
               FROM pg_index i
               JOIN pg_class c ON c.oid = i.indrelid
               JOIN pg_attribute a1 ON a1.attrelid = c.oid AND a1.attnum = i.indkey[0]
               JOIN pg_attribute a2 ON a2.attrelid = c.oid AND a2.attnum = i.indkey[1]
              WHERE c.relname LIKE 'votazioni%' AND a1.attname = 'votazione_id' AND a2.attname = 'scuola_id'`,
        )
        for (const t of FIGLIE) {
            expect(
                composti.some((r) => r.tabella === t),
                `${t}: manca un indice che parte da (votazione_id, scuola_id)`,
            ).toBe(true)
        }
    })

    it('due voti di classe dello stesso elettore sulla stessa classe: 23505', async () => {
        await db.exec(votoClasse(UTENTE_2, UTENTE_1))
        const e = await errore(votoClasse(UTENTE_2, UTENTE_3))
        expect(e?.code).toBe('23505')
    })

    it('lo stesso elettore vota in un’altra classe, o un altro elettore nella stessa: nessun conflitto', async () => {
        expect(await errore(votoClasse(UTENTE_2, UTENTE_1, CLASSE_2))).toBeNull()
        expect(await errore(votoClasse(UTENTE_3, UTENTE_1, CLASSE_1))).toBeNull()
    })

    it('due voti d’istituto dello stesso elettore: 23505 (prova NULLS NOT DISTINCT, section_id è nullo)', async () => {
        await db.exec(votoIstituto(UTENTE_2, UTENTE_1))
        const e = await errore(votoIstituto(UTENTE_2, UTENTE_3))
        expect(e?.code).toBe('23505')
        // un altro elettore, o la stessa persona su un’altra votazione, vanno bene
        expect(await errore(votoIstituto(UTENTE_3, UTENTE_1))).toBeNull()
    })

    it('un voto di classe con section_id nullo, o d’istituto con section_id: 23514', async () => {
        const senzaClasse = await errore(
            `INSERT INTO public.votazioni_voti (votazione_id, scuola_id, ambito, section_id, elettore_id, candidato_id)
             VALUES ('${VOTAZIONE_1}', '${SEDE_A}', 'classe', NULL, '${UTENTE_1}', '${UTENTE_2}');`,
        )
        expect(senzaClasse?.code).toBe('23514')
        const istitutoConClasse = await errore(
            `INSERT INTO public.votazioni_voti (votazione_id, scuola_id, ambito, section_id, elettore_id, candidato_id)
             VALUES ('${VOTAZIONE_1}', '${SEDE_A}', 'istituto', '${CLASSE_1}', '${UTENTE_1}', '${UTENTE_2}');`,
        )
        expect(istitutoConClasse?.code).toBe('23514')
    })

    it('un ambito fuori vocabolario è rifiutato dal CHECK: 23514', async () => {
        const e = await errore(
            `INSERT INTO public.votazioni_voti (votazione_id, scuola_id, ambito, section_id, elettore_id, candidato_id)
             VALUES ('${VOTAZIONE_1}', '${SEDE_A}', 'plesso', NULL, '${UTENTE_1}', '${UTENTE_2}');`,
        )
        expect(e?.code).toBe('23514')
    })

    it('un voto che dichiara una sede diversa da quella della votazione: 23503 (FK composta)', async () => {
        const e = await errore(votoClasse(UTENTE_1, UTENTE_2, CLASSE_1, VOTAZIONE_1, SEDE_B))
        expect(e?.code).toBe('23503')
        const i = await errore(votoIstituto(UTENTE_1, UTENTE_2, VOTAZIONE_1, SEDE_B))
        expect(i?.code).toBe('23503')
    })

    it('classi e candidati di una sede diversa da quella della votazione: 23503', async () => {
        const classe = await errore(
            `INSERT INTO public.votazioni_classi (votazione_id, scuola_id, section_id) VALUES ('${VOTAZIONE_1}', '${SEDE_B}', '${CLASSE_1}');`,
        )
        expect(classe?.code).toBe('23503')
        const candidato = await errore(
            `INSERT INTO public.votazioni_candidati (votazione_id, scuola_id, utente_id) VALUES ('${VOTAZIONE_1}', '${SEDE_B}', '${UTENTE_1}');`,
        )
        expect(candidato?.code).toBe('23503')
    })

    it('la stessa classe o lo stesso candidato due volte nella stessa votazione: 23505', async () => {
        await db.exec(`INSERT INTO public.votazioni_classi (votazione_id, scuola_id, section_id) VALUES ('${VOTAZIONE_1}', '${SEDE_A}', '${CLASSE_1}');`)
        const classe = await errore(
            `INSERT INTO public.votazioni_classi (votazione_id, scuola_id, section_id) VALUES ('${VOTAZIONE_1}', '${SEDE_A}', '${CLASSE_1}');`,
        )
        expect(classe?.code).toBe('23505')
        await db.exec(`INSERT INTO public.votazioni_candidati (votazione_id, scuola_id, utente_id) VALUES ('${VOTAZIONE_1}', '${SEDE_A}', '${UTENTE_1}');`)
        const candidato = await errore(
            `INSERT INTO public.votazioni_candidati (votazione_id, scuola_id, utente_id) VALUES ('${VOTAZIONE_1}', '${SEDE_A}', '${UTENTE_1}');`,
        )
        expect(candidato?.code).toBe('23505')
    })

    it('titolo vuoto, di soli spazi o oltre 120 caratteri: 23514; a 120 va bene', async () => {
        const nuova = (titolo: string) =>
            `INSERT INTO public.votazioni (scuola_id, titolo, scadenza, creata_da)
             VALUES ('${SEDE_A}', '${titolo}', now() + interval '1 day', '${UTENTE_1}');`
        expect((await errore(nuova('')))?.code).toBe('23514')
        expect((await errore(nuova('   ')))?.code).toBe('23514')
        expect((await errore(nuova('x'.repeat(121))))?.code).toBe('23514')
        expect(await errore(nuova('x'.repeat(120)))).toBeNull()
    })

    it('una votazione senza autore o con autore inesistente non si crea: 23502 / 23503', async () => {
        const senza = await errore(
            `INSERT INTO public.votazioni (scuola_id, titolo, scadenza) VALUES ('${SEDE_A}', 'Senza autore', now() + interval '1 day');`,
        )
        expect(senza?.code).toBe('23502')
        const inesistente = await errore(
            `INSERT INTO public.votazioni (scuola_id, titolo, scadenza, creata_da)
             VALUES ('${SEDE_A}', 'Autore fantasma', now() + interval '1 day', '00000000-0000-4000-8000-00000000ffff');`,
        )
        expect(inesistente?.code).toBe('23503')
    })

    it('i default: rappresentante_istituto falso, chiusa_il e aggiornata_* nulli, creata_il valorizzata', async () => {
        await db.exec(
            `INSERT INTO public.votazioni (id, scuola_id, titolo, scadenza, creata_da)
             VALUES ('00000000-0000-4000-8000-0000000000e9', '${SEDE_A}', 'Solo classe', now() + interval '1 day', '${UTENTE_1}');`,
        )
        const { rows } = await db.query<{ ri: boolean; ch: string | null; ag: string | null; ai: string | null; cr: string | null }>(
            `SELECT rappresentante_istituto AS ri, chiusa_il AS ch, aggiornata_da AS ag, aggiornata_il AS ai, creata_il AS cr
               FROM public.votazioni WHERE id = '00000000-0000-4000-8000-0000000000e9'`,
        )
        expect(rows[0].ri).toBe(false)
        expect(rows[0].ch).toBeNull()
        expect(rows[0].ag).toBeNull()
        expect(rows[0].ai).toBeNull()
        expect(rows[0].cr).not.toBeNull()
    })

    it('un utente con righe di votazioni non si cancella (le FK verso utenti non hanno ON DELETE)', async () => {
        const e = await errore(`DELETE FROM public.utenti WHERE id = '${UTENTE_1}';`)
        expect(e?.code).toBe('23503')
    })

    it('eliminare la votazione porta via classi, candidati e voti (CASCADE)', async () => {
        await db.exec(`
      INSERT INTO public.votazioni_classi (votazione_id, scuola_id, section_id) VALUES ('${VOTAZIONE_2}', '${SEDE_A}', '${CLASSE_1}');
      INSERT INTO public.votazioni_candidati (votazione_id, scuola_id, utente_id) VALUES ('${VOTAZIONE_2}', '${SEDE_A}', '${UTENTE_2}');
      ${votoClasse(UTENTE_3, UTENTE_2, CLASSE_1, VOTAZIONE_2)}
      ${votoIstituto(UTENTE_3, UTENTE_2, VOTAZIONE_2)}
    `)
        for (const t of FIGLIE) {
            expect(await numero(`(SELECT count(*) FROM public.${t} WHERE votazione_id = '${VOTAZIONE_2}')`), `${t} prima`).toBeGreaterThan(0)
        }
        await db.exec(`DELETE FROM public.votazioni WHERE id = '${VOTAZIONE_2}';`)
        for (const t of FIGLIE) {
            expect(await numero(`(SELECT count(*) FROM public.${t} WHERE votazione_id = '${VOTAZIONE_2}')`), `${t} dopo`).toBe(0)
        }
        // e la prima votazione non è stata toccata
        expect(await numero(`(SELECT count(*) FROM public.votazioni_voti WHERE votazione_id = '${VOTAZIONE_1}')`)).toBeGreaterThan(0)
    })
})
