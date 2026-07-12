import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AppUser } from '@/lib/auth/require-staff';

// S6bis: alla CREAZIONE di un'anagrafica genitore con email, l'account nasce
// completo e le credenziali partono via email IN AUTOMATICO (nessun passaggio
// manuale). L'esito dell'invio è propagato al chiamante e in audit.

const h = vi.hoisted(() => ({
  ensure: vi.fn(),
  send: vi.fn(),
  logScrittura: vi.fn(),
}));

vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }));
vi.mock('@/lib/auth/parent-identity', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/parent-identity')>();
  return { ...actual, ensureParentIdentity: h.ensure };
});
vi.mock('@/lib/email/send', () => ({
  sendEmailDetailed: h.send,
  credentialsEmailBody: (_n: string | null, e: string, p: string) => `credenziali ${e} pwd:${p}`,
}));

import { linkOrCreateParent } from '@/lib/anagrafiche/parents';

const actor: AppUser = { id: 'seg-1', role: 'segreteria', scuola_id: 'sc-1' };

function makeSupabase() {
  return {
    from: (table: string) => ({
      insert: () => ({
        select: () => ({ single: async () => ({ data: { id: 'p-new' }, error: null }) }),
      }),
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
      upsert: async () => ({ error: null }),
      _table: table,
    }),
  } as unknown as SupabaseClient;
}

const payload = { first_name: 'Mario', last_name: 'Rossi', role: 'father', emails: ['mario@x.it'] };

const IDENTITA_CREATA = {
  ok: true as const,
  authUserId: 'auth-1',
  email: 'mario@x.it',
  createdAuth: true,
  createdUtenti: true,
  boundNow: true,
  password: 'tmp-pass-123',
};

describe('linkOrCreateParent — invio automatico credenziali (S6bis)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.ensure.mockResolvedValue(IDENTITA_CREATA);
    h.send.mockResolvedValue({ ok: true, error: null });
  });

  it('account creato → credenziali inviate automaticamente con la password temporanea', async () => {
    const r = await linkOrCreateParent(makeSupabase(), actor, { studentId: null, payload });
    expect(h.send).toHaveBeenCalledTimes(1);
    const arg = h.send.mock.calls[0][0] as { to: string; text: string };
    expect(arg.to).toBe('mario@x.it');
    expect(arg.text).toContain('tmp-pass-123');
    expect(r.credenzialiEmail).toEqual({ email: 'mario@x.it', inviata: true, errore: null });
    // audit con esito email
    const auditCred = h.logScrittura.mock.calls.map((c) => c[1]).find((a) => a.entitaTipo === 'credenziali');
    expect(auditCred?.valoreDopo).toMatchObject({ emailed: true, emailError: null });
  });

  it('invio rifiutato → esito negativo propagato con MOTIVO (mai silenzioso)', async () => {
    h.send.mockResolvedValue({ ok: false, error: 'rifiutato dal provider email (403): sandbox' });
    const r = await linkOrCreateParent(makeSupabase(), actor, { studentId: null, payload });
    expect(r.credenzialiEmail).toEqual({
      email: 'mario@x.it',
      inviata: false,
      errore: 'rifiutato dal provider email (403): sandbox',
    });
    const auditCred = h.logScrittura.mock.calls.map((c) => c[1]).find((a) => a.entitaTipo === 'credenziali');
    expect(auditCred?.valoreDopo).toMatchObject({ emailed: false, emailError: expect.stringContaining('403') });
  });

  it('account riusato (email già con accesso) → NESSUN invio', async () => {
    h.ensure.mockResolvedValue({ ...IDENTITA_CREATA, createdAuth: false, password: null, boundNow: true });
    const r = await linkOrCreateParent(makeSupabase(), actor, { studentId: null, payload });
    expect(h.send).not.toHaveBeenCalled();
    expect(r.credenzialiEmail).toBeUndefined();
  });

  it('anagrafica senza email → nessun invio e nessun errore', async () => {
    h.ensure.mockResolvedValue({ ok: false, reason: 'no_email', message: 'Genitore senza email in anagrafica' });
    const r = await linkOrCreateParent(makeSupabase(), actor, { studentId: null, payload: { ...payload, emails: [] } });
    expect(h.send).not.toHaveBeenCalled();
    expect(r.identitaErrore).toBeUndefined();
  });

  it('identità non completata → errore propagato al chiamante', async () => {
    h.ensure.mockResolvedValue({ ok: false, reason: 'error', message: 'boom identità' });
    const r = await linkOrCreateParent(makeSupabase(), actor, { studentId: null, payload });
    expect(r.identitaErrore).toBe('boom identità');
    expect(h.send).not.toHaveBeenCalled();
  });

  it('record-staff (tab Staff) → identità e invio NON tentati', async () => {
    const r = await linkOrCreateParent(makeSupabase(), actor, {
      studentId: null,
      payload: { ...payload, role: 'educator' },
    });
    expect(h.ensure).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
    expect(r.credenzialiEmail).toBeUndefined();
  });
});
