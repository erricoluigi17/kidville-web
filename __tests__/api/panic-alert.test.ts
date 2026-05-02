import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from '@/app/api/panic-alert/route';

const mocks = vi.hoisted(() => ({
  mockUpsert: vi.fn(),
}));

vi.mock('@/lib/supabase/server-client', () => ({
  createClient: vi.fn().mockResolvedValue({
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'teacher-1' } }, error: null }),
    },
    from: vi.fn().mockReturnValue({
      upsert: mocks.mockUpsert,
    }),
  }),
}));

describe('API Route: Panic Alert', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 400 if alunnoId is missing', async () => {
    const request = new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    
    const response = await POST(request);
    const data = await response.json();
    
    expect(response.status).toBe(400);
    expect(data.error).toBe('alunnoId è obbligatorio');
  });

  it('upserts a panic alert to the database', async () => {
    mocks.mockUpsert.mockResolvedValueOnce({ error: null });

    const request = new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify({ alunnoId: '123' }),
    });
    
    const response = await POST(request);
    const data = await response.json();
    
    expect(response.status).toBe(200);
    expect(data.success).toBe(true);

    // Verifichiamo che l'upsert sia stato chiamato col flag corretto
    expect(mocks.mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        alunno_id: '123',
        panic_alert: true,
      }),
      expect.any(Object)
    );
  });

  it('returns 500 if database fails', async () => {
    mocks.mockUpsert.mockResolvedValueOnce({ error: { message: 'DB Error' } });

    const request = new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify({ alunnoId: '123' }),
    });
    
    const response = await POST(request);
    const data = await response.json();
    
    expect(response.status).toBe(500);
    expect(data.error).toContain('Errore nel salvataggio');
  });
});
