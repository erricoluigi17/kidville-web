/**
 * LA FOTOGRAFIA DELLE FUNZIONI SQL CHE SCRIVONO IL REGISTRO — prova piccola (anno scolastico, PR 3, compito 3.0).
 *
 * `__tests__/fixtures/funzioni-scrivono-registro.json` e' lo scatto delle funzioni di `public` e
 * `scatola_nera` il cui corpo contiene `update` / `delete from` / `insert into` seguito da una delle
 * tabelle di `public.anno_tabelle`, fatto con `scripts/funzioni-registro-fotografia.mjs`. Il lock vero
 * (3.9) la confronta con le migrazioni; qui si prova solo che esista, non sia vuota, non sia stata
 * scritta a mano, porti SOLO nomi (mai sorgenti) e che ogni funzione abbia una classe valida e le
 * tabelle dichiarate nella fotografia delle tabelle dell'anno.
 */
import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

type Riga = { funzione: string; tabelle: string[]; classe: string }
type Foto = { generato_il: string; generato_alle: string; sha256: string; funzioni: Riga[] }

const leggi = <T,>(nome: string): T =>
    JSON.parse(readFileSync(join(process.cwd(), '__tests__', 'fixtures', nome), 'utf8'))

const foto: Foto = leggi<Foto>('funzioni-scrivono-registro.json')
const registro = new Set(
    leggi<{ tabelle: { tabella: string }[] }>('tabelle-anno.json').tabelle.map((t) => t.tabella),
)

// Da aggiornare quando si rigenera la fotografia: blocca le cancellazioni silenziose.
// 71 misurate in produzione il 14/11/2026 dopo il CRM per l'assistente (#315): +1 `crm_ai_bambini`, e +4 del passaggio d'anno
// (`passaggio_conferma`, `passaggio_annulla`, `passaggio_conferma_tardiva`, `passaggio_ricopia_schede`), in produzione dalla 4.8 (#307)
// ma mai entrate qui perché dopo quel merge la fotografia non era stata rigenerata. Prima: 66 l'08/11 dopo la PR 4.3 (65 il 07/11,
// +1 frequenza_segue_classe_alunno; il piano ne scriveva 58, vedi il report del 3.0).
const FUNZIONI_ATTESE = 71
const CLASSI = ['corrente', 'esente-colonne', 'oblio', 'macchina-a-stati', 'dichiara', 'passaggio']

describe('fotografia delle funzioni che scrivono il registro', () => {
    it(`contiene le ${FUNZIONI_ATTESE} funzioni, senza doppioni e in ordine stabile`, () => {
        expect(foto.funzioni).toHaveLength(FUNZIONI_ATTESE)
        const nomi = foto.funzioni.map((f) => f.funzione)
        expect(new Set(nomi).size).toBe(nomi.length)
        expect(nomi).toEqual([...nomi].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)))
    })

    it('ogni riga e\' {funzione, tabelle[], classe} con una classe valida e solo tabelle del registro', () => {
        for (const f of foto.funzioni) {
            expect(Object.keys(f).sort(), `${f.funzione}: forma della riga`).toEqual(['classe', 'funzione', 'tabelle'])
            expect(CLASSI, `${f.funzione}: classe «${f.classe}»`).toContain(f.classe)
            expect(f.tabelle.length, `${f.funzione}: nessuna tabella`).toBeGreaterThan(0)
            for (const t of f.tabelle) {
                expect(registro.has(t), `${f.funzione}: «${t}» non e' nel registro`).toBe(true)
            }
        }
    })

    it('porta solo NOMI: mai sorgenti, mai SQL', () => {
        for (const f of foto.funzioni) {
            expect(f.funzione, 'nome di funzione').toMatch(/^[a-z_][a-z0-9_]*$/)
            for (const t of f.tabelle) expect(t).toMatch(/^[a-z_][a-z0-9_]*$/)
        }
    })

    it('non e\' stata addomesticata a mano (sha256) e porta l\'istante dello scatto', () => {
        const atteso = createHash('sha256').update(JSON.stringify({ funzioni: foto.funzioni })).digest('hex')
        expect(
            foto.sha256,
            'Il contenuto non corrisponde al suo sha256: rigenera con scripts/funzioni-registro-fotografia.mjs',
        ).toBe(atteso)
        expect(foto.generato_alle).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
    })
})
