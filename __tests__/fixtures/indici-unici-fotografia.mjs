#!/usr/bin/env node
/**
 * Rigenera la fotografia versionata degli INDICI UNIQUE della produzione:
 *   __tests__/fixtures/indici-unici-snapshot.json
 *
 * Il lock `__tests__/architecture/onconflict-arbitro.test.ts` gira OFFLINE (vitest, in CI, senza
 * le credenziali di produzione — che in CI non ci sono e non devono esserci): la sua unica
 * sorgente di verita' e' questo file. Porta un `sha256` del contenuto normalizzato, cosi' non lo
 * si puo' addomesticare a mano per far tacere il lock, e un `generato_alle` per non restare verde
 * mentre non sa piu' niente.
 *
 * VA RIGENERATA DOPO OGNI `apply_migration` CHE TOCCHI UN INDICE UNIQUE.
 *
 * NON SI CONNETTE DA SE' AL DATABASE: `.env.local` punta alla PRODUZIONE, e uno script che si
 * collega da solo e' uno script che prima o poi ci scrive. Qui entra solo testo, da stdin.
 *
 * ─── COME SI RIGENERA ─────────────────────────────────────────────────────────
 * 1. `node __tests__/fixtures/indici-unici-fotografia.mjs --sql`
 * 2. esegui quella query sul DB di produzione (strumento MCP `execute_sql`: e' di SOLA LETTURA,
 *    guarda solo il catalogo di sistema, nemmeno una riga di dati)
 * 3. salva la risposta in un file
 * 4. `node __tests__/fixtures/indici-unici-fotografia.mjs < risposta.json`
 * 5. `npx vitest run __tests__/architecture/onconflict-arbitro.test.ts`
 */

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Che cosa si guarda, e perche' proprio questo:
//
// · `parziale` (`indpred is not null`) e' il motivo per cui questa fotografia esiste:
//   `ON CONFLICT (colonne)` NON infersce un indice parziale.
// · `con_espressioni` (`indexprs is not null`) e' l'altra meta' della stessa regola: nemmeno un
//   indice su espressione si infersce da un elenco di colonne. Senza questo campo un indice su
//   `(scuola_id, lower(nome))` si presenterebbe come `['scuola_id']` — cioe' come un arbitro che
//   non e'.
// · si prendono le sole colonne CHIAVE (`k.ord <= indnkeyatts`): le colonne `INCLUDE` stanno in
//   `indkey` ma non fanno parte dell'unicita', e contarle direbbe che l'indice ha colonne che
//   l'arbitro non ha.
// · `indisvalid`: un indice rimasto invalido (una `CREATE INDEX CONCURRENTLY` fallita) esiste in
//   catalogo e non arbitra niente.
// · `nulls_not_distinct` non serve al confronto (l'arbitro si infersce dalle sole colonne): sta
//   nella fotografia perche' e' la differenza fra «unico davvero» e «unico tranne che sui NULL»,
//   ed e' l'informazione che serve a chi legge il diff della fotografia dopo una migrazione.
const SQL = `select json_build_object(
  'indici', (
    select coalesce(json_agg(json_build_object(
             'tabella', c.relname::text,
             'indice',  i.relname::text,
             'parziale', (x.indpred is not null),
             'con_espressioni', (x.indexprs is not null),
             'nulls_not_distinct', x.indnullsnotdistinct,
             'colonne', (
               select coalesce(array_agg(a.attname::text order by a.attname::text), '{}')
               from unnest(x.indkey) with ordinality k(attnum, ord)
               join pg_attribute a on a.attrelid = c.oid and a.attnum = k.attnum
               where k.ord <= x.indnkeyatts
             )
           ) order by c.relname, i.relname), '[]'::json)
    from pg_index x
    join pg_class c on c.oid = x.indrelid
    join pg_class i on i.oid = x.indexrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and x.indisunique and x.indisvalid
  )
) as fotografia;`

if (process.argv.includes('--sql')) {
    process.stdout.write(SQL + '\n')
    process.exit(0)
}

/** Estrae l'oggetto fotografia da qualunque involucro l'MCP/psql gli metta intorno. */
function estrai(grezzo) {
    let v = JSON.parse(grezzo)
    if (Array.isArray(v)) v = v[0]
    if (v && typeof v === 'object' && v.fotografia) v = v.fotografia
    if (Array.isArray(v)) v = { indici: v }
    if (!v || !Array.isArray(v.indici)) {
        throw new Error('JSON non riconosciuto: manca `indici`. Rilancia la query di --sql.')
    }
    return v
}

/** Ordine stabile, campi in ordine fisso, niente `undefined`. */
export function normalizza(f) {
    const indici = f.indici
        .map((i) => ({
            tabella: String(i.tabella),
            indice: String(i.indice),
            parziale: !!i.parziale,
            con_espressioni: !!i.con_espressioni,
            nulls_not_distinct: !!i.nulls_not_distinct,
            colonne: [...(i.colonne ?? [])].map(String).sort(),
        }))
        .sort((a, b) => a.tabella.localeCompare(b.tabella) || a.indice.localeCompare(b.indice))
    return { indici }
}

/** Impronta del solo contenuto: i metadati restano fuori. */
export function impronta(normalizzata) {
    return createHash('sha256').update(JSON.stringify(normalizzata)).digest('hex')
}

// L'ISTANTE dello scatto, UTC al secondo — non la sola data. Serve a
// `__tests__/architecture/soglia-fotografia.ts` per distinguere una migrazione NUOVA da una
// fotografia VECCHIA.
const ADESSO = new Date().toISOString().replace(/\.\d+Z$/, 'Z')

const normalizzata = normalizza(estrai(readFileSync(0, 'utf8')))
const uscita = {
    _come_si_rigenera:
        'node __tests__/fixtures/indici-unici-fotografia.mjs --sql | (esegui su prod) ; node __tests__/fixtures/indici-unici-fotografia.mjs < risposta.json',
    generato_il: ADESSO.slice(0, 10),
    generato_alle: ADESSO,
    sha256: impronta(normalizzata),
    ...normalizzata,
}

const dest = join(process.cwd(), '__tests__', 'fixtures', 'indici-unici-snapshot.json')
writeFileSync(dest, JSON.stringify(uscita, null, 2) + '\n', 'utf8')
const parziali = normalizzata.indici.filter((i) => i.parziale).length
const conEspressioni = normalizzata.indici.filter((i) => i.con_espressioni).length
process.stdout.write(
    `fotografia scritta: ${dest}\n` +
    `  indici unique: ${normalizzata.indici.length} · di cui parziali: ${parziali}` +
    ` · su espressione: ${conEspressioni} · sha256: ${uscita.sha256.slice(0, 12)}…\n`,
)
