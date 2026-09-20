#!/usr/bin/env node
/**
 * Rigenera la fotografia versionata delle CHIAVI ESTERNE VERSO `utenti(id)`:
 *   __tests__/fixtures/fk-utenti-snapshot.json
 *
 * Il lock `__tests__/architecture/tracce-docente-dichiarate.test.ts` gira OFFLINE (vitest, in
 * CI, senza le credenziali di produzione — che in CI non ci sono e non devono esserci): la sua
 * unica sorgente di verita' e' questo file. Porta un `sha256` del contenuto normalizzato, cosi'
 * non lo si puo' addomesticare a mano per far tacere il lock, e un `generato_alle` per non
 * restare verde mentre non sa piu' niente.
 *
 * VA RIGENERATA DOPO OGNI `apply_migration` CHE CREI O CAMBI UNA FK VERSO `utenti`.
 *
 * NON SI CONNETTE DA SE' AL DATABASE: `.env.local` punta alla PRODUZIONE, e uno script che si
 * collega da solo e' uno script che prima o poi ci scrive. Qui entra solo testo, da stdin.
 *
 * ─── PERCHE' ESISTE ───────────────────────────────────────────────────────────
 * `src/lib/personale/tracce-docente-voci.ts` decide se un docente si CANCELLA o si ARCHIVIA
 * guardando un registro scritto a mano. Un registro scritto a mano invecchia in silenzio: una
 * tabella nuova con una FK verso `utenti` non comparirebbe, e l'anteprima direbbe «si cancella»
 * su un docente che non si cancella — oppure, peggio, lo cancellerebbe portandosi via a cascata
 * una cosa che nessuno aveva censito.
 *
 * ⚠️ E la `ON DELETE` conta quanto l'esistenza della chiave. Una FK che oggi e' `NO ACTION`
 * BLOCCA la cancellazione (rumorosa, innocua); la stessa portata a `CASCADE` da una migrazione
 * la fa RIUSCIRE, distruggendo le righe collegate senza un errore. Per questo la fotografia
 * porta `azione` e il lock la confronta: e' la meta' del problema che non si vede.
 *
 * ─── COME SI RIGENERA ─────────────────────────────────────────────────────────
 * 1. `node __tests__/fixtures/fk-utenti-fotografia.mjs --sql`
 * 2. esegui quella query sul DB di produzione (`supabase db query --linked "$(…)"` dalla radice,
 *    oppure lo strumento MCP `execute_sql`): e' di SOLA LETTURA e guarda solo il catalogo di
 *    sistema, nemmeno una riga di dati
 * 3. salva la risposta in un file
 * 4. `node __tests__/fixtures/fk-utenti-fotografia.mjs < risposta.json`
 * 5. `npx vitest run __tests__/architecture/tracce-docente-dichiarate.test.ts`
 */

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// `confdeltype` e' la ragione di questa query: 'c' = CASCADE, 'n' = SET NULL, 'r' = RESTRICT,
// 'a' = NO ACTION. RESTRICT e NO ACTION si mappano entrambi su `blocca` perche' per chi decide
// sono la stessa cosa — la DELETE viene rifiutata — e distinguerli inviterebbe a scrivere due
// rami identici.
//
// Si legge `pg_constraint` e non `information_schema`: quest'ultimo, sulle chiavi composte,
// moltiplica le righe per il prodotto delle colonne e fa comparire coppie che non esistono.
const SQL = `select json_build_object(
  'fk', (
    select coalesce(json_agg(json_build_object(
             'tabella', c.conrelid::regclass::text,
             'colonna', a.attname::text,
             'azione',  case c.confdeltype
                          when 'c' then 'cascade'
                          when 'n' then 'set-null'
                          else 'blocca'
                        end
           ) order by c.conrelid::regclass::text, a.attname::text), '[]'::json)
    from pg_constraint c
    join unnest(c.conkey) with ordinality k(attnum, ord) on true
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
    where c.contype = 'f' and c.confrelid = 'public.utenti'::regclass
  )
) as fotografia;`

if (process.argv.includes('--sql')) {
    process.stdout.write(SQL + '\n')
    process.exit(0)
}

/** Estrae l'oggetto fotografia da qualunque involucro l'MCP/psql/CLI gli metta intorno. */
function estrai(grezzo) {
    let v = JSON.parse(grezzo)
    // La CLI Supabase incarta la risposta in `{ rows: [...] }`; l'MCP la da' come array nudo.
    if (v && typeof v === 'object' && Array.isArray(v.rows)) v = v.rows
    if (Array.isArray(v)) v = v[0]
    if (v && typeof v === 'object' && v.fotografia) v = v.fotografia
    if (Array.isArray(v)) v = { fk: v }
    if (!v || !Array.isArray(v.fk)) {
        throw new Error('JSON non riconosciuto: manca `fk`. Rilancia la query di --sql.')
    }
    return v
}

/** Ordine stabile, campi in ordine fisso, niente `undefined`. */
export function normalizza(f) {
    const fk = f.fk
        .map((r) => ({
            tabella: String(r.tabella).replace(/^public\./, ''),
            colonna: String(r.colonna),
            azione: String(r.azione),
        }))
        .sort((a, b) => a.tabella.localeCompare(b.tabella) || a.colonna.localeCompare(b.colonna))
    return { fk }
}

/** Impronta del solo contenuto: i metadati restano fuori. */
export function impronta(normalizzata) {
    return createHash('sha256').update(JSON.stringify(normalizzata)).digest('hex')
}

// L'ISTANTE dello scatto, UTC al secondo — non la sola data.
const ADESSO = new Date().toISOString().replace(/\.\d+Z$/, 'Z')

const normalizzata = normalizza(estrai(readFileSync(0, 'utf8')))
const uscita = {
    _come_si_rigenera:
        'node __tests__/fixtures/fk-utenti-fotografia.mjs --sql | (esegui su prod) ; node __tests__/fixtures/fk-utenti-fotografia.mjs < risposta.json',
    generato_il: ADESSO.slice(0, 10),
    generato_alle: ADESSO,
    sha256: impronta(normalizzata),
    ...normalizzata,
}

const dest = join(process.cwd(), '__tests__', 'fixtures', 'fk-utenti-snapshot.json')
writeFileSync(dest, JSON.stringify(uscita, null, 2) + '\n', 'utf8')
const perAzione = normalizzata.fk.reduce((acc, r) => ({ ...acc, [r.azione]: (acc[r.azione] ?? 0) + 1 }), {})
process.stdout.write(
    `fotografia scritta: ${dest}\n` +
    `  chiavi esterne verso utenti(id): ${normalizzata.fk.length}` +
    ` · ${Object.entries(perAzione).map(([k, v]) => `${k}: ${v}`).join(' · ')}` +
    ` · sha256: ${uscita.sha256.slice(0, 12)}…\n`,
)
