import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ensureParentIdentity, firstEmail } from '@/lib/auth/parent-identity';

// S6bis: l'identità di accesso di un genitore è auth.users + utenti(ruolo
// genitore) + ponte parents.auth_user_id. ensureParentIdentity deve completare
// SOLO i pezzi mancanti, in modo idempotente, senza mai lanciare.

interface FakeState {
  authUsers?: Array<{ id: string; email: string }>;
  parentRow?: { auth_user_id: string | null } | null;
  bridgeUpdatedRows?: number;
  bridgeError?: { code?: string; message: string } | null;
  utentiExisting?: string[];
  utentiInsertError?: { message: string } | null;
  schools?: Array<{ id: string }>;
  createUserError?: { message: string } | null;
}

function makeAdmin(state: FakeState) {
  const calls = {
    utentiInserts: [] as Array<Record<string, unknown>>,
    bridgeUpdates: [] as unknown[],
    createUsers: [] as Array<Record<string, unknown>>,
    listUsersCalls: 0,
  };
  const utentiSeen = new Set(state.utentiExisting ?? []);
  const admin = {
    from(table: string) {
      if (table === 'parents') {
        return {
          update: (vals: unknown) => ({
            eq: () => ({
              is: () => ({
                select: async () => {
                  calls.bridgeUpdates.push(vals);
                  if (state.bridgeError) return { data: null, error: state.bridgeError };
                  const n = state.bridgeUpdatedRows ?? 1;
                  return { data: Array.from({ length: n }, () => ({ id: 'p1' })), error: null };
                },
              }),
            }),
          }),
          select: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: state.parentRow ?? null, error: null }) }),
          }),
        };
      }
      if (table === 'utenti') {
        return {
          select: () => ({
            eq: (_c: string, id: string) => ({
              maybeSingle: async () => ({ data: utentiSeen.has(id) ? { id } : null, error: null }),
            }),
          }),
          insert: async (row: Record<string, unknown>) => {
            if (state.utentiInsertError) return { error: state.utentiInsertError };
            utentiSeen.add(row.id as string);
            calls.utentiInserts.push(row);
            return { error: null };
          },
        };
      }
      if (table === 'schools') {
        return { select: () => ({ limit: async () => ({ data: state.schools ?? [], error: null }) }) };
      }
      throw new Error(`tabella inattesa: ${table}`);
    },
    auth: {
      admin: {
        listUsers: async () => {
          calls.listUsersCalls++;
          return { data: { users: state.authUsers ?? [] }, error: null };
        },
        createUser: async (attrs: Record<string, unknown>) => {
          calls.createUsers.push(attrs);
          if (state.createUserError) return { data: { user: null }, error: state.createUserError };
          return { data: { user: { id: `auth-${attrs.email as string}` } }, error: null };
        },
      },
    },
  } as unknown as SupabaseClient;
  return { admin, calls };
}

const PARENT = { id: 'p1', auth_user_id: null, emails: ['mario@x.it'], first_name: 'Mario', last_name: 'Rossi' };

describe('ensureParentIdentity (S6bis)', () => {
  it('senza nulla: crea auth + ponte + riga utenti ruolo genitore', async () => {
    const { admin, calls } = makeAdmin({});
    const r = await ensureParentIdentity(admin, PARENT, { scuolaId: 'sc-1' });
    expect(r).toMatchObject({ ok: true, createdAuth: true, boundNow: true, createdUtenti: true });
    if (!r.ok) throw new Error('atteso ok');
    expect(r.authUserId).toBe('auth-mario@x.it');
    expect(typeof r.password).toBe('string');
    expect(r.password!.length).toBeGreaterThan(8);
    expect(calls.createUsers[0]).toMatchObject({ email: 'mario@x.it', email_confirm: true });
    expect(calls.utentiInserts[0]).toMatchObject({
      id: 'auth-mario@x.it',
      email: 'mario@x.it',
      nome: 'Mario',
      cognome: 'Rossi',
      ruolo: 'genitore',
      scuola_id: 'sc-1',
      attivo: true,
    });
    // mai colonne generate
    expect(calls.utentiInserts[0]).not.toHaveProperty('role');
    expect(calls.utentiInserts[0]).not.toHaveProperty('first_name');
  });

  it('auth esistente per email: riusa senza creare (password null)', async () => {
    const { admin, calls } = makeAdmin({ authUsers: [{ id: 'auth-x', email: 'MARIO@x.it' }] });
    const r = await ensureParentIdentity(admin, PARENT, { scuolaId: 'sc-1' });
    expect(r).toMatchObject({ ok: true, createdAuth: false, boundNow: true, password: null });
    if (!r.ok) throw new Error('atteso ok');
    expect(r.authUserId).toBe('auth-x');
    expect(calls.createUsers).toHaveLength(0);
  });

  it('identità già completa: nessuna scrittura (idempotente)', async () => {
    const { admin, calls } = makeAdmin({ utentiExisting: ['auth-x'] });
    const r = await ensureParentIdentity(admin, { ...PARENT, auth_user_id: 'auth-x' }, { scuolaId: 'sc-1' });
    expect(r).toMatchObject({ ok: true, createdAuth: false, createdUtenti: false, boundNow: false });
    expect(calls.listUsersCalls).toBe(0);
    expect(calls.bridgeUpdates).toHaveLength(0);
    expect(calls.utentiInserts).toHaveLength(0);
  });

  it('riga utenti esistente (es. docente-genitore): non toccata, ruolo preservato', async () => {
    const { admin, calls } = makeAdmin({
      authUsers: [{ id: 'auth-doc', email: 'doc@x.it' }],
      utentiExisting: ['auth-doc'],
    });
    const r = await ensureParentIdentity(admin, { ...PARENT, emails: ['doc@x.it'] }, { scuolaId: 'sc-1' });
    expect(r).toMatchObject({ ok: true, createdUtenti: false });
    expect(calls.utentiInserts).toHaveLength(0);
  });

  it('senza email → no_email (nessuna chiamata auth)', async () => {
    const { admin, calls } = makeAdmin({});
    const r = await ensureParentIdentity(admin, { ...PARENT, emails: [] }, { scuolaId: 'sc-1' });
    expect(r).toMatchObject({ ok: false, reason: 'no_email' });
    expect(calls.listUsersCalls).toBe(0);
  });

  it('email già collegata a un ALTRA anagrafica (23505) → email_conflict', async () => {
    const { admin } = makeAdmin({
      authUsers: [{ id: 'auth-x', email: 'mario@x.it' }],
      bridgeError: { code: '23505', message: 'duplicate key parents_auth_user_id_key' },
    });
    const r = await ensureParentIdentity(admin, PARENT, { scuolaId: 'sc-1' });
    expect(r).toMatchObject({ ok: false, reason: 'email_conflict' });
  });

  it('ponte già scritto da altri con lo stesso account → ok (boundNow false)', async () => {
    const { admin } = makeAdmin({
      authUsers: [{ id: 'auth-x', email: 'mario@x.it' }],
      bridgeUpdatedRows: 0,
      parentRow: { auth_user_id: 'auth-x' },
    });
    const r = await ensureParentIdentity(admin, PARENT, { scuolaId: 'sc-1' });
    expect(r).toMatchObject({ ok: true, boundNow: false });
  });

  it('ponte già scritto verso un ALTRO account → error', async () => {
    const { admin } = makeAdmin({
      authUsers: [{ id: 'auth-x', email: 'mario@x.it' }],
      bridgeUpdatedRows: 0,
      parentRow: { auth_user_id: 'auth-altro' },
    });
    const r = await ensureParentIdentity(admin, PARENT, { scuolaId: 'sc-1' });
    expect(r).toMatchObject({ ok: false, reason: 'error' });
  });

  it('scuolaId assente + più scuole → error parlante (utenti.scuola_id NOT NULL)', async () => {
    const { admin } = makeAdmin({ schools: [{ id: 's1' }, { id: 's2' }] });
    const r = await ensureParentIdentity(admin, PARENT, {});
    expect(r).toMatchObject({ ok: false, reason: 'error' });
    if (r.ok) throw new Error('atteso errore');
    expect(r.message).toMatch(/scuola/i);
  });

  it('scuolaId assente + UNICA scuola → fallback mono-sede', async () => {
    const { admin, calls } = makeAdmin({ schools: [{ id: 'sc-only' }] });
    const r = await ensureParentIdentity(admin, PARENT, {});
    expect(r).toMatchObject({ ok: true });
    expect(calls.utentiInserts[0]).toMatchObject({ scuola_id: 'sc-only' });
  });

  it('nome/cognome mancanti → fallback dal local-part email (NOT NULL a DB)', async () => {
    const { admin, calls } = makeAdmin({});
    const r = await ensureParentIdentity(
      admin,
      { id: 'p1', auth_user_id: null, emails: ['mario.rossi@x.it'], first_name: null, last_name: null },
      { scuolaId: 'sc-1' }
    );
    expect(r).toMatchObject({ ok: true });
    expect(calls.utentiInserts[0]).toMatchObject({ nome: 'mario.rossi', cognome: '' });
  });

  it('createUser fallito → error (nessun lancio)', async () => {
    const { admin } = makeAdmin({ createUserError: { message: 'boom' } });
    const r = await ensureParentIdentity(admin, PARENT, { scuolaId: 'sc-1' });
    expect(r).toMatchObject({ ok: false, reason: 'error' });
  });

  it('client monco (es. mock senza auth) → error, mai eccezione', async () => {
    const admin = { from: () => ({}) } as unknown as SupabaseClient;
    const r = await ensureParentIdentity(admin, PARENT, { scuolaId: 'sc-1' });
    expect(r).toMatchObject({ ok: false, reason: 'error' });
  });
});

describe('firstEmail', () => {
  it('array: prima email valida, trim', () => {
    expect(firstEmail(['', 'x', ' a@b.it '])).toBe('a@b.it');
  });
  it('stringa singola', () => {
    expect(firstEmail('a@b.it')).toBe('a@b.it');
  });
  it('niente email → null', () => {
    expect(firstEmail([])).toBeNull();
    expect(firstEmail(null)).toBeNull();
    expect(firstEmail('non-email')).toBeNull();
  });
});
