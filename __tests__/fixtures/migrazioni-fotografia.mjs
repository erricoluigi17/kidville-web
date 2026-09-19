#!/usr/bin/env node
/**
 * Rigenera la fotografia versionata delle MIGRAZIONI APPLICATE in produzione:
 *   __tests__/fixtures/migrazioni-applicate-snapshot.json
 *
 * Il lock `__tests__/architecture/migrazioni-complete.test.ts` gira OFFLINE (vitest,
 * in CI, senza il database di produzione — e le credenziali di produzione in CI non
 * ci sono e non devono esserci): la sua unica sorgente di verita' e' quel file.
 * Perche' non possa essere addomesticato a mano per far tacere il lock, porta un
 * `sha256` del contenuto normalizzato: chi lo modifica senza rigenerarlo fa fallire
 * il test. Stessa forma di `rls-fotografia.mjs` e `fk-sede-fotografia.mjs` (in
 * `scripts/`), che fanno lo stesso mestiere per la RLS e per le FK di sede.
 *
 * QUESTO SCRIPT NON GUARDA IL DISCO. La fotografia e' la verita' del DATABASE: se
 * l'elenco lo ricavasse dalla cartella delle migrazioni, il lock confronterebbe
 * quella cartella con se stessa — verde per costruzione, cioe' nessun controllo. Il
 * lock ha una prova dedicata che lo verifica leggendo QUESTO file.
 *
 * ─── COME SI RIGENERA ──────────────────────────────────────────────────────────
 * 1. Esegui sul DB di produzione la query che stampa
 *    `node __tests__/fixtures/migrazioni-fotografia.mjs --sql`
 *    (strumento MCP `execute_sql`, oppure `psql "$DATABASE_URL" -Atc "<query>"`).
 *    E' di SOLA LETTURA e legge una sola tabella, quella che il CLI usa per sapere
 *    che cosa ha gia' applicato.
 * 2. Salva la risposta JSON in un file (va bene sia l'array che restituisce l'MCP,
 *    sia l'oggetto nudo).
 * 3. `node __tests__/fixtures/migrazioni-fotografia.mjs < risposta.json`
 * 4. `npx vitest run __tests__/architecture/migrazioni-complete.test.ts`
 *
 * VA RIGENERATA DOPO OGNI `apply_migration`.
 *
 * 🔴 E QUI C'ERA UNA FRASE FALSA, corretta il 2026-09-19 dopo averla MESSA ALLA PROVA.
 * Diceva: «finche' non lo fai il lock resta rosso: e' voluto». Non e' vero nel caso
 * normale, ed e' stato misurato cosi':
 *   · fotografia del 18/09 (178 migrazioni), migrazione `20260919132612` scritta il
 *     19/09 e applicata il 19/09, fotografia NON rigenerata → lock **VERDE**, 11/11;
 *   · stessa fotografia a 178 righe ma DATATA 19/09 → lock **ROSSO**, con il
 *     messaggio giusto («portano un timestamp ANTERIORE all'istante dello scatto»).
 * Il motivo e' `sogliaFotografia`: le migrazioni piu' RECENTI dello scatto sono
 * esentate, e giustamente — una migrazione appena scritta e' legittimamente in
 * attesa. Ma quella che scrivi e applichi oggi e' sempre piu' recente della
 * fotografia di ieri, quindi resta esente **per sempre**, finche' nessuno rigenera.
 *
 * 🔑 Quindi, al contrario di come suonava: **rigenerare la fotografia e' cio' che ARMA
 * il lock, non cio' che lo spegne.** Sposta avanti la soglia, e da quel momento ogni
 * file rimasto indietro diventa visibile. Niente ti obbliga a farlo — la disciplina e'
 * l'unica cosa che la fa rispettare, e per questo va scritta qui e non sottintesa.
 *
 * NON si connette da solo al database: `.env.local` punta alla PRODUZIONE e uno
 * script che si collega da se' e' uno script che prima o poi ci scrive. Qui entra
 * solo testo, da stdin.
 */

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Due fatti, e nient'altro: la `version` con cui ogni migrazione e' stata applicata
// e il suo `name`. Insieme formano il nome canonico del file — `<version>_<name>.sql` —
// ed e' quel nome che il lock cerca nel repo. L'`order by version` non e' cosmetico:
// e' l'ordine di applicazione reale, l'unica cosa che una migrazione garantisce.
const SQL = `select json_build_object(
  'migrazioni', (
    select coalesce(json_agg(json_build_object('version', m.version, 'name', m.name)
                             order by m.version), '[]'::json)
    from supabase_migrations.schema_migrations m
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
    // Tollera anche la risposta nuda di `select version, name from …` (un array di righe).
    if (Array.isArray(v)) v = { migrazioni: v }
    if (!v || !Array.isArray(v.migrazioni)) {
        throw new Error('JSON non riconosciuto: manca `migrazioni`. Rilancia la query di --sql.')
    }
    return v
}

/** Normalizzazione: ordine stabile per version, campi in ordine fisso, niente `undefined`. */
export function normalizza(f) {
    const migrazioni = f.migrazioni
        .map((m) => ({ version: String(m.version), name: String(m.name ?? '') }))
        .sort((a, b) => a.version.localeCompare(b.version))
    return { migrazioni }
}

/** Impronta del solo contenuto: `generato_il` e `sha256` restano fuori. */
export function impronta(normalizzata) {
    return createHash('sha256').update(JSON.stringify(normalizzata)).digest('hex')
}

// L'ISTANTE dello scatto, in UTC e al secondo — non la sola data. Qui serve a
// distinguere due cose che il lock prima confondeva: una migrazione che sta sul disco
// e non nella fotografia perche' e' NUOVA (scritta dopo lo scatto, non ancora
// applicata) da una che ci sta perche' la FOTOGRAFIA E' VECCHIA. La prima e' normale,
// la seconda e' il difetto che questo lock esiste per trovare.
// Vedi `__tests__/architecture/soglia-fotografia.ts`.
const ADESSO = new Date().toISOString().replace(/\.\d+Z$/, 'Z')

const stdin = readFileSync(0, 'utf8')
const normalizzata = normalizza(estrai(stdin))
const uscita = {
    _come_si_rigenera:
        'node __tests__/fixtures/migrazioni-fotografia.mjs --sql | (esegui su prod) ; node __tests__/fixtures/migrazioni-fotografia.mjs < risposta.json',
    generato_il: ADESSO.slice(0, 10),
    generato_alle: ADESSO,
    sha256: impronta(normalizzata),
    ...normalizzata,
}

const dest = join(process.cwd(), '__tests__', 'fixtures', 'migrazioni-applicate-snapshot.json')
writeFileSync(dest, JSON.stringify(uscita, null, 2) + '\n', 'utf8')
const ultima = normalizzata.migrazioni[normalizzata.migrazioni.length - 1]
process.stdout.write(
    `fotografia scritta: ${dest}\n` +
    `  migrazioni applicate: ${normalizzata.migrazioni.length}` +
    `${ultima ? ` · ultima: ${ultima.version}_${ultima.name}` : ''}` +
    ` · sha256: ${uscita.sha256.slice(0, 12)}…\n`,
)
