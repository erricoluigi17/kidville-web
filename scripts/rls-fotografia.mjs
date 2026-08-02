#!/usr/bin/env node
/**
 * Rigenera la fotografia versionata della RLS di produzione:
 *   __tests__/fixtures/pg-policies-snapshot.json
 *
 * Il lock `__tests__/architecture/rls-per-sede.test.ts` gira OFFLINE (vitest, in CI,
 * senza database): la sua unica sorgente di verita' e' quel file. Perche' il file non
 * possa essere addomesticato a mano per far tacere il lock, porta un `sha256` del
 * contenuto normalizzato: chi lo modifica senza rigenerarlo fa fallire il test.
 *
 * ─── COME SI RIGENERA ──────────────────────────────────────────────────────────
 * 1. Esegui sul DB di produzione la query che stampa `node scripts/rls-fotografia.mjs --sql`
 *    (strumento MCP `execute_sql`, oppure `psql "$DATABASE_URL" -Atc "<query>"`).
 *    E' una query di SOLA LETTURA su pg_policies / pg_class / pg_attribute.
 * 2. Salva la risposta JSON in un file (va bene sia l'array che restituisce l'MCP,
 *    sia l'oggetto nudo).
 * 3. `node scripts/rls-fotografia.mjs < risposta.json`
 * 4. `npx vitest run __tests__/architecture/rls-per-sede.test.ts`
 *
 * NON si connette da solo al database: `.env.local` punta alla PRODUZIONE e uno script
 * che si collega da se' e' uno script che prima o poi ci scrive. Qui entra solo testo.
 */

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// La fotografia contiene SOLO le policy che valgono per un ruolo diverso da
// `service_role`. Le altre sono irrilevanti per il lock — il service-role ha
// BYPASSRLS, le sue policy sono `USING (true)` per costruzione e sarebbero 74
// eccezioni permanenti in allowlist, cioe' esattamente il rumore in cui una
// policy vera passerebbe inosservata. Il loro NUMERO resta nella fotografia,
// come sentinella: se cambia, la fotografia va rigenerata.
const SQL = `SELECT json_build_object(
  'policies', (
    SELECT coalesce(json_agg(x ORDER BY x.tabella, x.cmd, x.policy), '[]'::json) FROM (
      SELECT p.tablename AS tabella, p.policyname AS policy, p.cmd,
             p.permissive, p.roles::text[] AS ruoli,
             regexp_replace(coalesce(p.qual,''), '\\s+', ' ', 'g') AS using_expr,
             regexp_replace(coalesce(p.with_check,''), '\\s+', ' ', 'g') AS check_expr
      FROM pg_policies p WHERE p.schemaname='public' AND p.roles::text <> '{service_role}'
    ) x
  ),
  'policy_solo_service_role', (
    SELECT count(*) FROM pg_policies p WHERE p.schemaname='public' AND p.roles::text = '{service_role}'
  ),
  'tabelle_con_scuola_id', (
    SELECT coalesce(json_agg(c.relname ORDER BY c.relname), '[]'::json)
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace AND n.nspname='public'
    WHERE c.relkind='r' AND EXISTS (
      SELECT 1 FROM pg_attribute a
      WHERE a.attrelid=c.oid AND a.attname='scuola_id' AND a.attnum>0 AND NOT a.attisdropped)
  ),
  'tabelle_rls_attiva', (
    SELECT coalesce(json_agg(c.relname ORDER BY c.relname), '[]'::json)
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace AND n.nspname='public'
    WHERE c.relkind='r' AND c.relrowsecurity
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
    if (!v || !Array.isArray(v.policies)) {
        throw new Error('JSON non riconosciuto: manca `policies`. Rilancia la query di --sql.')
    }
    return v
}

/** Normalizzazione: ordine stabile, spazi collassati, campi in ordine fisso. */
export function normalizza(f) {
    const policies = f.policies
        .map((p) => ({
            tabella: p.tabella,
            policy: p.policy,
            cmd: p.cmd,
            permissive: p.permissive,
            ruoli: [...p.ruoli].sort(),
            using_expr: (p.using_expr ?? '').replace(/\s+/g, ' ').trim(),
            check_expr: (p.check_expr ?? '').replace(/\s+/g, ' ').trim(),
        }))
        .sort((a, b) =>
            a.tabella.localeCompare(b.tabella) ||
            a.cmd.localeCompare(b.cmd) ||
            a.policy.localeCompare(b.policy),
        )
    return {
        policy_solo_service_role: Number(f.policy_solo_service_role ?? 0),
        policies,
        tabelle_con_scuola_id: [...(f.tabelle_con_scuola_id ?? [])].sort(),
        tabelle_rls_attiva: [...(f.tabelle_rls_attiva ?? [])].sort(),
    }
}

/** Impronta del solo contenuto: `generato_il` e `sha256` restano fuori. */
export function impronta(normalizzata) {
    return createHash('sha256').update(JSON.stringify(normalizzata)).digest('hex')
}

const stdin = readFileSync(0, 'utf8')
const normalizzata = normalizza(estrai(stdin))
const uscita = {
    _come_si_rigenera: 'node scripts/rls-fotografia.mjs --sql | (esegui su prod) ; node scripts/rls-fotografia.mjs < risposta.json',
    generato_il: new Date().toISOString().slice(0, 10),
    sha256: impronta(normalizzata),
    ...normalizzata,
}

const dest = join(process.cwd(), '__tests__', 'fixtures', 'pg-policies-snapshot.json')
writeFileSync(dest, JSON.stringify(uscita, null, 2) + '\n', 'utf8')
process.stdout.write(
    `fotografia scritta: ${dest}\n` +
    `  policy: ${normalizzata.policies.length}` +
    ` · non-service_role: ${normalizzata.policies.filter((p) => !(p.ruoli.length === 1 && p.ruoli[0] === 'service_role')).length}` +
    ` · sha256: ${uscita.sha256.slice(0, 12)}…\n`,
)
