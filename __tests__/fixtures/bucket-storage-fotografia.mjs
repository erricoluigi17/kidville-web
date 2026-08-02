#!/usr/bin/env node
/**
 * Rigenera la fotografia versionata della VISIBILITA' DEI BUCKET dello Storage:
 *   __tests__/fixtures/bucket-storage-snapshot.json
 *
 * Il lock `__tests__/architecture/bucket-storage-dichiarati.test.ts` gira OFFLINE
 * (vitest, in CI, senza il database di produzione — e le credenziali di produzione in
 * CI non ci sono e non devono esserci): per la parte «chi e' pubblico e chi no» la sua
 * unica sorgente di verita' e' quel file. Serve perche' otto bucket su dodici non sono
 * dichiarati in nessuna migrazione: sono nati dalla console di Supabase, e per loro il
 * database e' l'unico posto dove la verita' esiste. Un bucket riaperto da li' non
 * lascerebbe traccia in nessun file del repo.
 *
 * Perche' la fotografia non possa essere addomesticata a mano per far tacere il lock,
 * porta un `sha256` del contenuto normalizzato: chi la modifica senza rigenerarla fa
 * fallire il test. Stessa forma di `migrazioni-fotografia.mjs` (qui accanto) e di
 * `rls-fotografia.mjs` / `fk-sede-fotografia.mjs` (in `scripts/`).
 *
 * QUESTO SCRIPT NON GUARDA IL DISCO. La fotografia e' la verita' del DATABASE: se la
 * ricavasse dai file del repo, il lock confronterebbe il repo con se stesso — verde per
 * costruzione, cioe' nessun controllo. Il lock ha una prova dedicata che lo verifica
 * leggendo QUESTO file.
 *
 * ─── COME SI RIGENERA ──────────────────────────────────────────────────────────
 * 1. Esegui sul DB di produzione la query che stampa
 *    `node __tests__/fixtures/bucket-storage-fotografia.mjs --sql`
 *    (strumento MCP `execute_sql`, oppure `psql "$DATABASE_URL" -Atc "<query>"`).
 *    E' di SOLA LETTURA e legge una sola tabella, e di quella due sole colonne.
 * 2. Salva la risposta JSON in un file (va bene sia l'array che restituisce l'MCP,
 *    sia l'oggetto nudo).
 * 3. `node __tests__/fixtures/bucket-storage-fotografia.mjs < risposta.json`
 * 4. `npx vitest run __tests__/architecture/bucket-storage-dichiarati.test.ts`
 *
 * VA RIGENERATA ogni volta che un bucket nasce, muore o cambia visibilita'. Finche'
 * non lo fai il lock resta rosso: e' voluto — e' l'unico momento in cui qualcuno
 * guarda davvero se lo Storage e' ancora chiuso come si era deciso.
 *
 * NON si connette da solo al database: `.env.local` punta alla PRODUZIONE e uno script
 * che si collega da se' e' uno script che prima o poi ci scrive. Qui entra solo testo,
 * da stdin.
 */

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Due fatti, e nient'altro: il nome del bucket e se lo Storage lo serve a chiunque
// conosca l'indirizzo. Il limite di dimensione e i tipi ammessi stanno fuori di
// proposito — cambiano spesso e non c'entrano con questa regola: tenerli qui dentro
// vorrebbe dire rigenerare (e far rileggere a qualcuno) la fotografia della
// SICUREZZA ogni volta che si alza un limite di upload.
const SQL = `select json_build_object(
  'bucket', (
    select coalesce(json_agg(json_build_object('id', b.id, 'public', b.public)
                             order by b.id), '[]'::json)
    from storage.buckets b
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
    // Tollera anche la risposta nuda di `select id, public from …` (un array di righe).
    if (Array.isArray(v)) v = { bucket: v }
    if (!v || !Array.isArray(v.bucket)) {
        throw new Error('JSON non riconosciuto: manca `bucket`. Rilancia la query di --sql.')
    }
    return v
}

/** Normalizzazione: ordine stabile per id, campi in ordine fisso, niente `undefined`. */
export function normalizza(f) {
    const bucket = f.bucket
        .map((b) => ({ id: String(b.id), pubblico: b.public === true }))
        .sort((a, b) => a.id.localeCompare(b.id))
    return { bucket }
}

/** Impronta del solo contenuto: `generato_il` e `sha256` restano fuori. */
export function impronta(normalizzata) {
    return createHash('sha256').update(JSON.stringify(normalizzata)).digest('hex')
}

const stdin = readFileSync(0, 'utf8')
const normalizzata = normalizza(estrai(stdin))
const uscita = {
    _come_si_rigenera:
        'node __tests__/fixtures/bucket-storage-fotografia.mjs --sql | (esegui su prod) ; node __tests__/fixtures/bucket-storage-fotografia.mjs < risposta.json',
    generato_il: new Date().toISOString().slice(0, 10),
    sha256: impronta(normalizzata),
    ...normalizzata,
}

const dest = join(process.cwd(), '__tests__', 'fixtures', 'bucket-storage-snapshot.json')
writeFileSync(dest, JSON.stringify(uscita, null, 2) + '\n', 'utf8')
const pubblici = normalizzata.bucket.filter((b) => b.pubblico).map((b) => b.id)
process.stdout.write(
    `fotografia scritta: ${dest}\n` +
    `  bucket: ${normalizzata.bucket.length}` +
    ` · pubblici: ${pubblici.length}${pubblici.length ? ' (' + pubblici.join(', ') + ')' : ''}` +
    ` · sha256: ${uscita.sha256.slice(0, 12)}…\n`,
)
