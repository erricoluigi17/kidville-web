import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mocks for the two Supabase clients resolveIdentity touches:
//  - createClient(): the SSR/session client (reads the auth cookie)
//  - createAdminClient(): service-role, used to map auth.uid() -> app id
const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  utentiMaybeSingle: vi.fn(),
  parentsMaybeSingle: vi.fn(),
}));

vi.mock('@/lib/supabase/server-client', () => ({
  createClient: vi.fn().mockResolvedValue({
    auth: { getUser: mocks.getUser },
  }),
  createAdminClient: vi.fn().mockResolvedValue({
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle:
            table === 'utenti' ? mocks.utentiMaybeSingle : mocks.parentsMaybeSingle,
        }),
      }),
    }),
  }),
}));

import { resolveIdentity } from '@/lib/auth/require-staff';

describe('resolveIdentity (session-authoritative shim)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    mocks.utentiMaybeSingle.mockResolvedValue({ data: null, error: null });
    mocks.parentsMaybeSingle.mockResolvedValue({ data: null, error: null });
  });
  afterEach(() => vi.unstubAllEnvs());

  it('prefers the session id for a staff user (utenti.id == auth.uid())', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: { id: 'staff-uid' } }, error: null });
    mocks.utentiMaybeSingle.mockResolvedValue({ data: { id: 'staff-uid' }, error: null });
    const res = await resolveIdentity(new Request('http://localhost'));
    expect(res).toEqual({ userId: 'staff-uid', source: 'session' });
  });

  it('ignores a spoofed x-user-id that differs from the session (anti-spoof)', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: { id: 'staff-uid' } }, error: null });
    mocks.utentiMaybeSingle.mockResolvedValue({ data: { id: 'staff-uid' }, error: null });
    const req = new Request('http://localhost', { headers: { 'x-user-id': 'attacker' } });
    const res = await resolveIdentity(req);
    expect(res.userId).toBe('staff-uid');
    expect(res.source).toBe('session');
  });

  it('maps a parent session via parents.auth_user_id -> parents.id', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: { id: 'auth-parent' } }, error: null });
    mocks.utentiMaybeSingle.mockResolvedValue({ data: null, error: null });
    mocks.parentsMaybeSingle.mockResolvedValue({ data: { id: 'parent-row' }, error: null });
    const res = await resolveIdentity(new Request('http://localhost'));
    expect(res).toEqual({ userId: 'parent-row', source: 'session' });
  });

  it('falls back to header/query identity when no session and flag not disabled', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });
    const res = await resolveIdentity(new Request('http://localhost?userId=hdr-123'));
    expect(res).toEqual({ userId: 'hdr-123', source: 'header' });
  });

  it('rejects header identity when ALLOW_HEADER_IDENTITY=false', async () => {
    vi.stubEnv('ALLOW_HEADER_IDENTITY', 'false');
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });
    const req = new Request('http://localhost', { headers: { 'x-user-id': 'hdr-123' } });
    const res = await resolveIdentity(req);
    expect(res).toEqual({ userId: null, source: null });
  });

  it('degrades to header path if the session lookup throws (cookies() unavailable)', async () => {
    mocks.getUser.mockRejectedValue(new Error('cookies() unavailable'));
    const req = new Request('http://localhost', { headers: { 'x-user-id': 'hdr-xyz' } });
    const res = await resolveIdentity(req);
    expect(res).toEqual({ userId: 'hdr-xyz', source: 'header' });
  });

  it('returns the raw session uid when neither staff nor parent matches (bridge column missing)', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: { id: 'unknown-uid' } }, error: null });
    mocks.utentiMaybeSingle.mockResolvedValue({ data: null, error: null });
    mocks.parentsMaybeSingle.mockResolvedValue({
      data: null,
      error: { message: 'column parents.auth_user_id does not exist' },
    });
    const res = await resolveIdentity(new Request('http://localhost'));
    expect(res).toEqual({ userId: 'unknown-uid', source: 'session' });
  });

  it('logga [auth][header-fallback] quando usa il path header (osservabilità S13)', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await resolveIdentity(new Request('http://localhost/api/grades?userId=hdr-1'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[auth][header-fallback]'));
    warn.mockRestore();
  });
});
