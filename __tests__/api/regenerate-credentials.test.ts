import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  sendEmail: vi.fn(),
  logScrittura: vi.fn(),
  adminRow: { data: null as unknown, error: null as unknown },
  updateError: null as { message: string } | null,
  updates: [] as Array<{ id: string; attrs: { password?: string; email_confirm?: boolean } }>,
}));

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }));
vi.mock('@/lib/email/send', () => ({
  sendEmail: h.sendEmail,
  credentialsEmailBody: () => 'body',
}));
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }));
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve(h.adminRow) }) }),
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
    h.sendEmail.mockResolvedValue(true);
    h.adminRow = { data: null, error: null };
    h.updateError = null;
    h.updates = [];
  });

  it('nega ai non-staff (403)', async () => {
    h.requireStaff.mockResolvedValue({ response: NextResponse.json({ error: 'x' }, { status: 403 }) });
    const res = await POST(req({ targetKind: 'parent', targetId: 'p1' }));
    expect(res.status).toBe(403);
  });

  it('400 se mancano targetKind/targetId', async () => {
    const res = await POST(req({ targetId: 'p1' }));
    expect(res.status).toBe(400);
  });

  it('genitore: setta una nuova password, conferma email e la invia', async () => {
    h.adminRow = { data: { auth_user_id: 'auth-p', emails: ['p@x.it'], first_name: 'Mario' }, error: null };
    const res = await POST(req({ targetKind: 'parent', targetId: 'p1' }));
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.email_inviata).toBe(true);
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

  it('email non inviata → esito propagato con warning (mai perdita silenziosa)', async () => {
    h.sendEmail.mockResolvedValue(false);
    h.adminRow = { data: { auth_user_id: 'auth-p', emails: ['p@x.it'], first_name: 'Mario' }, error: null };
    const res = await POST(req({ targetKind: 'parent', targetId: 'p1' }));
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.email_inviata).toBe(false);
    expect(data.warning).toMatch(/Email non inviata/);
  });

  it('genitore senza account auth → 409', async () => {
    h.adminRow = { data: { auth_user_id: null, emails: ['p@x.it'], first_name: 'Mario' }, error: null };
    const res = await POST(req({ targetKind: 'parent', targetId: 'p1' }));
    expect(res.status).toBe(409);
    expect(h.updates).toHaveLength(0);
  });

  it('target senza email → 400 (niente reset)', async () => {
    h.adminRow = { data: { auth_user_id: 'auth-p', emails: [], first_name: 'Mario' }, error: null };
    const res = await POST(req({ targetKind: 'parent', targetId: 'p1' }));
    expect(res.status).toBe(400);
    expect(h.updates).toHaveLength(0);
  });

  it('staff: usa utenti.id come auth id', async () => {
    h.adminRow = { data: { id: 'u-1', email: 'staff@x.it', nome: 'Anna' }, error: null };
    const res = await POST(req({ targetKind: 'staff', targetId: 'u-1' }));
    expect(res.status).toBe(200);
    expect(h.updates[0].id).toBe('u-1');
    expect(h.sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: 'staff@x.it' }));
  });
});
