import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  sendEmail: vi.fn(),
  logScrittura: vi.fn(),
  ensureIdentity: vi.fn(),
  adminRow: { data: null as unknown, error: null as unknown },
  utentiRuolo: { data: null as unknown, error: null as unknown },
  updateError: null as { message: string } | null,
  updates: [] as Array<{ id: string; attrs: { password?: string; email_confirm?: boolean } }>,
}));

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }));
vi.mock('@/lib/email/send', () => ({
  // La route usa la variante "detailed" (esito con motivo); il wrapper boolean
  // resta per compat con altri moduli.
  sendEmailDetailed: h.sendEmail,
  sendEmail: async (p: unknown) => ((await h.sendEmail(p)) as { ok: boolean }).ok,
  credentialsEmailBody: () => 'body',
}));
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }));
// L'identità (auth+utenti+ponte) è delegata a ensureParentIdentity (S6bis):
// qui la mockiamo; la sua logica ha test dedicati in lib/parent-identity.test.ts.
vi.mock('@/lib/auth/parent-identity', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/parent-identity')>();
  return { ...actual, ensureParentIdentity: h.ensureIdentity };
});
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    // select('ruolo') su utenti = guard anti-lockout; il resto usa adminRow.
    from: (table: string) => ({
      select: (cols?: string) => ({
        eq: () => ({
          maybeSingle: () =>
            Promise.resolve(table === 'utenti' && cols === 'ruolo' ? h.utentiRuolo : h.adminRow),
        }),
      }),
    }),
    auth: {
      admin: {
        updateUserById: async (id: string, attrs: { password?: string; email_confirm?: boolean }) => {
          h.updates.push({ id, attrs });
          return { data: {}, error: h.updateError };
        },
      },
    },
  }),
}));

import { POST } from '@/app/api/admin/regenerate-credentials/route';

function req(body: unknown) {
  return new Request('http://localhost', { method: 'POST', body: JSON.stringify(body) });
}

describe('POST /api/admin/regenerate-credentials (DL-005)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // requireEnv (M2.3): la route risponde 503 senza queste env
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role';
    h.requireStaff.mockResolvedValue({ user: { id: 'admin-1', role: 'segreteria', scuola_id: 's1' } });
    h.sendEmail.mockResolvedValue({ ok: true, error: null });
    h.adminRow = { data: null, error: null };
    h.utentiRuolo = { data: { ruolo: 'genitore' }, error: null };
    h.updateError = null;
    h.updates = [];
    // Default: identità già presente → riusa auth_user_id; se assente la ripara.
    h.ensureIdentity.mockImplementation(async (_admin: unknown, row: { auth_user_id?: string | null }) => ({
      ok: true,
      authUserId: row.auth_user_id ?? 'auth-riparato',
      email: 'p@x.it',
      createdAuth: !row.auth_user_id,
      createdUtenti: !row.auth_user_id,
      boundNow: !row.auth_user_id,
      password: null,
    }));
  });

  it('nega ai non-staff (403)', async () => {
    h.requireStaff.mockResolvedValue({ response: NextResponse.json({ error: 'x' }, { status: 403 }) });
    const res = await POST(req({ targetKind: 'parent', targetId: 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1' }));
    expect(res.status).toBe(403);
  });

  it('400 se mancano targetKind/targetId', async () => {
    const res = await POST(req({ targetId: 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1' }));
    expect(res.status).toBe(400);
  });

  it('genitore: setta una nuova password, conferma email e la invia', async () => {
    h.adminRow = { data: { id: 'p1', auth_user_id: 'auth-p', emails: ['p@x.it'], first_name: 'Mario', last_name: 'Rossi' }, error: null };
    const res = await POST(req({ targetKind: 'parent', targetId: 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1' }));
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.email_inviata).toBe(true);
    expect(data.identita_creata).toBe(false);
    expect(data.warning).toBeUndefined();
    // fuori da production le credenziali sono restituite per la consegna manuale
    expect(data.devCredentials).toEqual({ email: 'p@x.it', password: expect.any(String) });
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0].id).toBe('auth-p');
    expect(typeof h.updates[0].attrs.password).toBe('string');
    expect(h.updates[0].attrs.password!.length).toBeGreaterThan(8);
    expect(h.updates[0].attrs.email_confirm).toBe(true);
    expect(h.sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: 'p@x.it' }));
    expect(h.logScrittura).toHaveBeenCalled();
  });

  it('email non inviata → warning col MOTIVO del provider (mai perdita silenziosa)', async () => {
    h.sendEmail.mockResolvedValue({ ok: false, error: 'rifiutato dal provider email (403): You can only send testing emails to your own email address' });
    h.adminRow = { data: { id: 'p1', auth_user_id: 'auth-p', emails: ['p@x.it'], first_name: 'Mario', last_name: null }, error: null };
    const res = await POST(req({ targetKind: 'parent', targetId: 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1' }));
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.email_inviata).toBe(false);
    expect(data.warning).toMatch(/Email non inviata: rifiutato dal provider email \(403\)/);
    // il motivo finisce anche in audit
    const audit = h.logScrittura.mock.calls.at(-1)?.[1] as { valoreDopo?: { emailError?: string } };
    expect(audit?.valoreDopo?.emailError).toMatch(/403/);
  });

  it('genitore senza account auth → identità creata al volo (S6bis) e credenziali inviate', async () => {
    h.adminRow = { data: { id: 'p1', auth_user_id: null, emails: ['p@x.it'], first_name: 'Mario', last_name: 'Rossi' }, error: null };
    const res = await POST(req({ targetKind: 'parent', targetId: 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1' }));
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.identita_creata).toBe(true);
    expect(h.ensureIdentity).toHaveBeenCalled();
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0].id).toBe('auth-riparato');
    expect(h.sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: 'p@x.it' }));
  });

  it('genitore senza email → 400 con messaggio azionabile (niente reset)', async () => {
    h.adminRow = { data: { id: 'p1', auth_user_id: null, emails: [], first_name: 'Mario', last_name: null }, error: null };
    h.ensureIdentity.mockResolvedValue({ ok: false, reason: 'no_email', message: 'Genitore senza email in anagrafica' });
    const res = await POST(req({ targetKind: 'parent', targetId: 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1' }));
    const data = await res.json();
    expect(res.status).toBe(400);
    expect(data.error).toMatch(/email/i);
    expect(h.updates).toHaveLength(0);
  });

  it('email già di un altra anagrafica → 409 con messaggio parlante', async () => {
    h.adminRow = { data: { id: 'p1', auth_user_id: null, emails: ['p@x.it'], first_name: 'Mario', last_name: null }, error: null };
    h.ensureIdentity.mockResolvedValue({ ok: false, reason: 'email_conflict', message: 'email già collegata a un altra anagrafica' });
    const res = await POST(req({ targetKind: 'parent', targetId: 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1' }));
    expect(res.status).toBe(409);
    expect(h.updates).toHaveLength(0);
  });

  it('riparazione identità fallita → 500 (niente reset)', async () => {
    h.adminRow = { data: { id: 'p1', auth_user_id: null, emails: ['p@x.it'], first_name: 'Mario', last_name: null }, error: null };
    h.ensureIdentity.mockResolvedValue({ ok: false, reason: 'error', message: 'boom' });
    const res = await POST(req({ targetKind: 'parent', targetId: 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1' }));
    expect(res.status).toBe(500);
    expect(h.updates).toHaveLength(0);
  });

  it("guard anti-lockout: l'email dell'anagrafica appartiene a un account STAFF → 409, nessun reset", async () => {
    // Caso reale: anagrafica di prova con l'email del titolare (sandbox Resend)
    // o docente-genitore — il reset cambierebbe la password del login staff.
    h.adminRow = { data: { id: 'p1', auth_user_id: 'auth-admin', emails: ['admin@x.it'], first_name: 'Luigi', last_name: null }, error: null };
    h.utentiRuolo = { data: { ruolo: 'admin' }, error: null };
    const res = await POST(req({ targetKind: 'parent', targetId: 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1' }));
    const data = await res.json();
    expect(res.status).toBe(409);
    expect(data.error).toMatch(/account staff \(admin\)/);
    expect(h.updates).toHaveLength(0);
    expect(h.sendEmail).not.toHaveBeenCalled();
  });

  it('staff: usa utenti.id come auth id (nessuna riparazione identità)', async () => {
    h.adminRow = { data: { id: 'e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1', email: 'staff@x.it', nome: 'Anna' }, error: null };
    const res = await POST(req({ targetKind: 'staff', targetId: 'e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1' }));
    expect(res.status).toBe(200);
    expect(h.updates[0].id).toBe('e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1');
    expect(h.sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: 'staff@x.it' }));
    expect(h.ensureIdentity).not.toHaveBeenCalled();
  });
});
