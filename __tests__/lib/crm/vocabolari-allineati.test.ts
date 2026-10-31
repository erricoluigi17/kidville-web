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
    QUOTA_METODI,
    QUOTA_MOTIVI_BLOCCO,
    QUOTA_STATI,
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
/**
 * Le migrazioni del CRM, in ordine di nome: la prima crea le tabelle, le successive le cambiano
 * (la seconda, del 31/10/2026, aggiunge le colonne della quota e allunga il vincolo degli eventi).
 * Per ogni colonna vince la definizione dell'ULTIMO file che la dichiara.
 */
const FILE = readdirSync(CARTELLA)
    .filter((f) => /^\d{14}_crm_(segreteria|quota_e_settimane)\.sql$/.test(f))
    .sort()
const SQL_PER_FILE = FILE.map((f) => senzaCommenti(readFileSync(join(CARTELLA, f), 'utf8')))

/** Quale costante governa quale colonna (tabella.colonna). */
const MAPPA: Record<string, readonly string[]> = {
    'crm_schede.origine': ORIGINI,
    'crm_schede.creato_via': VIA,
    'crm_bambini.anno_ingresso': ANNI_INGRESSO,
    'crm_bambini.esito': ESITI_BAMBINO,
    'crm_bambini.motivo_perdita': MOTIVI_PERDITA,
    'crm_bambini.esito_origine': ESITO_ORIGINE,
    'crm_bambini.nota_collegamento': NOTE_COLLEGAMENTO,
    'crm_bambini.quota_metodo': QUOTA_METODI,
    'crm_bambini.quota_stato': QUOTA_STATI,
    'crm_bambini.quota_blocco_motivo': QUOTA_MOTIVI_BLOCCO,
    'crm_appuntamenti.fissato_via': VIA,
    'crm_appuntamenti.stato': STATI_APPUNTAMENTO,
    'crm_azioni.tipo': TIPI_AZIONE,
    'crm_azioni.esito': ESITI_AZIONE,
    'crm_eventi.tipo': TIPI_EVENTO,
    'crm_eventi.autore_via': AUTORE_VIA,
    'crm_indisponibilita.motivo': MOTIVI_INDISPONIBILITA,
}

/** I valori fra apici di una lista `('a','b',…)`. */
const valori = (lista: string): string[] => [...lista.matchAll(/'([^']*)'/g)].map((v) => v[1])

/**
 * Ogni vocabolario di ogni `crm_*`, come `tabella.colonna → valori`, letto da tre forme:
 *  · `create table crm_* ( … check (colonna in (…)) … )` — le tabelle di nascita;
 *  · `alter table crm_* add column [if not exists] colonna … check (colonna in (…))` — le colonne aggiunte dopo;
 *  · `alter table crm_* … add constraint <nome> check (colonna in (…))` — un vincolo ricreato.
 *
 * I file si passano IN ORDINE e, per ogni `tabella.colonna`, vince l'ultima definizione: è quella che il
 * database ha dopo che tutte le migrazioni sono state applicate.
 */
function checkDelleMigrazioni(files: string[]): Record<string, string[]> {
    const out: Record<string, string[]> = {}
    for (const sql of files) {
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
                out[`${m[1].toLowerCase()}.${c[1].toLowerCase()}`] = valori(c[2])
            }
        }
        // Un ALTER TABLE non ha `;` al suo interno (le liste dei vocabolari non ne contengono).
        const alter = /alter\s+table\s+(?:only\s+)?(?:public\.)?(crm_\w+)\s+([^;]*);/gi
        for (let a = alter.exec(sql); a; a = alter.exec(sql)) {
            const nomeTabella = a[1].toLowerCase()
            const clausole = a[2]
            // `add column colonna <tipo> check (colonna in (…))`: la clausola non può sconfinare nella successiva.
            const colonna = /add\s+column\s+(?:if\s+not\s+exists\s+)?(\w+)(?:(?!add\s+(?:column|constraint)\b)[\s\S])*?check\s*\(\s*\1\s+in\s*\(([^)]*)\)\s*\)/gi
            for (let c = colonna.exec(clausole); c; c = colonna.exec(clausole)) {
                out[`${nomeTabella}.${c[1].toLowerCase()}`] = valori(c[2])
            }
            const vincolo = /add\s+constraint\s+\w+\s+check\s*\(\s*(\w+)\s+in\s*\(([^)]*)\)\s*\)/gi
            for (let c = vincolo.exec(clausole); c; c = vincolo.exec(clausole)) {
                out[`${nomeTabella}.${c[1].toLowerCase()}`] = valori(c[2])
            }
        }
    }
    return out
}

const TROVATI = checkDelleMigrazioni(SQL_PER_FILE)

describe('vocabolari del CRM · migrazione e tipi.ts dicono la stessa cosa', () => {
    it('le migrazioni ci sono e i check sono stati letti (sanity: senza, il resto sarebbe verde sul vuoto)', () => {
        expect(FILE).toHaveLength(2)
        expect(FILE[0]).toMatch(/_crm_segreteria\.sql$/)
        expect(FILE[1]).toMatch(/_crm_quota_e_settimane\.sql$/)
        expect(Object.keys(TROVATI).length).toBeGreaterThan(10)
    })

    it('il vincolo degli eventi è quello RICREATO dalla seconda migrazione (vince l’ultima definizione)', () => {
        // Senza questo, un lettore che guardasse solo le `create table` vedrebbe i 24 valori vecchi.
        expect(TROVATI['crm_eventi.tipo']).toHaveLength(24 + 5)
        expect(TROVATI['crm_eventi.tipo'].slice(-5)).toEqual([
            'quota_in_contabilita',
            'quota_corretta',
            'quota_tolta',
            'alunno_collegato',
            'alunno_scollegato',
        ])
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
        // `crm_appuntamenti.durata_min` nasce nella prima migrazione; `crm_fasce.durata_slot_min` nella seconda
        // (prima stava in `crm_disponibilita`, tolta).
        expect(SQL_PER_FILE[0]).toMatch(new RegExp(`durata_min\\s+int\\s+not\\s+null\\s+default\\s+${DURATA_SLOT_DEFAULT_MIN}\\b`, 'i'))
        expect(SQL_PER_FILE[1]).toMatch(new RegExp(`durata_slot_min\\s+smallint\\s+not\\s+null\\s+default\\s+${DURATA_SLOT_DEFAULT_MIN}\\b`, 'i'))
    })
})
