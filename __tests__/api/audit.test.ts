import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  eq: vi.fn(),
  result: { data: [] as unknown[], error: null as unknown },
}));

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }));
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: vi.fn().mockResolvedValue({
    from: () => {
      const qb: Record<string, unknown> = {};
      qb.select = () => qb;
      qb.order = () => qb;
      qb.limit = () => qb;
      qb.eq = (...args: unknown[]) => {
        h.eq(...args);
        return qb;
      };
      qb.then = (resolve: (v: unknown) => unknown) => resolve(h.result);
      return qb;
    },
  }),
}));

import { GET } from '@/app/api/admin/audit/route';

describe('GET /api/admin/audit (S12)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.requireStaff.mockResolvedValue({ user: { id: 'admin-1', role: 'segreteria' } });
    h.result = { data: [{ id: 'a1', entita_tipo: 'credenziali' }], error: null };
  });

  it('nega ai non-staff (403)', async () => {
    h.requireStaff.mockResolvedValue({ response: NextResponse.json({ error: 'x' }, { status: 403 }) });
    const res = await GET(new Request('http://localhost/api/admin/audit'));
    expect(res.status).toBe(403);
  });

  it('ritorna l\'elenco audit per lo staff', async () => {
    const res = await GET(new Request('http://localhost/api/admin/audit'));
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.data).toHaveLength(1);
    expect(h.eq).not.toHaveBeenCalled(); // nessun filtro
  });

  it('filtra per attoreId quando passato', async () => {
    const res = await GET(new Request('http://localhost/api/admin/audit?attoreId=u-9'));
    expect(res.status).toBe(200);
    expect(h.eq).toHaveBeenCalledWith('attore_id', 'u-9');
  });
});
