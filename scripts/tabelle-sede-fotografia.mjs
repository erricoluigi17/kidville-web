#!/usr/bin/env node
/**
 * Rigenera la fotografia versionata delle TABELLE CHE APPARTENGONO A UNA SEDE:
 *   __tests__/fixtures/tabelle-scuola-id.json
 *
 * Il lock `__tests__/architecture/isolamento-sede-coverage.test.ts` deve sapere
 * QUALI tabelle esigono un filtro di sede. Fino al 2026-07-30 quell'elenco era
 * scritto a mano nel test: sette nomi su sessantacinque. Le route che leggevano
 * le altre cinquantotto — `audit_scritture_docente`, `form_submissions`,
 * `pagamenti`, `presenze`, `registro_orario`… — passavano il lock senza nemmeno
 * essere guardate. Un elenco compilato a memoria e' un elenco che invecchia in
 * silenzio: la tabella nuova non ci finisce mai dentro, e nessuno se ne accorge.
 *
 * Da qui la fotografia: l'elenco lo dice il DATABASE, non la memoria di chi
 * scrive il test. Il lock gira OFFLINE (vitest, in CI, senza il database di
 * produzione), quindi la sua unica sorgente di verita' e' questo file. Perche'
 * non possa essere addomesticato a mano per far tacere il lock, porta un
 * `sha256` del contenuto normalizzato: chi lo modifica senza rigenerarlo fa
 * fallire il test. Stessa forma di `scripts/fk-sede-fotografia.mjs` e
 * `scripts/rls-fotografia.mjs`.
 *
 * ─── COME SI RIGENERA ──────────────────────────────────────────────────────────
 * 1. Esegui sul DB di produzione la query che stampa
 *    `node scripts/tabelle-sede-fotografia.mjs --sql`
 *    (strumento MCP `execute_sql`, oppure `psql "$DATABASE_URL" -Atc "<query>"`).
 *    E' una query di SOLA LETTURA su information_schema.
 * 2. Salva la risposta JSON in un file (va bene sia l'array che restituisce l'MCP,
 *    sia l'oggetto nudo).
 * 3. `node scripts/tabelle-sede-fotografia.mjs < risposta.json`
 * 4. `npx vitest run __tests__/architecture/isolamento-sede-coverage.test.ts`
 *
 * NON si connette da solo al database: `.env.local` punta alla PRODUZIONE e uno
 * script che si collega da se' e' uno script che prima o poi ci scrive. Qui entra
 * solo testo.
 */

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Due fatti, e nient'altro:
//  • `con_scuola_id`     → ogni tabella di `public` che HA la colonna `scuola_id`.
//                          Su queste il filtro di sede e' letterale: `.eq('scuola_id', …)`
//                          o `.in('scuola_id', …)` dentro la query stessa.
//  • `legate_all_alunno` → ogni tabella di `public` che NON ha `scuola_id` ma ha
//                          `alunno_id`/`student_id`: la sede ce l'ha l'alunno, non la
//                          riga. Sono i dati piu' delicati che il registro conservi
//                          (valutazioni, note, certificati medici, pagelle, diario):
//                          li' il presidio non e' un filtro sulla colonna, e' il gate
//                          sull'identita' dell'alunno (`assertAlunnoInScope`) o il
//                          legame di famiglia.
const SQL = `SELECT json_build_object(
  'con_scuola_id', (
    SELECT coalesce(json_agg(c.table_name ORDER BY c.table_name), '[]'::json)
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
     AND t.table_type = 'BASE TABLE'
    WHERE c.table_schema = 'public' AND c.column_name = 'scuola_id'
  ),
  'legate_all_alunno', (
    SELECT coalesce(json_agg(DISTINCT c.table_name), '[]'::json)
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
     AND t.table_type = 'BASE TABLE'
    WHERE c.table_schema = 'public'
      AND c.column_name IN ('alunno_id','student_id')
      AND c.table_name NOT IN (
        SELECT table_name FROM information_schema.columns
        WHERE table_schema='public' AND column_name='scuola_id'
      )
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
    if (!v || !Array.isArray(v.con_scuola_id)) {
        throw new Error('JSON non riconosciuto: manca `con_scuola_id`. Rilancia la query di --sql.')
    }
    return v
}

/** Normalizzazione: ordine stabile, niente doppioni, niente `undefined`. */
export function normalizza(f) {
    const ordina = (a) => [...new Set(a ?? [])].sort()
    return {
        con_scuola_id: ordina(f.con_scuola_id),
        legate_all_alunno: ordina(f.legate_all_alunno),
    }
}

/** Impronta del solo contenuto: `generato_il` e `sha256` restano fuori. */
export function impronta(normalizzata) {
    return createHash('sha256').update(JSON.stringify(normalizzata)).digest('hex')
}

const stdin = readFileSync(0, 'utf8')
const normalizzata = normalizza(estrai(stdin))
const uscita = {
    _come_si_rigenera:
        'node scripts/tabelle-sede-fotografia.mjs --sql | (esegui su prod) ; node scripts/tabelle-sede-fotografia.mjs < risposta.json',
    generato_il: new Date().toISOString().slice(0, 10),
    sha256: impronta(normalizzata),
    ...normalizzata,
}

const dest = join(process.cwd(), '__tests__', 'fixtures', 'tabelle-scuola-id.json')
writeFileSync(dest, JSON.stringify(uscita, null, 2) + '\n', 'utf8')
process.stdout.write(
    `fotografia scritta: ${dest}\n` +
    `  con scuola_id: ${normalizzata.con_scuola_id.length}` +
    ` · legate all'alunno: ${normalizzata.legate_all_alunno.length}` +
    ` · sha256: ${uscita.sha256.slice(0, 12)}…\n`,
)
