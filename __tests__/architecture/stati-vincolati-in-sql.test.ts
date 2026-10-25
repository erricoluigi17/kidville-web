import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { STATI_DOMANDA } from '@/lib/iscrizioni/stati'
import { STATI_NON_PIU_ISCRITTO, STATI_TENDINA } from '@/lib/alunni/stato'

// =============================================================================
// GLI STATI SONO UNA REGOLA IN DUE LINGUAGGI — robustezza 2, sessione 1 (D11).
//
// Dal 2026-10-24 `enrollment_submissions.status` e `alunni.stato` hanno un
// CHECK. In TypeScript le stesse liste sono `STATI_DOMANDA` e `STATI_TENDINA`. L'SQL non può
// importare un modulo TS, e due copie che nessuno confronta divergono:
//  · uno stato aggiunto al codice e non al CHECK fa fallire la scrittura in produzione
//    (23514) proprio sulla schermata che lo usa;
//  · uno stato aggiunto al CHECK e non al codice non si può più scegliere, e nessuno
//    se ne accorge.
// Si legge l'ULTIMO `ADD CONSTRAINT <nome> CHECK (<colonna> IN (…))` delle migrazioni,
// senza i commenti: la testata della migrazione cita i valori per spiegarli, e un lock che
// li leggesse lì direbbe «allineato» leggendo una spiegazione.
//
// C'è una TERZA copia della lista, nello stesso blocco `DO`: il conteggio-guardia
// (`SELECT count(*) … WHERE <colonna> NOT IN (…)`) che decide se il vincolo si aggiunge. Se la
// guardia è più larga del CHECK conta zero righe fuori elenco quando ce ne sono, il `VALIDATE`
// fallisce e con lui l'integrazione al merge; se è più stretta rinuncia al vincolo per righe che
// il CHECK ammetterebbe. Anche quella si confronta.
// =============================================================================

const CARTELLA = join(process.cwd(), 'supabase', 'migrations')

type File = { nome: string; sql: string }

function migrazioni(): File[] {
    return readdirSync(CARTELLA)
        .filter((n) => n.endsWith('.sql'))
        .sort()
        .map((nome) => ({ nome, sql: readFileSync(join(CARTELLA, nome), 'utf8') }))
}

function senzaCommenti(sql: string): string {
    return sql
        .split('\n')
        .map((riga) => riga.replace(/--.*$/, ''))
        .join('\n')
}

/** `'a', 'b'` → `['a', 'b']`. */
function valoriDellaLista(testo: string): string[] {
    return testo
        .split(',')
        .map((v) => v.trim().replace(/^'|'$/g, ''))
        .filter((v) => v !== '')
}

/** L'ultimo `ADD CONSTRAINT <vincolo> CHECK (<colonna> IN (…))`, con il file che lo contiene. */
function ultimoCheck(file: File[], vincolo: string): { nome: string; colonna: string; valori: string[]; sql: string } | null {
    const re = new RegExp(`ADD\\s+CONSTRAINT\\s+${vincolo}\\s+CHECK\\s*\\(\\s*(\\w+)\\s+IN\\s*\\(([^)]*)\\)\\s*\\)`, 'i')
    let trovato: { nome: string; colonna: string; valori: string[]; sql: string } | null = null
    for (const f of file) {
        const sql = senzaCommenti(f.sql)
        const m = re.exec(sql)
        if (!m) continue
        trovato = { nome: f.nome, colonna: m[1], valori: valoriDellaLista(m[2]), sql }
    }
    return trovato
}

/**
 * La lista del conteggio-guardia del CHECK `vincolo`: il primo `count(*) … <colonna> NOT IN (…)`
 * fra l'inizio del blocco `DO $$` che contiene l'`ADD CONSTRAINT` e l'`ADD CONSTRAINT` stesso.
 * Solo quel blocco: in un file con due vincoli sulla stessa colonna, la guardia dell'altro
 * direbbe «allineato» per la ragione sbagliata. `sql` è già senza commenti.
 */
function listaDellaGuardia(sql: string, vincolo: string, colonna: string): string[] | null {
    const posCheck = sql.search(new RegExp(`ADD\\s+CONSTRAINT\\s+${vincolo}\\s+CHECK`, 'i'))
    if (posCheck < 0) return null
    let inizioBlocco = 0
    for (const m of sql.matchAll(/\bDO\s+\$\$/gi)) if (m.index < posCheck) inizioBlocco = m.index
    const blocco = sql.slice(inizioBlocco, posCheck)
    const m = new RegExp(`count\\(\\*\\)[\\s\\S]*?\\b${colonna}\\s+NOT\\s+IN\\s*\\(([^)]*)\\)`, 'i').exec(blocco)
    return m ? valoriDellaLista(m[1]) : null
}

const VINCOLI = [
    { vincolo: 'enrollment_submissions_status_ammesso', colonna: 'status', attesi: [...STATI_DOMANDA], fonte: 'STATI_DOMANDA (src/lib/iscrizioni/stati.ts)' },
    { vincolo: 'alunni_stato_ammesso', colonna: 'stato', attesi: [...STATI_TENDINA], fonte: 'STATI_TENDINA (src/lib/alunni/stato.ts)' },
] as const

describe('lock architettura · gli stati vincolati in SQL dicono quello che dice TypeScript', () => {
    for (const { vincolo, colonna, attesi, fonte } of VINCOLI) {
        it(`${vincolo}: esiste, sulla colonna ${colonna}, con i valori di ${fonte}`, () => {
            const c = ultimoCheck(migrazioni(), vincolo)
            expect(c, `nessuna migrazione aggiunge ${vincolo}`).not.toBeNull()
            expect(c!.colonna).toBe(colonna)
            expect(
                [...c!.valori].sort(),
                `Il CHECK ${vincolo} (${c!.nome}) e ${fonte} sono divergenti: chi ne sposta uno sposti ` +
                    "anche l'altro, con una migrazione.",
            ).toEqual([...attesi].sort())
        })

        it(`${vincolo}: è convalidato nello stesso file in cui nasce`, () => {
            const c = ultimoCheck(migrazioni(), vincolo)
            expect(c).not.toBeNull()
            expect(c!.sql).toMatch(new RegExp(`VALIDATE\\s+CONSTRAINT\\s+${vincolo}\\b`, 'i'))
        })

        it(`${vincolo}: il conteggio-guardia conta fuori elenco ESATTAMENTE i valori del CHECK`, () => {
            const c = ultimoCheck(migrazioni(), vincolo)
            expect(c).not.toBeNull()
            const guardia = listaDellaGuardia(c!.sql, vincolo, colonna)
            expect(guardia, `nessun «count(*) … ${colonna} NOT IN (…)» prima di ${vincolo} in ${c!.nome}`).not.toBeNull()
            expect(
                [...guardia!].sort(),
                `In ${c!.nome} la guardia di ${vincolo} e il suo CHECK hanno liste diverse: una guardia più ` +
                    "larga lascia passare righe che il VALIDATE respinge (e fallisce l'integrazione), una più " +
                    'stretta rinuncia al vincolo per righe che il CHECK ammetterebbe.',
            ).toEqual([...c!.valori].sort())
        })
    }

    it("ogni stato che l'automa tratta come «non più iscritto» è ammesso dal CHECK degli alunni", () => {
        const c = ultimoCheck(migrazioni(), 'alunni_stato_ammesso')
        expect(c).not.toBeNull()
        for (const s of STATI_NON_PIU_ISCRITTO) expect(c!.valori).toContain(s)
    })

    it('CONTROLLO POSITIVO: il lettore vede un CHECK vero e ignora uno scritto in un commento', () => {
        const vero = ultimoCheck(
            [{ nome: 'a.sql', sql: "ALTER TABLE t\n  ADD CONSTRAINT v_ammesso\n  CHECK (c IN ('x', 'y')) NOT VALID;" }],
            'v_ammesso',
        )
        expect(vero).toMatchObject({ colonna: 'c', valori: ['x', 'y'] })
        const commentato = ultimoCheck(
            [{ nome: 'b.sql', sql: "-- ALTER TABLE t ADD CONSTRAINT v_ammesso CHECK (c IN ('z'));" }],
            'v_ammesso',
        )
        expect(commentato).toBeNull()
    })

    it('CONTROLLO POSITIVO: la guardia si legge nel blocco DO del suo CHECK, non in quello prima', () => {
        const blocco = (vincolo: string, lista: string) =>
            `DO $$\nDECLARE fuori bigint;\nBEGIN\n  SELECT count(*) INTO fuori FROM t WHERE c NOT IN (${lista});\n` +
            `  ALTER TABLE t ADD CONSTRAINT ${vincolo} CHECK (c IN (${lista})) NOT VALID;\nEND $$;\n`
        const sql = senzaCommenti(blocco('v_uno', "'x'") + blocco('v_due', "'y', 'z'"))
        expect(listaDellaGuardia(sql, 'v_uno', 'c')).toEqual(['x'])
        expect(listaDellaGuardia(sql, 'v_due', 'c')).toEqual(['y', 'z'])
        const senzaGuardia = senzaCommenti(
            "DO $$\nBEGIN\n  -- SELECT count(*) INTO fuori FROM t WHERE c NOT IN ('x');\n" +
                "  ALTER TABLE t ADD CONSTRAINT v_uno CHECK (c IN ('x')) NOT VALID;\nEND $$;\n",
        )
        expect(listaDellaGuardia(senzaGuardia, 'v_uno', 'c'), 'una guardia in un commento non è una guardia').toBeNull()
    })
})
