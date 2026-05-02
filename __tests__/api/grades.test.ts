import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from '@/app/api/grades/route';

const mocks = vi.hoisted(() => ({
  mockInsert: vi.fn(),
  mockSelect: vi.fn(),
  mockSingle: vi.fn()
}));

vi.mock('@/lib/supabase/server-client', () => ({
  createClient: vi.fn().mockResolvedValue({
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'teacher-1' } }, error: null }),
    },
    from: vi.fn().mockReturnValue({
      insert: mocks.mockInsert,
    }),
  }),
}));

describe('API Route: Grades (Inserimento Voti)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mockInsert.mockReturnValue({ select: mocks.mockSelect });
    mocks.mockSelect.mockReturnValue({ single: mocks.mockSingle });
  });

  it('enforces the 10-minute notification buffer (pubblicato = false)', async () => {
    mocks.mockSingle.mockResolvedValueOnce({ data: { id: 'voto-1' }, error: null });

    const request = new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify({ 
        alunnoId: 'std-1', 
        materia: 'Matematica', 
        tipo: 'scritto', 
        votoNumerico: 8 
      }),
    });
    
    const response = await POST(request);
    const data = await response.json();
    
    expect(response.status).toBe(200);
    expect(data.success).toBe(true);

    // Verifica la logica del buffer notifica
    expect(mocks.mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        alunno_id: 'std-1',
        voto_numerico: 8,
        pubblicato: false // Tassativo dal PRD
      })
    );
  });

  it('rejects incomplete grade payload', async () => {
    const request = new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify({ alunnoId: '1' }), // Manca materia e voto
    });
    
    const response = await POST(request);
    expect(response.status).toBe(400);
  });
});
