/* ════════════════════════════════════════════════════════════════════════════
 * I PREDICATI PURI SUI RUOLI — e perché vivono QUI e non in `require-staff.ts`.
 *
 * ─── IL MOTIVO, CONTATO E NON TEMUTO ────────────────────────────────────────
 *
 * `require-staff.ts` teneva insieme due cose di natura diversa: le funzioni che
 * fanno I/O (`requireUser`, `resolveIdentity`, `loadAppUser`, i quattro gate) e i
 * predicati PURI sui ruoli. **296 file** di test contengono
 * `vi.mock('@/lib/auth/require-staff', () => ({ … }))` con una factory che
 * sostituisce quel modulo PER INTERO — è l'unico modo che hanno di iniettare
 * un'identità senza toccare la sessione Supabase — e così facendo sostituivano
 * anche la REGOLA DI AUTORIZZAZIONE, che nessuno di loro voleva toccare.
 *
 * Misurato, non ipotizzato: importare `eFamiglia` da `@/lib/auth/require-staff`
 * dentro `require-parent.ts` faceva diventare rossi **46 test su 7 file**, di cui
 * 40 con lo stesso identico errore —
 *   `[vitest] No "eFamiglia" export is defined on the "@/lib/auth/require-staff" mock`
 * — e quattro di quei sette file non c'entravano niente con l'autorizzazione
 * (`diary-students-genitori-unione`, `diary-students-id-gate`,
 * `parent-mensa-allergie`, `parent-onboarding`). Chi mockava l'I/O si ritrovava a
 * dover ri-fornire la regola, e per aggirarlo `require-parent.ts` era arrivato a
 * ri-dichiarare due predicati in casa propria: una regola scritta due volte è una
 * regola che prima o poi diverge.
 *
 * ─── LA REGOLA DEL FILE, IN UNA RIGA ────────────────────────────────────────
 *
 *   QUESTO MODULO NON FA I/O E NESSUNO LO MOCKA.
 *
 * Zero import di `next/*`, zero `@supabase/*`, zero client, zero `next/headers`:
 * dev'essere importabile da una route, da un componente `'use client'` e da un
 * test SENZA essere sostituito. `require-staff.ts` lo ri-esporta per intero, così
 * i call site esistenti non cambiano di una riga e i 296 mock restano validi
 * esattamente come prima.
 *
 * ⚠️ A CHI VENISSE VOGLIA DI RIFONDERLO DENTRO `require-staff.ts` fra sei mesi
 * perché «sono cinque funzioncine»: è precisamente il gesto che ripianta la
 * trappola, e ~28 punti in altrettante route dipendono da `agisceComeGenitore`.
 * Il lock `__tests__/architecture/predicati-ruolo-un-posto-solo.test.ts` diventa
 * rosso se si prova, e la prova di quel lock sta nella sua testata.
 *
 * ─── LA DISTINZIONE CHE QUESTI PREDICATI CUSTODISCONO ───────────────────────
 *
 *   AUTORIZZAZIONE = unione dei ruoli REALI, letti dal database → `haRuolo`,
 *                    `haUnRuolo`, `eFamiglia`
 *   PRESENTAZIONE  = ruolo ATTIVO, scelto col cookie `kv-active-role` →
 *                    `agisceComeGenitore`
 *
 * Il cookie non concede e non revoca niente: sceglie QUALE delle proprie viste
 * legittime si sta guardando. `eFamiglia` e `agisceComeGenitore` danno risposte
 * DIVERSE sulla stessa persona — le quattro insegnanti che sono anche genitori di
 * un bambino della scuola — ed è il punto, non un'incoerenza da appianare.
 * ════════════════════════════════════════════════════════════════════════════ */

export type StaffRole = 'admin' | 'coordinator' | 'segreteria'
export type AppRole = 'admin' | 'coordinator' | 'educator' | 'segreteria' | 'genitore' | 'cuoca'

export interface AppUser {
  id: string
  /** Ruolo ATTIVO: la veste in cui la persona sta agendo ORA. Default = `utenti.ruolo`. */
  role: AppRole
  /**
   * TUTTI i ruoli reali: `utenti.ruolo` + `genitore` se esiste il ponte
   * `parents.auth_user_id`. Sempre dal DATABASE, mai dal cookie.
   *
   * ⚠️ NON leggere questo campo direttamente: si usa `ruoliDi()`/`haRuolo()`.
   *    È opzionale perché molti test costruiscono un `AppUser` a mano, e perché il
   *    default (`[role]`) è ESATTAMENTE la semantica di oggi: per i 617 utenti con
   *    un ruolo solo il campo resta assente e non cambia niente.
   */
  ruoli?: readonly AppRole[]
  nome?: string | null
  cognome?: string | null
  scuola_id?: string | null
}

/** I ruoli REALI della persona. Assente `ruoli`, l'unico ruolo è quello attivo. */
export function ruoliDi(user: AppUser): readonly AppRole[] {
  return user.ruoli && user.ruoli.length > 0 ? user.ruoli : [user.role]
}

/** AUTORIZZAZIONE: ha questo ruolo nel DATABASE? (non «lo sta indossando adesso») */
export function haRuolo(user: AppUser, ruolo: AppRole): boolean {
  return ruoliDi(user).includes(ruolo)
}

/** AUTORIZZAZIONE: almeno uno dei ruoli reali è fra quelli ammessi. */
export function haUnRuolo(user: AppUser, ammessi: readonly AppRole[]): boolean {
  return ruoliDi(user).some((r) => ammessi.includes(r))
}

/**
 * PRESENTAZIONE: sta guardando l'app come genitore?
 *
 * Guarda il ruolo ATTIVO, quindi cambia quando la persona cambia veste. Serve a
 * decidere COSA MOSTRARE, mai se qualcuno può. Il gemello che decide i permessi è
 * `eFamiglia`, e i due danno risposte diverse sulla stessa persona: è il punto.
 */
export function agisceComeGenitore(user: AppUser): boolean {
  return user.role === 'genitore'
}

/** AUTORIZZAZIONE: è un genitore nel database? Non cambia con la veste indossata. */
export function eFamiglia(user: AppUser): boolean {
  return haRuolo(user, 'genitore')
}
