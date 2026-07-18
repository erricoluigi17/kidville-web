import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// ─────────────────────────────────────────────────────────────────────────────
// LOCK di sicurezza — ogni funzione SECURITY DEFINER revoca EXECUTE da anon/authenticated
//
// In Supabase i ruoli `anon` e `authenticated` ricevono EXECUTE sulle funzioni via
// GRANT ESPLICITO (ALTER DEFAULT PRIVILEGES), NON tramite PUBLIC: un
// `REVOKE ... FROM PUBLIC` non li tocca. Una funzione `SECURITY DEFINER` (gira come
// owner, bypassa la RLS) senza REVOKE resta quindi chiamabile in anonimo via
// `/rest/v1/rpc/<fn>` con la sola anon key pubblica → IDOR / bypass del gate applicativo.
// È esattamente la regressione delle RPC mensa (2026-07-18): la difesa è
// `REVOKE ALL ON FUNCTION public.<fn>(...) FROM PUBLIC, anon, authenticated;`.
//
// Questo lock impedisce che una NUOVA migrazione introduca una SECURITY DEFINER senza
// revocarne l'esecuzione ad anon/authenticated.
// ─────────────────────────────────────────────────────────────────────────────

// File pre-esistenti con SECURITY DEFINER legittimamente eseguibili da `authenticated`
// (usano auth.uid() e ritornano SOLO lo scope del chiamante — es. current_parent_student_ids,
// is_staff_or_admin) o comunque da rivedere prima del lancio pubblico. NON aggiungere qui una
// migrazione NUOVA per aggirare il lock: aggiungi il REVOKE, oppure — se la funzione è davvero
// per authenticated — inseriscila con motivazione esplicita.
const ALLOWLIST = new Set<string>([
  '20260704120000_baseline.sql', // current_parent_student_ids(), is_staff_or_admin() — auth.uid(), da rivedere pre-lancio
  '20260706105201_anagrafiche_residenza_provincia_civico.sql', // trigger/helper anagrafica pre-esistente
])

const MIGRATIONS_DIR = join(process.cwd(), 'supabase', 'migrations')

describe('lock architettura · SECURITY DEFINER senza EXECUTE per anon/authenticated', () => {
  const conSecurityDefiner = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .filter((f) => /SECURITY\s+DEFINER/i.test(readFileSync(join(MIGRATIONS_DIR, f), 'utf8')))
    .sort()

  it('esistono migrazioni con SECURITY DEFINER da controllare (sanity)', () => {
    expect(conSecurityDefiner.length).toBeGreaterThan(0)
  })

  for (const f of conSecurityDefiner) {
    if (ALLOWLIST.has(f)) continue
    it(`${f} revoca EXECUTE da anon/authenticated`, () => {
      const sql = readFileSync(join(MIGRATIONS_DIR, f), 'utf8')
      const revocaAnonOAuth = /REVOKE\b[\s\S]*?\b(anon|authenticated)\b/i.test(sql)
      expect(
        revocaAnonOAuth,
        `${f} crea/aggiorna una funzione SECURITY DEFINER ma non revoca EXECUTE da anon/authenticated. ` +
          `In Supabase REVOKE ... FROM PUBLIC non basta: aggiungi ` +
          `"REVOKE ALL ON FUNCTION public.<fn>(...) FROM PUBLIC, anon, authenticated;" (+ GRANT EXECUTE ... TO service_role). ` +
          `Se la funzione è legittimamente per authenticated (usa auth.uid()), aggiungila all'ALLOWLIST con motivazione.`,
      ).toBe(true)
    })
  }
})
