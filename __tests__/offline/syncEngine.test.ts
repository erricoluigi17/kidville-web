import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { syncPendingLogs } from '@/lib/offline/syncEngine';

const mocks = vi.hoisted(() => ({
  mockUpsert: vi.fn(),
  mockAnyOf: vi.fn(),
  mockToArray: vi.fn(),
  mockBulkUpdate: vi.fn()
}));

// Mock Supabase
vi.mock('@supabase/ssr', () => ({
  createBrowserClient: vi.fn().mockReturnValue({
    from: vi.fn().mockReturnValue({
      upsert: mocks.mockUpsert,
    }),
  }),
}));

// Mock Dexie DB Locale
vi.mock('@/lib/offline/db', () => ({
  db: {
    presenze: {
      where: vi.fn().mockReturnValue({
        anyOf: mocks.mockAnyOf,
      }),
      bulkUpdate: mocks.mockBulkUpdate,
    },
  },
}));

describe('Offline Sync Engine', () => {
  const originalNavigator = global.navigator;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    // @ts-ignore
    global.navigator = originalNavigator;
  });

  it('aborts synchronization if navigator is offline', async () => {
    // Simuliamo offline
    // @ts-ignore
    global.navigator = { onLine: false };

    await syncPendingLogs();

    // Non deve nemmeno chiamare il DB locale
    expect(mocks.mockAnyOf).not.toHaveBeenCalled();
  });

  it('processes pending logs and syncs with supabase when online', async () => {
    // Simuliamo online
    // @ts-ignore
    global.navigator = { onLine: true };

    const fakePendingLog = {
      id: 'log-1',
      alunno_id: 'std-1',
      data: '2026-05-03',
      sync_status: 'pending'
    };

    mocks.mockAnyOf.mockReturnValue({ toArray: mocks.mockToArray });
    mocks.mockToArray.mockResolvedValueOnce([fakePendingLog]);
    mocks.mockUpsert.mockResolvedValueOnce({ error: null });

    await syncPendingLogs();

    // 1. Deve aver cercato i log pendenti
    expect(mocks.mockToArray).toHaveBeenCalled();

    // 2. Deve aver chiamato supabase con il log aggiornato (synced)
    expect(mocks.mockUpsert).toHaveBeenCalledWith(
      [expect.objectContaining({ id: 'log-1', sync_status: 'synced' })],
      { onConflict: 'id' }
    );

    // 3. Deve aver aggiornato il DB locale segnando il record come synced
    expect(mocks.mockBulkUpdate).toHaveBeenCalledWith([
      { key: 'log-1', changes: { sync_status: 'synced' } }
    ]);
  });
});
