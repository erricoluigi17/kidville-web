/**
 * LA FOTOGRAFIA DI `anno_tabelle` — prova piccola (anno scolastico, PR 2, compito 2.-1).
 *
 * `__tests__/fixtures/tabelle-anno.json` e' lo scatto di `public.anno_tabelle` in produzione, fatto
 * con `scripts/tabelle-anno-fotografia.mjs`. Il lock vero, che la confronta con il codice, lo scrive
 * la PR 3: qui si prova solo che la fotografia esista, non sia vuota, non sia stata scritta a mano
 * e porti tutto cio' che il lock futuro leggera'.
 *
 * Il numero delle tabelle (46) e' quello misurato in produzione il 07/11/2026, meno `gallery_photo_uploads`
 * (uscita dal registro con la correzione del 07/11: la chiave anti-doppione delle foto sopravvive alla foto e non ha
 * una madre): le 44 tabelle che esistevano prima dell'anno scolastico, piu' `frequenze` e `frequenze_moduli`, che nascono con
 * `anno_id` insieme alla migrazione. Se la tabella cresce, si RIGENERA la fotografia e si aggiorna
 * il numero qui accanto: il numero in questo file e' la sentinella, non una descrizione.
 */
import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

type Riga = {
    tabella: string
    modo: string
    colonna_data: string | null
    colonna_data_riserva: string | null
    via_sede: string | null
    madre_tabella: string | null
    madre_colonna: string | null
    colonna_creazione: string | null
    rigida: boolean
}
type Foto = { generato_il: string; generato_alle: string; sha256: string; tabelle: Riga[] }

const foto: Foto = JSON.parse(
    readFileSync(join(process.cwd(), '__tests__', 'fixtures', 'tabelle-anno.json'), 'utf8'),
)

const TABELLE_ATTESE = 46 // era 47: `gallery_photo_uploads` e' uscita dal registro (correzione del 07/11)
const MODI = ['data', 'madre', 'dichiarato']

describe('fotografia di anno_tabelle', () => {
    it(`contiene tutte le ${TABELLE_ATTESE} tabelle, senza doppioni e in ordine stabile`, () => {
        expect(foto.tabelle).toHaveLength(TABELLE_ATTESE)
        const nomi = foto.tabelle.map((t) => t.tabella)
        expect(new Set(nomi).size).toBe(nomi.length)
        expect(nomi).toEqual([...nomi].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)))
    })

    it('ci sono le due tabelle nate con la migrazione, entrambe rigide', () => {
        const per = new Map(foto.tabelle.map((t) => [t.tabella, t]))
        expect(per.get('frequenze')?.rigida).toBe(true)
        expect(per.get('frequenze_moduli')?.rigida).toBe(true)
        expect(per.get('frequenze_moduli')?.modo).toBe('madre')
    })

    it('i tre modi ci sono tutti, e ciascuno porta le colonne che il suo modo richiede', () => {
        const modi = new Set(foto.tabelle.map((t) => t.modo))
        expect([...modi].sort()).toEqual([...MODI].sort())
        for (const t of foto.tabelle) {
            expect(MODI, `${t.tabella}: modo sconosciuto «${t.modo}»`).toContain(t.modo)
            if (t.modo === 'data') {
                expect(t.colonna_data, `${t.tabella}: modo data senza colonna_data`).toBeTruthy()
                expect(t.via_sede, `${t.tabella}: modo data senza via_sede`).toBeTruthy()
            }
            if (t.modo === 'madre') {
                expect(t.madre_tabella, `${t.tabella}: modo madre senza madre_tabella`).toBeTruthy()
                expect(t.madre_colonna, `${t.tabella}: modo madre senza madre_colonna`).toBeTruthy()
            }
            if (t.modo === 'dichiarato') {
                expect(t.via_sede, `${t.tabella}: modo dichiarato senza via_sede`).toBeTruthy()
            }
        }
    })

    it('ogni madre e\' a sua volta una tabella della fotografia', () => {
        const nomi = new Set(foto.tabelle.map((t) => t.tabella))
        for (const t of foto.tabelle.filter((x) => x.modo === 'madre')) {
            expect(nomi.has(t.madre_tabella as string), `${t.tabella}: madre ${t.madre_tabella} assente`).toBe(true)
        }
    })

    it('non e\' stata addomesticata a mano (sha256) e porta l\'istante dello scatto', () => {
        const contenuto = { tabelle: foto.tabelle }
        const atteso = createHash('sha256').update(JSON.stringify(contenuto)).digest('hex')
        expect(
            foto.sha256,
            'Il contenuto non corrisponde al suo sha256: rigenera con scripts/tabelle-anno-fotografia.mjs',
        ).toBe(atteso)
        expect(foto.generato_alle).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
    })
})
