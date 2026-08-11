#!/usr/bin/env node
/**
 * Rigenera la fotografia versionata dello SCHEMA di `candidature_insegnanti`:
 *   __tests__/fixtures/candidature-schema-snapshot.json
 *
 * PERCHÉ ESISTE. Il template `src/lib/forms/insegnanti-template.ts` usa l'`id` di
 * ogni campo come NOME DI COLONNA di destinazione, e i `value` di `GRADI_OPTIONS`
 * come etichette dell'enum `school_type_enum`. Sono due promesse fatte al database
 * che, senza questo file, nessun test verifica: il lock scritto finora confrontava
 * gli id con un elenco ribattuto a mano e derivava `db_mapping` dall'id stesso —
 * cioè una tautologia, verde qualunque cosa ci sia scritto. Il primo a scoprire una
 * divergenza sarebbe stato il primo invio vero, con `PGRST204` (colonna assente in
 * INSERT) o `22P02` (valore fuori enum).
 *
 * Stessa forma e stesso mestiere di `migrazioni-fotografia.mjs`: il lock gira
 * OFFLINE (vitest, in CI, senza le credenziali di produzione — che in CI non ci sono
 * e non devono esserci), quindi la sua unica sorgente di verità è questo JSON. Per
 * non poter essere addomesticato a mano, porta un `sha256` del contenuto
 * normalizzato: chi lo modifica senza rigenerarlo fa fallire il test.
 *
 * ─── COME SI RIGENERA ──────────────────────────────────────────────────────────
 * 1. `node __tests__/fixtures/candidature-schema-fotografia.mjs --sql`
 *    e si esegue la query sul DB di produzione (strumento MCP `execute_sql`, oppure
 *    `psql "$DATABASE_URL" -Atc "<query>"`). È di SOLA LETTURA e tocca soltanto i
 *    cataloghi di sistema: `information_schema.columns`, `pg_enum`, `pg_constraint`.
 * 2. Si salva la risposta JSON in un file.
 * 3. `node __tests__/fixtures/candidature-schema-fotografia.mjs < risposta.json`
 * 4. `npx vitest run __tests__/lib/insegnanti-template.test.ts`
 *
 * VA RIGENERATA DOPO OGNI MIGRAZIONE che tocchi `candidature_insegnanti` o l'enum
 * `school_type_enum` — aggiungere una quarta fascia d'età è esattamente il caso.
 *
 * NON si connette da solo al database: `.env.local` punta alla PRODUZIONE e uno
 * script che si collega da sé è uno script che prima o poi ci scrive. Qui entra
 * solo testo, da stdin.
 */

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Tre fatti, e nient'altro:
 *  · le COLONNE con la loro posizione ordinale, il tipo `udt_name` e la nullabilità
 *    — `udt_name` perché è l'unico campo che distingue `text[]` da
 *    `school_type_enum[]`, cioè la differenza fra «un quarto valore entra» e «un
 *    quarto valore prende 22P02»;
 *  · le ETICHETTE dell'enum `school_type_enum`, in ordine di `enumsortorder`;
 *  · i CHECK della tabella, con la loro definizione testuale — servono a leggere
 *    che cosa il database rifiuta davvero, invece di dedurlo dal nome del vincolo.
 */
const SQL = `select json_build_object(
  'tabella', 'candidature_insegnanti',
  'colonne', (
    select coalesce(json_agg(json_build_object(
             'posizione', c.ordinal_position,
             'nome', c.column_name,
             'udt', c.udt_name,
             'nullable', c.is_nullable = 'YES',
             'default', c.column_default
           ) order by c.ordinal_position), '[]'::json)
    from information_schema.columns c
    where c.table_schema = 'public' and c.table_name = 'candidature_insegnanti'
  ),
  'enum_school_type', (
    select coalesce(json_agg(e.enumlabel order by e.enumsortorder), '[]'::json)
    from pg_enum e join pg_type t on t.oid = e.enumtypid
    where t.typname = 'school_type_enum'
  ),
  'check', (
    select coalesce(json_agg(json_build_object(
             'nome', co.conname,
             'definizione', pg_get_constraintdef(co.oid)
           ) order by co.conname), '[]'::json)
    from pg_constraint co
    where co.conrelid = 'public.candidature_insegnanti'::regclass and co.contype = 'c'
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
    if (!v || !Array.isArray(v.colonne) || !Array.isArray(v.enum_school_type)) {
        throw new Error('JSON non riconosciuto: mancano `colonne` o `enum_school_type`. Rilancia la query di --sql.')
    }
    return v
}

/** Normalizzazione: campi in ordine fisso, niente `undefined`, ordini stabili. */
export function normalizza(f) {
    return {
        tabella: String(f.tabella ?? 'candidature_insegnanti'),
        colonne: f.colonne
            .map((c) => ({
                posizione: Number(c.posizione),
                nome: String(c.nome),
                udt: String(c.udt),
                nullable: Boolean(c.nullable),
                default: c.default == null ? null : String(c.default),
            }))
            .sort((a, b) => a.posizione - b.posizione),
        enum_school_type: f.enum_school_type.map(String),
        check: (f.check ?? [])
            .map((k) => ({ nome: String(k.nome), definizione: String(k.definizione) }))
            .sort((a, b) => a.nome.localeCompare(b.nome)),
    }
}

/** Impronta del solo contenuto: `generato_il` e `sha256` restano fuori. */
export function impronta(normalizzata) {
    return createHash('sha256').update(JSON.stringify(normalizzata)).digest('hex')
}

const ADESSO = new Date().toISOString().replace(/\.\d+Z$/, 'Z')

const stdin = readFileSync(0, 'utf8')
const normalizzata = normalizza(estrai(stdin))
const uscita = {
    _come_si_rigenera:
        'node __tests__/fixtures/candidature-schema-fotografia.mjs --sql | (esegui su prod) ; node __tests__/fixtures/candidature-schema-fotografia.mjs < risposta.json',
    generato_il: ADESSO.slice(0, 10),
    generato_alle: ADESSO,
    sha256: impronta(normalizzata),
    ...normalizzata,
}

const dest = join(process.cwd(), '__tests__', 'fixtures', 'candidature-schema-snapshot.json')
writeFileSync(dest, JSON.stringify(uscita, null, 2) + '\n', 'utf8')
process.stdout.write(
    `fotografia scritta: ${dest}\n` +
    `  colonne: ${normalizzata.colonne.length}` +
    ` · enum school_type: ${normalizzata.enum_school_type.join('/')}` +
    ` · check: ${normalizzata.check.length}` +
    ` · sha256: ${uscita.sha256.slice(0, 12)}…\n`,
)
