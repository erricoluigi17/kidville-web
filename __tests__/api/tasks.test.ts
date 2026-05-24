import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET, POST } from '@/app/api/tasks/route';

const mocks = vi.hoisted(() => ({
    mockFrom: vi.fn(),
    mockSelect: vi.fn(),
    mockInsert: vi.fn(),
    mockOrder: vi.fn(),
    mockEq: vi.fn(),
    mockSingle: vi.fn(),
}));

vi.mock('@/lib/supabase/server-client', () => ({
    createAdminClient: vi.fn().mockResolvedValue({
        from: mocks.mockFrom,
    }),
}));

describe('API Route: Tasks Staff', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns 400 if userId is missing on GET', async () => {
        const request = new Request('http://localhost/api/tasks', { method: 'GET' });
        const response = await GET(request);
        const data = await response.json();

        expect(response.status).toBe(400);
        expect(data.error).toBe('userId è richiesto');
    });

    it('creates a new task on POST', async () => {
        const mockInsertResult = {
            id: 'task-123',
            titolo: 'Task Test',
            contenuto: 'Descrizione test',
            status: 'todo'
        };

        mocks.mockFrom.mockReturnValue({
            insert: mocks.mockInsert,
        });
        mocks.mockInsert.mockReturnValue({
            select: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({ data: mockInsertResult, error: null }),
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
                target_scope: 'global'
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
            body: JSON.stringify({
                titolo: 'Test' // Missing contenuto and author_id
            }),
        });

        const response = await POST(request);
        const data = await response.json();

        expect(response.status).toBe(400);
        expect(data.error).toContain('titolo, contenuto e author_id sono richiesti');
    });
});
