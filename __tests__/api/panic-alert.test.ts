import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from '@/app/api/panic-alert/route';

const mocks = vi.hoisted(() => ({
  mockUpsert: vi.fn(),
  // Admin client (recipient resolution): queue-based per-table.
  adminQueues: {} as Record<string, { data: unknown; error: unknown }>,
  enqueueNotifiche: vi.fn(),
  enqueueNotifichePerAlunni: vi.fn(),
}));

vi.mock('@/lib/supabase/server-client', () => ({
  createClient: vi.fn().mockResolvedValue({
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'teacher-1' } }, error: null }) },
    from: vi.fn().mockReturnValue({ upsert: mocks.mockUpsert }),
  }),
  createAdminClient: vi.fn().mockResolvedValue({
    from(table: string) {
      const qb: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'in', 'order', 'limit']) qb[m] = () => qb;
      const result = mocks.adminQueues[table] ?? { data: null, error: null };
      qb.maybeSingle = () => Promise.resolve(result);
      qb.single = () => Promise.resolve(result);
      qb.then = (res: (v: unknown) => unknown) => Promise.resolve(result).then(res);
      return qb;
    },
  }),
}));

vi.mock('@/lib/push/enqueue', () => ({ enqueueNotifiche: mocks.enqueueNotifiche }));
vi.mock('@/lib/primaria/notifiche', () => ({ enqueueNotifichePerAlunni: mocks.enqueueNotifichePerAlunni }));

describe('API Route: Panic Alert', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.adminQueues = {};
  });

  it('returns 400 if alunnoId is missing', async () => {
    const request = new Request('http://localhost', { method: 'POST', body: JSON.stringify({}) });
    const response = await POST(request);
    const data = await response.json();
    expect(response.status).toBe(400);
    // Shape standard M3: { error: 'Dati non validi', details: [{ path, message }] }
    expect(data.error).toBe('Dati non validi');
  });

  it('upserts a panic alert to the database', async () => {
    mocks.mockUpsert.mockResolvedValueOnce({ error: null });
    const request = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ alunnoId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1' }) });
    const response = await POST(request);
    const data = await response.json();
    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
    expect(mocks.mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ alunno_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', panic_alert: true }),
      expect.any(Object)
    );
  });

  it('returns 500 if database fails', async () => {
    mocks.mockUpsert.mockResolvedValueOnce({ error: { message: 'DB Error' } });
    const request = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ alunnoId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1' }) });
    const response = await POST(request);
    const data = await response.json();
    expect(response.status).toBe(500);
    expect(data.error).toContain('Errore nel salvataggio');
  });

  it('notifica simultaneamente Segreteria/Direzione e i genitori (push P1)', async () => {
    mocks.mockUpsert.mockResolvedValueOnce({ error: null });
    mocks.adminQueues = {
      alunni: { data: { scuola_id: 'sc-1' }, error: null },
      utenti: { data: [{ id: 'seg-1', role: 'segreteria' }, { id: 'adm-1', ruolo: 'admin' }], error: null },
    };
    const request = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ alunnoId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1' }) });
    const response = await POST(request);
    expect(response.status).toBe(200);

    // Segreteria/Direzione del plesso.
    expect(mocks.enqueueNotifiche).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        utenteIds: expect.arrayContaining(['seg-1', 'adm-1']),
        tipo: 'panic_alert',
        bufferMin: 0,
      }),
    );
    // Genitori dell'alunno.
    expect(mocks.enqueueNotifichePerAlunni).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ alunnoIds: ['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1'], tipo: 'panic_alert', bufferMin: 0 }),
    );
  });

  it('non fallisce il salvataggio se la notifica va in errore (best-effort)', async () => {
    mocks.mockUpsert.mockResolvedValueOnce({ error: null });
    mocks.enqueueNotifiche.mockRejectedValueOnce(new Error('push down'));
    mocks.adminQueues = {
      alunni: { data: { scuola_id: 'sc-1' }, error: null },
      utenti: { data: [{ id: 'seg-1', role: 'segreteria' }], error: null },
    };
    const request = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ alunnoId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1' }) });
    const response = await POST(request);
    expect(response.status).toBe(200);
  });
});
