import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  mockInsert: vi.fn(),
  mockSelect: vi.fn(),
  mockSingle: vi.fn(),
}));

// Gate: l'endpoint è ora protetto da requireDocente (P0/S3).
vi.mock('@/lib/auth/require-staff', () => ({
  requireDocente: vi.fn().mockResolvedValue({ user: { id: 'educator-1', role: 'educator' } }),
}));

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: vi.fn().mockResolvedValue({
    from: vi.fn().mockReturnValue({ insert: mocks.mockInsert }),
  }),
}));

import { POST } from '@/app/api/grades/route';

describe('API Route: Grades (Inserimento Voti)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mockInsert.mockReturnValue({ select: mocks.mockSelect });
    mocks.mockSelect.mockReturnValue({ single: mocks.mockSingle });
  });

  it('forza pubblicato=false e usa l\'utente del gate come maestra', async () => {
    mocks.mockSingle.mockResolvedValueOnce({ data: { id: 'voto-1' }, error: null });

    const request = new Request('http://localhost', {
      method: 'POST',
      // GUID-shaped: il postBodySchema (M3) valida alunnoId con zUuid
      body: JSON.stringify({ alunnoId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', materia: 'Matematica', tipo: 'scritto', votoNumerico: 8 }),
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
    expect(mocks.mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        alunno_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
        voto_numerico: 8,
        maestra_id: 'educator-1', // identità dal gate, non spoofabile
        pubblicato: false, // tassativo dal PRD (buffer notifica)
      })
    );
  });

  it('rifiuta un payload incompleto (400)', async () => {
    const request = new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify({ alunnoId: '1' }),
    });
    const response = await POST(request);
    expect(response.status).toBe(400);
  });
});
