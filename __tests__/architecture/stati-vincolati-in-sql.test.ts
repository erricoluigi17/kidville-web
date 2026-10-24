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

/** L'ultimo `ADD CONSTRAINT <vincolo> CHECK (<colonna> IN (…))`, con il file che lo contiene. */
function ultimoCheck(file: File[], vincolo: string): { nome: string; colonna: string; valori: string[]; sql: string } | null {
    const re = new RegExp(`ADD\\s+CONSTRAINT\\s+${vincolo}\\s+CHECK\\s*\\(\\s*(\\w+)\\s+IN\\s*\\(([^)]*)\\)\\s*\\)`, 'i')
    let trovato: { nome: string; colonna: string; valori: string[]; sql: string } | null = null
    for (const f of file) {
        const sql = senzaCommenti(f.sql)
        const m = re.exec(sql)
        if (!m) continue
        const valori = m[2]
            .split(',')
            .map((v) => v.trim().replace(/^'|'$/g, ''))
            .filter((v) => v !== '')
        trovato = { nome: f.nome, colonna: m[1], valori, sql }
    }
    return trovato
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
})
