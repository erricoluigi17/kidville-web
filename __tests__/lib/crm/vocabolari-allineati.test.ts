// @vitest-environment node

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
    ANNI_INGRESSO,
    AUTORE_VIA,
    DURATA_SLOT_DEFAULT_MIN,
    ESITI_AZIONE,
    ESITI_BAMBINO,
    ESITO_ORIGINE,
    MOTIVI_INDISPONIBILITA,
    MOTIVI_PERDITA,
    NOTE_COLLEGAMENTO,
    ORIGINI,
    STATI_APPUNTAMENTO,
    TIPI_AZIONE,
    TIPI_EVENTO,
    VIA,
} from '@/lib/crm/tipi'
import { senzaCommenti } from '../../architecture/soglia-fotografia'

/**
 * I VOCABOLARI DEL CRM STANNO IN DUE POSTI, E DEVONO DIRE LA STESSA COSA.
 *
 * Il database li conosce come `check (<colonna> in (…))` nella migrazione; il codice come costanti
 * `as const` di `src/lib/crm/tipi.ts`. Se uno dei due cresce senza l'altro, il codice propone un valore
 * che il database rifiuta (23514) o il database accetta un valore che il codice non sa mostrare: due
 * difetti che si vedono solo davanti a una famiglia vera. Questo test li tiene allineati, valore per
 * valore e nello stesso ordine.
 *
 * ⚠️ Cerca i check nella migrazione SENZA COMMENTI: un commento che li nomina non li sostituisce.
 */

const CARTELLA = join(process.cwd(), 'supabase', 'migrations')
const FILE = readdirSync(CARTELLA).filter((f) => /^\d{14}_crm_segreteria\.sql$/.test(f))
const SQL = FILE.length === 1 ? senzaCommenti(readFileSync(join(CARTELLA, FILE[0]), 'utf8')) : ''

/** Quale costante governa quale colonna (tabella.colonna). */
const MAPPA: Record<string, readonly string[]> = {
    'crm_schede.origine': ORIGINI,
    'crm_schede.creato_via': VIA,
    'crm_bambini.anno_ingresso': ANNI_INGRESSO,
    'crm_bambini.esito': ESITI_BAMBINO,
    'crm_bambini.motivo_perdita': MOTIVI_PERDITA,
    'crm_bambini.esito_origine': ESITO_ORIGINE,
    'crm_bambini.nota_collegamento': NOTE_COLLEGAMENTO,
    'crm_appuntamenti.fissato_via': VIA,
    'crm_appuntamenti.stato': STATI_APPUNTAMENTO,
    'crm_azioni.tipo': TIPI_AZIONE,
    'crm_azioni.esito': ESITI_AZIONE,
    'crm_eventi.tipo': TIPI_EVENTO,
    'crm_eventi.autore_via': AUTORE_VIA,
    'crm_indisponibilita.motivo': MOTIVI_INDISPONIBILITA,
}

/** Ogni `check (colonna in ('a','b',…))` di ogni `create table crm_*`, come `tabella.colonna → valori`. */
function checkDellaMigrazione(sql: string): Record<string, string[]> {
    const out: Record<string, string[]> = {}
    const tabella = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?(crm_\w+)\s*\(/gi
    for (let m = tabella.exec(sql); m; m = tabella.exec(sql)) {
        let livello = 1
        let j = tabella.lastIndex
        while (j < sql.length && livello > 0) {
            if (sql[j] === '(') livello++
            if (sql[j] === ')') livello--
            j++
        }
        const corpo = sql.slice(tabella.lastIndex, j - 1)
        const check = /check\s*\(\s*(\w+)\s+in\s*\(([^)]*)\)\s*\)/gi
        for (let c = check.exec(corpo); c; c = check.exec(corpo)) {
            out[`${m[1].toLowerCase()}.${c[1].toLowerCase()}`] = [...c[2].matchAll(/'([^']*)'/g)].map((v) => v[1])
        }
    }
    return out
}

const TROVATI = checkDellaMigrazione(SQL)

describe('vocabolari del CRM · migrazione e tipi.ts dicono la stessa cosa', () => {
    it('la migrazione c’è e i check sono stati letti (sanity: senza, il resto sarebbe verde sul vuoto)', () => {
        expect(FILE).toHaveLength(1)
        expect(Object.keys(TROVATI).length).toBeGreaterThan(10)
    })

    it('ogni colonna con un vocabolario ha la sua mappa, e viceversa', () => {
        expect(Object.keys(TROVATI).sort()).toEqual(Object.keys(MAPPA).sort())
    })

    for (const [colonna, costante] of Object.entries(MAPPA)) {
        it(`${colonna}: stessi valori, stesso ordine`, () => {
            expect(TROVATI[colonna]).toEqual([...costante])
        })
    }

    it('nessun vocabolario ha valori ripetuti o vuoti', () => {
        for (const [colonna, costante] of Object.entries(MAPPA)) {
            expect(new Set(costante).size, colonna).toBe(costante.length)
            expect(costante.every((v) => v.length > 0), colonna).toBe(true)
        }
    })

    it('la durata dello slot di default coincide con il default del database', () => {
        expect(SQL).toMatch(new RegExp(`durata_min\\s+int\\s+not\\s+null\\s+default\\s+${DURATA_SLOT_DEFAULT_MIN}\\b`, 'i'))
        expect(SQL).toMatch(new RegExp(`durata_slot_min\\s+int\\s+not\\s+null\\s+default\\s+${DURATA_SLOT_DEFAULT_MIN}\\b`, 'i'))
    })
})
