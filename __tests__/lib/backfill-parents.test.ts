import { describe, it, expect } from 'vitest';
import { backfillParentsAuth } from '@/lib/auth/backfill';

// Mock minimale del client admin (service-role) usato dal backfill.
function makeAdmin(opts: {
  parents: Array<{ id: string; emails: string[] | null }>;
  existingUsers?: Array<{ id: string; email: string }>;
  createFails?: Set<string>;
}) {
  const created: Array<{ id: string; email: string }> = [];
  const bound: Array<{ id: string; auth_user_id: string }> = [];
  return {
    created,
    bound,
    from: (_table: string) => ({
      select: () => ({
        is: () => Promise.resolve({ data: opts.parents, error: null }),
      }),
      update: (vals: { auth_user_id: string }) => ({
        eq: (_col: string, id: string) => {
          bound.push({ id, auth_user_id: vals.auth_user_id });
          return Promise.resolve({ error: null });
        },
      }),
    }),
    auth: {
      admin: {
        listUsers: async () => ({ data: { users: opts.existingUsers ?? [] }, error: null }),
        createUser: async ({ email }: { email: string }) => {
          if (opts.createFails?.has(email)) {
            return { data: { user: null }, error: { message: 'already registered' } };
          }
          const u = { id: `auth-${email}`, email };
          created.push(u);
          return { data: { user: u }, error: null };
        },
      },
    },
  };
}

describe('backfillParentsAuth', () => {
  it('crea un auth.users per email distinta e fa il bind', async () => {
    const admin = makeAdmin({
      parents: [
        { id: 'p1', emails: ['a@x.it'] },
        { id: 'p2', emails: ['b@x.it'] },
      ],
    });
    const r = await backfillParentsAuth(admin as never, { dryRun: false });
    expect(r.total).toBe(2);
    expect(r.created).toBe(2);
    expect(r.bound).toBe(2);
    expect(admin.created.map((u) => u.email).sort()).toEqual(['a@x.it', 'b@x.it']);
    expect(admin.bound).toContainEqual({ id: 'p1', auth_user_id: 'auth-a@x.it' });
  });

  it('email condivisa → un solo auth.users, entrambi i parents bindati', async () => {
    const admin = makeAdmin({
      parents: [
        { id: 'p1', emails: ['same@x.it'] },
        { id: 'p2', emails: ['same@x.it'] },
      ],
    });
    const r = await backfillParentsAuth(admin as never, { dryRun: false });
    expect(r.created).toBe(1);
    expect(r.reused).toBe(1);
    expect(r.bound).toBe(2);
    expect(admin.created).toHaveLength(1);
  });

  it('riusa un auth.users esistente (no create) e fa il bind', async () => {
    const admin = makeAdmin({
      parents: [{ id: 'p1', emails: ['e@x.it'] }],
      existingUsers: [{ id: 'auth-existing', email: 'e@x.it' }],
    });
    const r = await backfillParentsAuth(admin as never, { dryRun: false });
    expect(r.created).toBe(0);
    expect(r.reused).toBe(1);
    expect(r.bound).toBe(1);
    expect(admin.created).toHaveLength(0);
    expect(admin.bound).toContainEqual({ id: 'p1', auth_user_id: 'auth-existing' });
  });

  it('parents senza email → skippati e riportati', async () => {
    const admin = makeAdmin({
      parents: [
        { id: 'p1', emails: null },
        { id: 'p2', emails: [] },
      ],
    });
    const r = await backfillParentsAuth(admin as never, { dryRun: false });
    expect(r.skippedNoEmail).toBe(2);
    expect(r.bound).toBe(0);
    expect(admin.created).toHaveLength(0);
  });

  it('dryRun: nessuna create/bind reale, ma il piano è riportato', async () => {
    const admin = makeAdmin({ parents: [{ id: 'p1', emails: ['a@x.it'] }] });
    const r = await backfillParentsAuth(admin as never, { dryRun: true });
    expect(r.dryRun).toBe(true);
    expect(r.created).toBe(1);
    expect(r.bound).toBe(1);
    expect(admin.created).toHaveLength(0); // niente effetti reali
    expect(admin.bound).toHaveLength(0);
  });

  it('errore createUser → registrato in errors, gli altri proseguono', async () => {
    const admin = makeAdmin({
      parents: [
        { id: 'p1', emails: ['boom@x.it'] },
        { id: 'p2', emails: ['ok@x.it'] },
      ],
      createFails: new Set(['boom@x.it']),
    });
    const r = await backfillParentsAuth(admin as never, { dryRun: false });
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].id).toBe('p1');
    expect(r.created).toBe(1); // p2 ok
    expect(r.bound).toBe(1);
  });
});
