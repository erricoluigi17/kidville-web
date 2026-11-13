#!/usr/bin/env node
/**
 * Rigenera la fotografia versionata delle COLONNE delle tabelle che `azzera-anno-nuovo-demo.sql` nomina:
 *   __tests__/fixtures/colonne-azzera-snapshot.json
 *
 * Il test `__tests__/db/anno-azzera-colonne.test.ts` gira OFFLINE e confronta ogni `alias.colonna` dello script con questa fotografia
 * (e con il banco PGlite). Nasce da B1 della revisione del 13/11/2026: lo script nominava `pagamenti.fattura_id`, che esiste solo nel
 * banco di prova e non in produzione, e falliva a ogni esecuzione con `42703` senza che nessun test se ne accorgesse.
 *
 * NON SI CONNETTE AL DATABASE: entra solo testo, da stdin. Si rigenera quando lo script nomina una tabella nuova (o la produzione
 * cambia le colonne di una già nominata):
 *   1. `node __tests__/fixtures/colonne-azzera-fotografia.mjs --sql`
 *   2. esegui quella query sul DB di produzione (SOLA LETTURA: guarda solo `information_schema`, nemmeno una riga di dati)
 *   3. salva la risposta in un file
 *   4. `node __tests__/fixtures/colonne-azzera-fotografia.mjs < risposta.json`
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const TABELLE = [
    'alunni', 'anni_scolastici', 'anni_sede', 'anni_sede_stati', 'anno_regole', 'anno_tabelle', 'crm_bambini', 'crm_schede', 'enrollment_submissions',
    'frequenze', 'frequenze_moduli', 'incassi', 'iscrizioni_decisioni', 'iscrizioni_inviti_credenziali', 'legame_genitori_alunni',
    'listino_voci', 'materie', 'mensa_class_menu_assignment', 'moduli_richiesti', 'pagamenti', 'pagamenti_quote', 'parents',
    'passaggi_anno', 'passaggi_anno_righe', 'posti_autorizzati', 'registro_orario', 'scrutinio_giudizi', 'sections', 'student_parents',
    'utenti', 'valutazioni',
]

const SQL = `select json_build_object('colonne', (select json_object_agg(t, cols) from (select table_name t, json_agg(column_name order by column_name) cols from information_schema.columns where table_schema = 'public' and table_name in (${TABELLE.map((t) => `'${t}'`).join(',')}) group by table_name) x)) as fotografia;`

if (process.argv.includes('--sql')) {
    process.stdout.write(SQL + '\n')
    process.exit(0)
}

function estrai(grezzo) {
    let v = JSON.parse(grezzo)
    if (v && typeof v === 'object' && Array.isArray(v.rows)) v = v.rows
    if (Array.isArray(v)) v = v[0]
    if (v && typeof v === 'object' && v.fotografia) v = v.fotografia
    if (!v || typeof v.colonne !== 'object') throw new Error('JSON non riconosciuto: manca `colonne`. Rilancia la query di --sql.')
    return v
}

const colonne = Object.fromEntries(
    Object.entries(estrai(readFileSync(0, 'utf8')).colonne)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([t, c]) => [t, [...c].sort()]),
)
const mancanti = TABELLE.filter((t) => !colonne[t])
if (mancanti.length) throw new Error(`tabelle assenti dalla risposta: ${mancanti.join(', ')}`)

const ADESSO = new Date().toISOString().replace(/\.\d+Z$/, 'Z')
const uscita = {
    _come_si_rigenera: 'node __tests__/fixtures/colonne-azzera-fotografia.mjs --sql | (esegui su prod) ; node __tests__/fixtures/colonne-azzera-fotografia.mjs < risposta.json',
    generato_il: ADESSO.slice(0, 10),
    generato_alle: ADESSO,
    sha256: createHash('sha256').update(JSON.stringify(colonne)).digest('hex'),
    colonne,
}
const dest = join(process.cwd(), '__tests__', 'fixtures', 'colonne-azzera-snapshot.json')
writeFileSync(dest, JSON.stringify(uscita, null, 2) + '\n', 'utf8')
process.stdout.write(`fotografia scritta: ${dest} · ${Object.keys(colonne).length} tabelle · sha256 ${uscita.sha256.slice(0, 12)}…\n`)
