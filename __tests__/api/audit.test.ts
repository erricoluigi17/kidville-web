import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse, NextRequest } from 'next/server';
import type { DBFinto } from '../fixtures/finto-supabase';
import { SEDE_A } from '../fixtures/sedi';

// =============================================================================
// GET /api/admin/audit (S12) — gate di ruolo e filtri di ricerca.
//
// L'isolamento fra sedi di questa route è provato in
// `admin-varie-scope-sede.test.ts`; qui restano i tre contratti originali: chi
// non è staff riceve 403, lo staff riceve l'elenco, e `attoreId` filtra.
//
// Il mock a mano è stato sostituito col finto client (2026-07-31): quello vecchio
// non conosceva `.in()` e restituiva SEMPRE le stesse righe qualunque filtro
// venisse applicato — così un `expect(h.eq).not.toHaveBeenCalled() // nessun
// filtro` certificava per anni l'assenza del filtro di sede come se fosse la
// forma giusta. Il finto client filtra davvero: se il filtro sparisce, si vede.
// =============================================================================

const ATTORE = 'aaaa1111-1111-4111-8111-111111111111';
const ALTRO_ATTORE = 'bbbb2222-2222-4222-8222-222222222222';

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  tabelle: [] as string[],
}));

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }));
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase');
  return { createAdminClient: async () => creaFintoSupabase(h.db, h.tabelle) };
});

import { GET } from '@/app/api/admin/audit/route';

const req = (qs = '') => new NextRequest(`http://localhost/api/admin/audit${qs}`);

const dbBase = (): DBFinto => ({
  utenti_scuole: [],
  audit_scritture_docente: [
    {
      id: 'a1',
      attore_id: ATTORE,
      attore_ruolo: 'segreteria',
      scuola_id: SEDE_A,
      section_id: null,
      entita_tipo: 'credenziali',
      entita_id: null,
      azione: 'update',
      creato_il: '2026-07-30T10:00:00.000Z',
    },
    {
      id: 'a2',
      attore_id: ALTRO_ATTORE,
      attore_ruolo: 'educator',
      scuola_id: SEDE_A,
      section_id: null,
      entita_tipo: 'presenze',
      entita_id: null,
      azione: 'insert',
      creato_il: '2026-07-30T11:00:00.000Z',
    },
  ],
});

describe('GET /api/admin/audit (S12)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.db = dbBase();
    h.tabelle = [];
    h.requireStaff.mockResolvedValue({ user: { id: 'admin-1', role: 'segreteria', scuola_id: SEDE_A } });
  });

  it('nega ai non-staff (403), senza leggere il registro', async () => {
    h.requireStaff.mockResolvedValue({ response: NextResponse.json({ error: 'x' }, { status: 403 }) });
    const res = await GET(req());
    expect(res.status).toBe(403);
    expect(h.tabelle).not.toContain('audit_scritture_docente');
  });

  it('ritorna l\'elenco audit per lo staff, dal più recente', async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.data.map((r: { id: string }) => r.id)).toEqual(['a2', 'a1']);
  });

  it('filtra per attoreId quando passato', async () => {
    const res = await GET(req(`?attoreId=${ATTORE}`));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.data.map((r: { id: string }) => r.id)).toEqual(['a1']);
  });

  it('filtra per entitaTipo quando passato', async () => {
    const res = await GET(req('?entitaTipo=presenze'));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.data.map((r: { id: string }) => r.id)).toEqual(['a2']);
  });
});
