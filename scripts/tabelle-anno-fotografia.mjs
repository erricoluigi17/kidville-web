#!/usr/bin/env node
/**
 * Rigenera la fotografia versionata delle TABELLE CHE L'ANNO SCOLASTICO SORVEGLIA:
 *   __tests__/fixtures/tabelle-anno.json
 *
 * La tabella `public.anno_tabelle` (nata con la migrazione `20261106200347_anno_scolastico_schema`)
 * dice al database, riga per riga, come ogni tabella di `public` si rapporta all'anno scolastico:
 * il `modo` (come si assegna l'anno a una riga), la colonna che porta la data o l'anno
 * (`colonna_data`, `colonna_data_riserva`), come si risale alla sede (`via_sede`), l'eventuale
 * tabella madre (`madre_tabella`, `madre_colonna`), la colonna di creazione e se la regola e'
 * rigida. Un lock vero (PR 3) deve confrontare quell'elenco con il codice: gira OFFLINE (vitest,
 * in CI, senza il database di produzione), quindi la sua unica sorgente di verita' e' QUESTO file.
 * Perche' non possa essere addomesticato a mano per far tacere il lock, porta un `sha256` del
 * contenuto normalizzato: chi lo modifica senza rigenerarlo fa fallire il test
 * (`__tests__/architecture/tabelle-anno-fotografia.test.ts`). Stessa forma di
 * `scripts/tabelle-sede-fotografia.mjs`.
 *
 * ─── COME SI RIGENERA ──────────────────────────────────────────────────────────
 * 1. Esegui sul DB di produzione la query che stampa `node scripts/tabelle-anno-fotografia.mjs --sql`
 *    (strumento MCP `execute_sql`, oppure `psql "$DATABASE_URL" -Atc "<query>"`).
 *    E' una query di SOLA LETTURA su `public.anno_tabelle`, una tabella di CONFIGURAZIONE:
 *    contiene nomi di tabelle e di colonne, nemmeno una riga di dati di persone.
 * 2. Salva la risposta JSON in un file (va bene sia l'array che restituisce l'MCP,
 *    sia l'oggetto nudo).
 * 3. `node scripts/tabelle-anno-fotografia.mjs < risposta.json`
 * 4. `npx vitest run __tests__/architecture/tabelle-anno-fotografia.test.ts`
 *
 * VA RIGENERATA DOPO OGNI MIGRAZIONE CHE TOCCHI `anno_tabelle`.
 *
 * NON si connette da solo al database: `.env.local` punta alla PRODUZIONE e uno script
 * che si collega da se' e' uno script che prima o poi ci scrive. Qui entra solo testo.
 */

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Tutte le colonne di `anno_tabelle`, nell'ordine in cui il lock della PR 3 le leggera'. Ordinate
// per nome di tabella con collazione "C" (byte per byte): e' lo stesso ordine che `normalizza`
// impone qui sotto, cosi' la query e il file non si contraddicono sull'ordine.
const SQL = `SELECT json_build_object(
  'tabelle', (
    SELECT coalesce(json_agg(json_build_object(
             'tabella', t.tabella,
             'modo', t.modo,
             'colonna_data', t.colonna_data,
             'colonna_data_riserva', t.colonna_data_riserva,
             'via_sede', t.via_sede,
             'madre_tabella', t.madre_tabella,
             'madre_colonna', t.madre_colonna,
             'colonna_creazione', t.colonna_creazione,
             'rigida', t.rigida
           ) ORDER BY t.tabella COLLATE "C"), '[]'::json)
    FROM public.anno_tabelle t
  )
) AS fotografia;`

if (process.argv.includes('--sql')) {
    process.stdout.write(SQL + '\n')
    process.exit(0)
}

/** Estrae l'oggetto fotografia da qualunque involucro l'MCP/psql gli metta intorno. */
function estrai(grezzo) {
    let v = JSON.parse(grezzo)
    if (Array.isArray(v)) v = v[0]
    if (v && typeof v === 'object' && v.fotografia) v = v.fotografia
    if (!v || !Array.isArray(v.tabelle)) {
        throw new Error('JSON non riconosciuto: manca `tabelle`. Rilancia la query di --sql.')
    }
    return v
}

const testo = (x) => (x === null || x === undefined ? null : String(x))

/** Normalizzazione: ordine stabile per tabella, campi in ordine fisso, niente `undefined`. */
export function normalizza(f) {
    const tabelle = f.tabelle
        .map((t) => ({
            tabella: String(t.tabella),
            modo: String(t.modo),
            colonna_data: testo(t.colonna_data),
            colonna_data_riserva: testo(t.colonna_data_riserva),
            via_sede: testo(t.via_sede),
            madre_tabella: testo(t.madre_tabella),
            madre_colonna: testo(t.madre_colonna),
            colonna_creazione: testo(t.colonna_creazione),
            rigida: t.rigida === true,
        }))
        .sort((a, b) => (a.tabella < b.tabella ? -1 : a.tabella > b.tabella ? 1 : 0))
    return { tabelle }
}

/** Impronta del solo contenuto: `generato_il`, `generato_alle` e `sha256` restano fuori. */
export function impronta(normalizzata) {
    return createHash('sha256').update(JSON.stringify(normalizzata)).digest('hex')
}

// L'ISTANTE dello scatto, in UTC e al secondo, come negli altri generatori
// (vedi `__tests__/architecture/soglia-fotografia.ts`).
const ADESSO = new Date().toISOString().replace(/\.\d+Z$/, 'Z')

const stdin = readFileSync(0, 'utf8')
const normalizzata = normalizza(estrai(stdin))
const uscita = {
    _come_si_rigenera:
        'node scripts/tabelle-anno-fotografia.mjs --sql | (esegui su prod) ; node scripts/tabelle-anno-fotografia.mjs < risposta.json',
    generato_il: ADESSO.slice(0, 10),
    generato_alle: ADESSO,
    sha256: impronta(normalizzata),
    ...normalizzata,
}

const dest = join(process.cwd(), '__tests__', 'fixtures', 'tabelle-anno.json')
writeFileSync(dest, JSON.stringify(uscita, null, 2) + '\n', 'utf8')
const perModo = normalizzata.tabelle.reduce((acc, t) => ({ ...acc, [t.modo]: (acc[t.modo] ?? 0) + 1 }), {})
process.stdout.write(
    `fotografia scritta: ${dest}\n` +
    `  tabelle: ${normalizzata.tabelle.length}` +
    ` · ${Object.entries(perModo).map(([k, v]) => `${k}: ${v}`).join(' · ')}` +
    ` · sha256: ${uscita.sha256.slice(0, 12)}…\n`,
)
