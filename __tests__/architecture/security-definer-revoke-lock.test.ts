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

// File pre-esistenti con SECURITY DEFINER legittimamente eseguibili da `authenticated`:
// usano auth.uid() e ritornano SOLO lo scope del chiamante. NON aggiungere qui una
// migrazione NUOVA per aggirare il lock: aggiungi il REVOKE, oppure — se la funzione è davvero
// per authenticated — inseriscila con motivazione esplicita.
const ALLOWLIST = new Set<string>([
  // Definisce due funzioni. `current_parent_student_ids()` resta eseguibile da
  // `authenticated`: ritorna i SOLI figli di chi chiama, ed è il perno delle policy
  // «parents space» (senza di lei quelle policy non funzionerebbero, perché una
  // sottoquery dentro un'espressione di policy è a sua volta soggetta alla RLS).
  // `is_staff_or_admin()` NON lo è più: la revisione pre-lancio qui annunciata è
  // stata fatta il 2026-07-31 (audit multi-sede, R97). Non filtrava per sede e aveva
  // la lista dei ruoli invertita — dentro la cuoca, fuori la segreteria — e le sette
  // policy che la usavano su form_models/form_submissions sono state droppate:
  // vedi 20260731102245_rls_multisede_pulizia.sql, che ne revoca l'EXECUTE ad
  // anon/authenticated.
  '20260704120000_baseline.sql',
  '20260706105201_anagrafiche_residenza_provincia_civico.sql', // trigger/helper anagrafica pre-esistente
])

const MIGRATIONS_DIR = join(process.cwd(), 'supabase', 'migrations')

/**
 * Via i commenti prima di cercare `SECURITY DEFINER`.
 *
 * Il lock cercava la stringa nel file intero, prosa compresa: una migrazione che
 * NON crea nessuna funzione ma SPIEGA nel proprio commento perché passa da
 * `current_parent_student_ids()` (che è `SECURITY DEFINER`) veniva accusata di non
 * revocare l'EXECUTE di una funzione che non esiste. Un lock che punisce chi
 * documenta insegna a non documentare — e, peggio, la scorciatoia per farlo tacere
 * è scrivere la parola in modo diverso, cioè nascondere proprio l'informazione che
 * il lock esiste per sorvegliare. Qui si guarda l'SQL che viene eseguito.
 */
function sqlSenzaCommenti(testo: string): string {
  return testo.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ')
}

/**
 * Il file DEFINISCE una funzione `SECURITY DEFINER`?
 *
 * Servono due segnali insieme, sull'SQL eseguito: la clausola `SECURITY DEFINER` e
 * una `CREATE [OR REPLACE] FUNCTION`. Il secondo è quello che tiene il lock onesto:
 * una funzione con i privilegi del proprietario non si crea in nessun altro modo —
 * nemmeno via SQL dinamico, che quella stessa `CREATE FUNCTION` deve pur scriverla
 * dentro la stringa che esegue. Senza il legame, bastava NOMINARE la clausola
 * dentro un `COMMENT ON … IS '…'` — cioè spiegare a chi legge il database perché
 * una policy passa da `current_parent_student_ids()` — per essere accusati di non
 * aver revocato l'EXECUTE di una funzione mai creata.
 */
function definisceSecurityDefiner(testo: string): boolean {
  const sql = sqlSenzaCommenti(testo)
  return /SECURITY\s+DEFINER/i.test(sql) && /CREATE\s+(OR\s+REPLACE\s+)?FUNCTION/i.test(sql)
}

describe('lock architettura · SECURITY DEFINER senza EXECUTE per anon/authenticated', () => {
  const conSecurityDefiner = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .filter((f) => definisceSecurityDefiner(readFileSync(join(MIGRATIONS_DIR, f), 'utf8')))
    .sort()

  it('esistono migrazioni con SECURITY DEFINER da controllare (sanity)', () => {
    expect(conSecurityDefiner.length).toBeGreaterThan(0)
  })

  for (const f of conSecurityDefiner) {
    if (ALLOWLIST.has(f)) continue
    it(`${f} revoca EXECUTE da anon/authenticated`, () => {
      // Anche il REVOKE si cerca sull'SQL eseguito: un REVOKE citato in un commento
      // non revoca niente, e farebbe passare il lock su una funzione davvero aperta.
      const sql = sqlSenzaCommenti(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'))
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
