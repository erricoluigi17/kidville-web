#!/usr/bin/env node
/**
 * Rigenera la fotografia versionata dell'INTEGRITA' DI SCHEMA sulle sedi:
 *   __tests__/fixtures/fk-scuola-id-snapshot.json
 *
 * Il lock `__tests__/architecture/fk-scuola-id.test.ts` gira OFFLINE (vitest, in CI,
 * senza il database di produzione): la sua unica sorgente di verita' e' quel file.
 * Perche' non possa essere addomesticato a mano per far tacere il lock, porta un
 * `sha256` del contenuto normalizzato: chi lo modifica senza rigenerarlo fa fallire
 * il test. Stessa forma di `scripts/rls-fotografia.mjs`.
 *
 * ─── COME SI RIGENERA ──────────────────────────────────────────────────────────
 * 1. Esegui sul DB di produzione la query che stampa `node scripts/fk-sede-fotografia.mjs --sql`
 *    (strumento MCP `execute_sql`, oppure `psql "$DATABASE_URL" -Atc "<query>"`).
 *    E' una query di SOLA LETTURA su pg_class / pg_attribute / pg_constraint.
 * 2. Salva la risposta JSON in un file (va bene sia l'array che restituisce l'MCP,
 *    sia l'oggetto nudo).
 * 3. `node scripts/fk-sede-fotografia.mjs < risposta.json`
 * 4. `npx vitest run __tests__/architecture/fk-scuola-id.test.ts`
 *
 * NON si connette da solo al database: `.env.local` punta alla PRODUZIONE e uno script
 * che si collega da se' e' uno script che prima o poi ci scrive. Qui entra solo testo.
 */

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Tre fatti, e nient'altro:
//  • `tabelle`  → ogni tabella di `public` che HA una colonna `scuola_id`, con il
//                 vincolo di integrita' che la lega alle sedi (o la sua assenza);
//  • `alunni_colonne_cf` → quali colonne di codice fiscale esistono ancora su `alunni`
//                 (la doppia nomenclatura italiano/inglese: `codice_fiscale` viva,
//                 `fiscal_code` dismessa);
//  • `alunni_vincoli_cf` → i vincoli che le riguardano, per intero. Serve a tenere
//                 fermo che l'UNIQUE globale su `codice_fiscale` e' VOLUTO (impedisce
//                 la doppia iscrizione dello stesso minore in due sedi) e che quello
//                 sulla colonna dismessa NON deve tornare.
const SQL = `SELECT json_build_object(
  'tabelle', (
    SELECT coalesce(json_agg(x ORDER BY x.tabella), '[]'::json) FROM (
      SELECT c.relname AS tabella,
             a.attnotnull AS not_null,
             (SELECT k.conname FROM pg_constraint k
               WHERE k.contype='f' AND k.conrelid=c.oid AND a.attnum = ANY(k.conkey)
               ORDER BY k.conname LIMIT 1) AS fk_nome,
             (SELECT k.confrelid::regclass::text FROM pg_constraint k
               WHERE k.contype='f' AND k.conrelid=c.oid AND a.attnum = ANY(k.conkey)
               ORDER BY k.conname LIMIT 1) AS fk_verso
      FROM pg_class c
      JOIN pg_namespace n ON n.oid=c.relnamespace AND n.nspname='public'
      JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname='scuola_id'
                         AND a.attnum>0 AND NOT a.attisdropped
      WHERE c.relkind='r'
    ) x
  ),
  'alunni_colonne_cf', (
    SELECT coalesce(json_agg(a.attname ORDER BY a.attname), '[]'::json)
    FROM pg_attribute a
    WHERE a.attrelid='public.alunni'::regclass AND a.attnum>0 AND NOT a.attisdropped
      AND a.attname IN ('codice_fiscale','fiscal_code')
  ),
  'alunni_vincoli_cf', (
    SELECT coalesce(json_agg(json_build_object('nome', k.conname, 'def', pg_get_constraintdef(k.oid))
                             ORDER BY k.conname), '[]'::json)
    FROM pg_constraint k
    WHERE k.conrelid='public.alunni'::regclass AND pg_get_constraintdef(k.oid) ILIKE '%fiscal%'
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

/** Normalizzazione: ordine stabile, campi in ordine fisso, niente `undefined`. */
export function normalizza(f) {
    const tabelle = f.tabelle
        .map((t) => ({
            tabella: t.tabella,
            not_null: t.not_null === true,
            fk_nome: t.fk_nome ?? null,
            fk_verso: t.fk_verso ?? null,
        }))
        .sort((a, b) => a.tabella.localeCompare(b.tabella))
    const vincoli = (f.alunni_vincoli_cf ?? [])
        .map((v) => ({ nome: v.nome, def: (v.def ?? '').replace(/\s+/g, ' ').trim() }))
        .sort((a, b) => a.nome.localeCompare(b.nome))
    return {
        tabelle,
        alunni_colonne_cf: [...(f.alunni_colonne_cf ?? [])].sort(),
        alunni_vincoli_cf: vincoli,
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
        'node scripts/fk-sede-fotografia.mjs --sql | (esegui su prod) ; node scripts/fk-sede-fotografia.mjs < risposta.json',
    generato_il: new Date().toISOString().slice(0, 10),
    sha256: impronta(normalizzata),
    ...normalizzata,
}

const dest = join(process.cwd(), '__tests__', 'fixtures', 'fk-scuola-id-snapshot.json')
writeFileSync(dest, JSON.stringify(uscita, null, 2) + '\n', 'utf8')
const senzaFk = normalizzata.tabelle.filter((t) => !t.fk_nome)
process.stdout.write(
    `fotografia scritta: ${dest}\n` +
    `  tabelle con scuola_id: ${normalizzata.tabelle.length}` +
    ` · senza FK: ${senzaFk.length}${senzaFk.length ? ' (' + senzaFk.map((t) => t.tabella).join(', ') + ')' : ''}` +
    ` · sha256: ${uscita.sha256.slice(0, 12)}…\n`,
)
