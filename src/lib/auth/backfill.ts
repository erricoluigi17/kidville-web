import { randomBytes } from 'crypto';

/**
 * Backfill identità auth per i GENITORI (P0/S6).
 *
 * Lo STAFF è già auth-backed (`utenti.id` FK → `auth.users`): non serve backfill;
 * l'eventuale staff senza password si ripara on-demand via "Rigenera credenziali"
 * (S11). Qui creiamo un `auth.users` per ogni `parents` con email e senza
 * `auth_user_id`, deduplicando per email, e scriviamo `parents.auth_user_id`.
 *
 * Idempotente: i parents già bindati sono esclusi dalla query; le email già
 * presenti in `auth.users` vengono riusate (no doppioni).
 */

export interface BackfillReport {
  target: 'parents';
  dryRun: boolean;
  total: number;
  created: number;
  reused: number;
  bound: number;
  skippedNoEmail: number;
  errors: Array<{ id: string; email?: string; error: string }>;
}

// Interfaccia minima del client admin (service-role) che usiamo.
interface AdminLike {
  from: (table: string) => {
    select: (cols: string) => { is: (col: string, val: null) => Promise<{ data: unknown; error: { message: string } | null }> };
    update: (vals: { auth_user_id: string }) => { eq: (col: string, id: string) => Promise<{ error: { message: string } | null }> };
  };
  auth: {
    admin: {
      listUsers: (opts?: { page?: number; perPage?: number }) => Promise<{ data: { users: Array<{ id: string; email?: string | null }> } | null; error: { message: string } | null }>;
      createUser: (attrs: { email: string; email_confirm?: boolean; password?: string }) => Promise<{ data: { user: { id: string } | null }; error: { message: string } | null }>;
    };
  };
}

interface ParentRow {
  id: string;
  emails: string[] | null;
}

/** Password iniziale forte e non indovinabile (le credenziali reali si emettono via S11). */
export function randomPassword(): string {
  return randomBytes(18).toString('base64url') + 'Aa1!';
}

function firstEmail(emails: string[] | null): string | null {
  if (!emails || emails.length === 0) return null;
  const e = emails.find((x) => x && x.includes('@'));
  return e ? e.trim() : null;
}

const PER_PAGE = 100;

async function buildEmailIndex(admin: AdminLike): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  let page = 1;
  for (;;) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: PER_PAGE });
    if (error) throw new Error(error.message);
    const users = data?.users ?? [];
    for (const u of users) if (u.email) map.set(u.email.toLowerCase(), u.id);
    if (users.length < PER_PAGE) break;
    page++;
  }
  return map;
}

export async function backfillParentsAuth(
  admin: AdminLike,
  { dryRun }: { dryRun: boolean }
): Promise<BackfillReport> {
  const report: BackfillReport = {
    target: 'parents',
    dryRun,
    total: 0,
    created: 0,
    reused: 0,
    bound: 0,
    skippedNoEmail: 0,
    errors: [],
  };

  const { data, error } = await admin
    .from('parents')
    .select('id, emails')
    .is('auth_user_id', null);
  if (error) throw new Error(error.message);
  const parents = (data as ParentRow[]) ?? [];
  report.total = parents.length;

  const emailToId = await buildEmailIndex(admin);

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
          report.errors.push({ id: p.id, email, error: cErr?.message ?? 'createUser failed' });
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
    } catch (e) {
      report.errors.push({ id: p.id, email, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return report;
}
