import { randomBytes } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

// =============================================================================
// Identità di accesso di un GENITORE — fonte unica (S6bis).
//
// Un genitore funzionante è composto da QUATTRO record che nessun trigger DB
// tiene allineati (verificato: zero trigger su auth.users):
//   1. `auth.users`                — account email+password (login);
//   2. `utenti` ruolo 'genitore'   — profilo con id == auth.uid(); è l'unica
//      tabella letta da loadAppUser: senza questa riga il login riesce ma ogni
//      route dati risponde 401 "Utente non trovato";
//   3. `parents.auth_user_id`      — ponte anagrafica↔account (UNIQUE, FK);
//   4. il legame col figlio (student_parents / legame_genitori_alunni).
//
// Storicamente ogni flusso ne creava un sottoinsieme diverso (anagrafica: solo
// 3-4; approvazione iscrizioni: 1-2; backfill S6: 1+3) producendo genitori
// "monchi": o il 409 all'invio credenziali, o login che entra e non vede nulla.
// `ensureParentIdentity` completa in modo IDEMPOTENTE i pezzi 1-3 mancanti; il
// legame (4) resta al chiamante, che conosce lo studente. Non lancia mai: ogni
// esito è un valore, così i chiamanti best-effort non falliscono il salvataggio.
// =============================================================================

export interface ParentIdentityInput {
  /** parents.id */
  id: string;
  auth_user_id?: string | null;
  emails?: unknown;
  first_name?: string | null;
  last_name?: string | null;
  /** telefono da riportare su utenti.cellulare (opzionale) */
  phone?: string | null;
}

export type EnsureParentIdentityResult =
  | {
      ok: true;
      authUserId: string;
      email: string;
      /** account auth.users creato ora (password temporanea in `password`) */
      createdAuth: boolean;
      /** riga `utenti` creata ora */
      createdUtenti: boolean;
      /** ponte parents.auth_user_id scritto ora */
      boundNow: boolean;
      /** password temporanea SOLO quando createdAuth (per invii immediati) */
      password: string | null;
    }
  | { ok: false; reason: 'no_email' | 'email_conflict' | 'error'; message: string };

/** Password iniziale forte e non indovinabile (le credenziali reali si emettono via S11). */
export function randomPassword(): string {
  return randomBytes(18).toString('base64url') + 'Aa1!';
}

/** Prima email valida da `parents.emails` (array o stringa singola). */
export function firstEmail(emails: unknown): string | null {
  if (Array.isArray(emails)) {
    const e = emails.find((x) => typeof x === 'string' && x.includes('@'));
    return e ? String(e).trim() : null;
  }
  if (typeof emails === 'string' && emails.includes('@')) return emails.trim();
  return null;
}

const PER_PAGE = 100;

/**
 * Cerca un auth.users per email. L'admin API non ha getUserByEmail: scansione
 * paginata O(utenti totali), accettabile alla scala attuale (decine di account);
 * stesso approccio del backfill S6.
 */
async function findAuthUserIdByEmail(admin: SupabaseClient, email: string): Promise<string | null> {
  const key = email.toLowerCase();
  let page = 1;
  for (;;) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: PER_PAGE });
    if (error) throw new Error(error.message);
    const users = data?.users ?? [];
    for (const u of users) if (u.email && u.email.toLowerCase() === key) return u.id;
    if (users.length < PER_PAGE) break;
    page++;
  }
  return null;
}

/**
 * Scuola per `utenti.scuola_id` (NOT NULL): quella passata, altrimenti l'unica
 * configurata (installazione mono-sede). Con più sedi il chiamante DEVE passarla.
 */
export async function resolveScuolaId(
  admin: SupabaseClient,
  preferred: string | null | undefined
): Promise<string | null> {
  if (preferred) return preferred;
  const { data } = await admin.from('schools').select('id').limit(2);
  return data && data.length === 1 ? (data[0].id as string) : null;
}

/**
 * Garantisce la riga `utenti` per un auth uid. Se esiste già NON la tocca (un
 * docente-genitore conserva il ruolo staff: il profilo genitore deriva dal
 * ponte, vedi getProfiliForAuthUid). `email`/`nome`/`cognome`/`scuola_id` sono
 * NOT NULL a DB; `role`/`first_name`/`last_name` sono colonne GENERATE: mai scriverle.
 */
export async function ensureUtentiRow(
  admin: SupabaseClient,
  row: { id: string; email: string; nome?: string | null; cognome?: string | null; cellulare?: string | null; scuolaId: string | null }
): Promise<{ created: boolean; error: string | null }> {
  const { data: ex, error: exErr } = await admin
    .from('utenti')
    .select('id')
    .eq('id', row.id)
    .maybeSingle();
  if (exErr) return { created: false, error: exErr.message };
  if (ex) return { created: false, error: null };
  if (!row.scuolaId) {
    return {
      created: false,
      error: 'scuola non determinabile (utenti.scuola_id è NOT NULL): impossibile creare il profilo genitore',
    };
  }
  const { error } = await admin.from('utenti').insert({
    id: row.id,
    email: row.email,
    nome: (row.nome ?? '').trim() || row.email.split('@')[0],
    cognome: (row.cognome ?? '').trim(),
    cellulare: row.cellulare ?? null,
    ruolo: 'genitore',
    scuola_id: row.scuolaId,
    attivo: true,
  });
  if (error) return { created: false, error: error.message };
  return { created: true, error: null };
}

/**
 * Completa l'identità di accesso di un genitore: crea/riusa l'account
 * `auth.users` (dedup per email), scrive il ponte `parents.auth_user_id` e
 * garantisce la riga `utenti` ruolo 'genitore'. Idempotente: i pezzi già
 * presenti vengono riusati senza modifiche. Non invia MAI email.
 */
export async function ensureParentIdentity(
  admin: SupabaseClient,
  parent: ParentIdentityInput,
  opts: { scuolaId?: string | null } = {}
): Promise<EnsureParentIdentityResult> {
  try {
    const email = firstEmail(parent.emails);
    if (!email) {
      return { ok: false, reason: 'no_email', message: 'Genitore senza email in anagrafica' };
    }

    let authUserId = parent.auth_user_id ?? null;
    let createdAuth = false;
    let password: string | null = null;
    let boundNow = false;

    if (!authUserId) {
      authUserId = await findAuthUserIdByEmail(admin, email);
      if (!authUserId) {
        password = randomPassword();
        const { data, error } = await admin.auth.admin.createUser({
          email,
          email_confirm: true,
          password,
        });
        if (error || !data?.user) {
          return {
            ok: false,
            reason: 'error',
            message: `Creazione account non riuscita: ${error?.message ?? 'errore sconosciuto'}`,
          };
        }
        authUserId = data.user.id;
        createdAuth = true;
      }

      // Ponte anagrafica↔account. UNIQUE(auth_user_id): se l'email è già
      // collegata a un'ALTRA anagrafica il DB rifiuta (23505) — meglio un
      // messaggio chiaro di un doppio legame che romperebbe resolveIdentity
      // (maybeSingle su parents per auth_user_id).
      const upd = await admin
        .from('parents')
        .update({ auth_user_id: authUserId })
        .eq('id', parent.id)
        .is('auth_user_id', null)
        .select('id');
      if (upd.error) {
        if ((upd.error as { code?: string }).code === '23505') {
          return {
            ok: false,
            reason: 'email_conflict',
            message: `L'email ${email} risulta già collegata a un'altra anagrafica genitore: correggere l'email o unificare le anagrafiche.`,
          };
        }
        return {
          ok: false,
          reason: 'error',
          message: `Collegamento anagrafica↔account non riuscito: ${upd.error.message}`,
        };
      }
      boundNow = (upd.data?.length ?? 0) > 0;
      if (!boundNow) {
        // Nessuna riga aggiornata: il ponte è stato scritto da altri nel
        // frattempo (o l'input era stantio). Rileggi e verifica coerenza.
        const cur = await admin
          .from('parents')
          .select('auth_user_id')
          .eq('id', parent.id)
          .maybeSingle();
        const curId = (cur.data as { auth_user_id?: string | null } | null)?.auth_user_id ?? null;
        if (curId && curId !== authUserId) {
          return { ok: false, reason: 'error', message: 'Anagrafica già collegata a un altro account' };
        }
        if (!curId) {
          return {
            ok: false,
            reason: 'error',
            message: `Collegamento anagrafica↔account non riuscito${cur.error ? `: ${cur.error.message}` : ''}`,
          };
        }
      }
    }

    const scuolaId = await resolveScuolaId(admin, opts.scuolaId ?? null);
    const utenti = await ensureUtentiRow(admin, {
      id: authUserId,
      email,
      nome: parent.first_name ?? null,
      cognome: parent.last_name ?? null,
      cellulare: parent.phone ?? null,
      scuolaId,
    });
    if (utenti.error) {
      return { ok: false, reason: 'error', message: `Profilo genitore (utenti) non creato: ${utenti.error}` };
    }

    return {
      ok: true,
      authUserId,
      email,
      createdAuth,
      createdUtenti: utenti.created,
      boundNow,
      password: createdAuth ? password : null,
    };
  } catch (e) {
    return { ok: false, reason: 'error', message: e instanceof Error ? e.message : String(e) };
  }
}
