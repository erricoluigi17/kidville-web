import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { backfillParentsAuth } from '@/lib/auth/backfill';

// Mock minimale del client admin (service-role) usato dal backfill.
// S6bis: oltre ad auth.users + ponte, il backfill garantisce la riga `utenti`
// ruolo 'genitore' (senza, il login riesce ma ogni route dati risponde 401).
function makeAdmin(opts: {
  parents: Array<{ id: string; emails: string[] | null; first_name?: string | null; last_name?: string | null }>;
  existingUsers?: Array<{ id: string; email: string }>;
  existingUtenti?: string[];
  createFails?: Set<string>;
}) {
  const created: Array<{ id: string; email: string }> = [];
  const bound: Array<{ id: string; auth_user_id: string }> = [];
  const utentiInserts: Array<Record<string, unknown>> = [];
  const utentiSeen = new Set(opts.existingUtenti ?? []);
  const admin = {
    from: (table: string) => {
      if (table === 'utenti') {
        return {
          select: () => ({
            eq: (_c: string, id: string) => ({
              maybeSingle: async () => ({ data: utentiSeen.has(id) ? { id } : null, error: null }),
            }),
          }),
          insert: async (row: Record<string, unknown>) => {
            utentiSeen.add(row.id as string);
            utentiInserts.push(row);
            return { error: null };
          },
        };
      }
      // parents
      return {
        select: () => ({
          is: () => Promise.resolve({ data: opts.parents, error: null }),
        }),
        update: (vals: { auth_user_id: string }) => ({
          eq: (_col: string, id: string) => {
            bound.push({ id, auth_user_id: vals.auth_user_id });
            return Promise.resolve({ error: null });
          },
        }),
      };
    },
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
  } as unknown as SupabaseClient;
  return { admin, created, bound, utentiInserts };
}

describe('backfillParentsAuth', () => {
  it('crea un auth.users per email distinta, fa il bind e crea la riga utenti', async () => {
    const { admin, created, bound, utentiInserts } = makeAdmin({
      parents: [
        { id: 'p1', emails: ['a@x.it'], first_name: 'Anna', last_name: 'Ax' },
        { id: 'p2', emails: ['b@x.it'] },
      ],
    });
    const r = await backfillParentsAuth(admin, { dryRun: false, scuolaId: 'sc-1' });
    expect(r.total).toBe(2);
    expect(r.created).toBe(2);
    expect(r.bound).toBe(2);
    expect(r.utentiCreated).toBe(2);
    expect(created.map((u) => u.email).sort()).toEqual(['a@x.it', 'b@x.it']);
    expect(bound).toContainEqual({ id: 'p1', auth_user_id: 'auth-a@x.it' });
    expect(utentiInserts[0]).toMatchObject({
      id: 'auth-a@x.it',
      email: 'a@x.it',
      nome: 'Anna',
      cognome: 'Ax',
      ruolo: 'genitore',
      scuola_id: 'sc-1',
      attivo: true,
    });
    // p2 senza nomi → fallback dal local-part email (utenti.nome è NOT NULL)
    expect(utentiInserts[1]).toMatchObject({ nome: 'b', cognome: '' });
  });

  it('email condivisa → un solo auth.users e una sola riga utenti, entrambi i parents bindati', async () => {
    const { admin, created, utentiInserts } = makeAdmin({
      parents: [
        { id: 'p1', emails: ['same@x.it'] },
        { id: 'p2', emails: ['same@x.it'] },
      ],
    });
    const r = await backfillParentsAuth(admin, { dryRun: false, scuolaId: 'sc-1' });
    expect(r.created).toBe(1);
    expect(r.reused).toBe(1);
    expect(r.bound).toBe(2);
    expect(r.utentiCreated).toBe(1);
    expect(created).toHaveLength(1);
    expect(utentiInserts).toHaveLength(1);
  });

  it('riusa un auth.users esistente (no create) e completa la riga utenti mancante', async () => {
    const { admin, created, bound } = makeAdmin({
      parents: [{ id: 'p1', emails: ['e@x.it'] }],
      existingUsers: [{ id: 'auth-existing', email: 'e@x.it' }],
    });
    const r = await backfillParentsAuth(admin, { dryRun: false, scuolaId: 'sc-1' });
    expect(r.created).toBe(0);
    expect(r.reused).toBe(1);
    expect(r.bound).toBe(1);
    expect(r.utentiCreated).toBe(1);
    expect(created).toHaveLength(0);
    expect(bound).toContainEqual({ id: 'p1', auth_user_id: 'auth-existing' });
  });

  it('riga utenti già esistente (es. staff con stessa email) → NON toccata', async () => {
    const { admin, utentiInserts } = makeAdmin({
      parents: [{ id: 'p1', emails: ['doc@x.it'] }],
      existingUsers: [{ id: 'auth-doc', email: 'doc@x.it' }],
      existingUtenti: ['auth-doc'],
    });
    const r = await backfillParentsAuth(admin, { dryRun: false, scuolaId: 'sc-1' });
    expect(r.bound).toBe(1);
    expect(r.utentiCreated).toBe(0);
    expect(utentiInserts).toHaveLength(0);
  });

  it('parents senza email → skippati e riportati', async () => {
    const { admin, created } = makeAdmin({
      parents: [
        { id: 'p1', emails: null },
        { id: 'p2', emails: [] },
      ],
    });
    const r = await backfillParentsAuth(admin, { dryRun: false, scuolaId: 'sc-1' });
    expect(r.skippedNoEmail).toBe(2);
    expect(r.bound).toBe(0);
    expect(created).toHaveLength(0);
  });

  it('dryRun: nessuna create/bind reale, ma il piano è riportato', async () => {
    const { admin, created, bound, utentiInserts } = makeAdmin({ parents: [{ id: 'p1', emails: ['a@x.it'] }] });
    const r = await backfillParentsAuth(admin, { dryRun: true });
    expect(r.dryRun).toBe(true);
    expect(r.created).toBe(1);
    expect(r.bound).toBe(1);
    expect(r.utentiCreated).toBe(0);
    expect(created).toHaveLength(0); // niente effetti reali
    expect(bound).toHaveLength(0);
    expect(utentiInserts).toHaveLength(0);
  });

  it('errore createUser → registrato in errors, gli altri proseguono', async () => {
    const { admin } = makeAdmin({
      parents: [
        { id: 'p1', emails: ['boom@x.it'] },
        { id: 'p2', emails: ['ok@x.it'] },
      ],
      createFails: new Set(['boom@x.it']),
    });
    const r = await backfillParentsAuth(admin, { dryRun: false, scuolaId: 'sc-1' });
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].id).toBe('p1');
    expect(r.created).toBe(1); // p2 ok
    expect(r.bound).toBe(1);
    expect(r.utentiCreated).toBe(1);
  });
});
