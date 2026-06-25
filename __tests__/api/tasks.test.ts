import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockInsert: vi.fn(),
}));

// Gate docente (P0): l'intero modulo tasks è riservato allo staff.
vi.mock('@/lib/auth/require-staff', () => ({
  requireDocente: vi
    .fn()
    .mockResolvedValue({ user: { id: 'teacher-456', role: 'educator', scuola_id: 'sc-1' } }),
}));

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: vi.fn().mockResolvedValue({ from: mocks.mockFrom }),
}));

// Audit best-effort: stub per non sporcare la chain del mock.
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: vi.fn().mockResolvedValue(undefined) }));

import { GET, POST } from '@/app/api/tasks/route';

describe('API Route: Tasks Staff (gated)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 400 if neither userId nor studentId is provided on GET', async () => {
    const request = new Request('http://localhost/api/tasks', { method: 'GET' });
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toBe('userId o studentId è richiesto');
  });

  it('creates a new task on POST (201)', async () => {
    mocks.mockFrom.mockReturnValue({ insert: mocks.mockInsert });
    mocks.mockInsert.mockReturnValue({
      select: vi.fn().mockReturnValue({
        single: vi.fn().mockResolvedValue({
          data: { id: 'task-123', titolo: 'Task Test', contenuto: '{}' },
          error: null,
        }),
      }),
    });

    const request = new Request('http://localhost/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        titolo: 'Task Test',
        contenuto: 'Descrizione test',
        author_id: 'teacher-456',
        priority: 'high',
        category: 'generale',
        target_scope: 'global',
      }),
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(201);
    expect(data.id).toBe('task-123');
    expect(data.titolo).toBe('Task Test');
  });

  it('returns 400 on POST if required fields are missing', async () => {
    const request = new Request('http://localhost/api/tasks', {
      method: 'POST',
      body: JSON.stringify({ titolo: 'Test' }), // manca author_id
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toContain('author_id');
  });
});
