import type { SupabaseClient } from '@supabase/supabase-js';
import { ensureUtentiRow, resolveScuolaId, randomPassword, dettaglioErroreAuth } from './parent-identity';
import { logEvento } from '@/lib/logging/logger';

export { randomPassword };

/**
 * Backfill identità auth per i GENITORI (P0/S6).
 *
 * Lo STAFF è già auth-backed (`utenti.id` FK → `auth.users`): non serve backfill;
 * l'eventuale staff senza password si ripara on-demand via "Rigenera credenziali"
 * (S11). Qui completiamo l'identità di ogni `parents` con email e senza
 * `auth_user_id`: account `auth.users` (dedup per email), ponte
 * `parents.auth_user_id` e riga `utenti` ruolo 'genitore' (senza quest'ultima il
 * login riesce ma ogni route dati risponde 401 — vedi parent-identity.ts).
 *
 * Idempotente: i parents già bindati sono esclusi dalla query; le email già
 * presenti in `auth.users` vengono riusate (no doppioni); le righe `utenti`
 * esistenti non vengono toccate (un docente-genitore conserva il ruolo staff).
 */

export interface BackfillReport {
  target: 'parents';
  dryRun: boolean;
  total: number;
  created: number;
  reused: number;
  bound: number;
  /** righe `utenti` ruolo 'genitore' create (solo run reale: 0 in dryRun) */
  utentiCreated: number;
  skippedNoEmail: number;
  errors: Array<{ id: string; email?: string; error: string }>;
}

interface ParentRow {
  id: string;
  emails: string[] | null;
  first_name?: string | null;
  last_name?: string | null;
}

function firstEmail(emails: string[] | null): string | null {
  if (!emails || emails.length === 0) return null;
  const e = emails.find((x) => x && x.includes('@'));
  return e ? e.trim() : null;
}

const PER_PAGE = 100;

async function buildEmailIndex(admin: SupabaseClient): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  let page = 1;
  for (;;) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: PER_PAGE });
    // Il corpo dell'errore non si butta via: `error.message` di GoTrue può essere
    // `undefined` (riga di `auth.users` non serializzabile che fa fallire l'intera
    // pagina) o vuoto. La normalizzazione è UNA sola, in `parent-identity.ts`.
    if (error) {
      throw new Error(`auth.admin.listUsers (pagina ${page}): ${dettaglioErroreAuth(error)}`);
    }
    const users = data?.users ?? [];
    for (const u of users) if (u.email) map.set(u.email.toLowerCase(), u.id);
    if (users.length < PER_PAGE) break;
    page++;
  }
  return map;
}

export async function backfillParentsAuth(
  admin: SupabaseClient,
  { dryRun, scuolaId }: { dryRun: boolean; scuolaId?: string | null }
): Promise<BackfillReport> {
  const report: BackfillReport = {
    target: 'parents',
    dryRun,
    total: 0,
    created: 0,
    reused: 0,
    bound: 0,
    utentiCreated: 0,
    skippedNoEmail: 0,
    errors: [],
  };

  const { data, error } = await admin
    .from('parents')
    .select('id, emails, first_name, last_name')
    .is('auth_user_id', null);
  if (error) throw new Error(error.message);
  const parents = (data as ParentRow[]) ?? [];
  report.total = parents.length;

  const emailToId = await buildEmailIndex(admin);
  // utenti.scuola_id è NOT NULL: senza una scuola risolvibile il passo `utenti`
  // fallisce per-parent con messaggio parlante (il bind resta comunque fatto).
  const scuola = dryRun ? null : await resolveScuolaId(admin, scuolaId ?? null);

  for (const p of parents) {
    const email = firstEmail(p.emails);
    if (!email) {
      report.skippedNoEmail++;
      continue;
    }
    const key = email.toLowerCase();
    const willCreate = !emailToId.has(key);

    if (dryRun) {
      if (willCreate) report.created++;
      else report.reused++;
      report.bound++;
      continue;
    }

    try {
      let authId = emailToId.get(key);
      if (!authId) {
        const { data: cu, error: cErr } = await admin.auth.admin.createUser({
          email,
          email_confirm: true,
          password: randomPassword(),
        });
        if (cErr || !cu?.user) {
          // `createUser failed` non è una diagnosi: è la constatazione che il
          // chiamante già faceva da sé. Il report porta il corpo dell'errore, e
          // una riga di log lo dice anche a chi il report non lo legge — un
          // backfill si lancia una volta e il suo esito lo si ritrova dopo.
          const dettaglio = cErr ? dettaglioErroreAuth(cErr) : 'nessun utente restituito';
          logEvento('auth', 'error', {
            operazione: 'auth/backfill:backfillParentsAuth',
            esito: 'creazione-account-non-riuscita',
            stato: typeof (cErr as { status?: number } | null)?.status === 'number'
              ? (cErr as { status?: number }).status
              : undefined,
          }, cErr ?? new Error('createUser: nessun utente restituito'));
          report.errors.push({ id: p.id, email, error: dettaglio });
          continue;
        }
        authId = cu.user.id;
        emailToId.set(key, authId);
        report.created++;
      } else {
        report.reused++;
      }

      const { error: uErr } = await admin.from('parents').update({ auth_user_id: authId }).eq('id', p.id);
      if (uErr) {
        report.errors.push({ id: p.id, email, error: uErr.message });
        continue;
      }
      report.bound++;

      const utenti = await ensureUtentiRow(admin, {
        id: authId,
        email,
        nome: p.first_name ?? null,
        cognome: p.last_name ?? null,
        scuolaId: scuola,
      });
      if (utenti.error) {
        report.errors.push({ id: p.id, email, error: `utenti: ${utenti.error}` });
        continue;
      }
      if (utenti.created) report.utentiCreated++;
    } catch (e) {
      report.errors.push({ id: p.id, email, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return report;
}
