import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock del db Dexie: isoliamo la logica di fetchConCache dallo store IndexedDB
// reale (fake-indexeddb non è installato). Espone solo cache_read.{get,put},
// gli unici metodi che l'helper usa.
const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  put: vi.fn(),
}));

vi.mock('@/lib/offline/db', () => ({
  db: {
    cache_read: {
      get: mocks.get,
      put: mocks.put,
    },
  },
}));

import { fetchConCache } from '@/lib/offline/read-cache';

/** Costruisce una Response finta minimale (solo ok/status/json). */
function fakeResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

describe('fetchConCache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.put.mockResolvedValue(undefined);
    mocks.get.mockResolvedValue(undefined);
  });

  it('rete ok: ritorna i dati freschi (offline:false) e li scrive in cache', async () => {
    const payload = [{ id: 'a1' }];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeResponse(payload)));

    const res = await fetchConCache<typeof payload>('avvisi:u1', '/api/avvisi');

    expect(res).toEqual({ data: payload, offline: false });
    expect(mocks.put).toHaveBeenCalledWith(
      expect.objectContaining({ chiave: 'avvisi:u1', payload }),
    );
    // aggiornato_il presente e in forma ISO
    const arg = mocks.put.mock.calls[0][0];
    expect(typeof arg.aggiornato_il).toBe('string');
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it('rete giù + cache presente: serve la copia in cache (offline:true)', async () => {
    const cached = [{ id: 'vecchio' }];
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    mocks.get.mockResolvedValue({
      chiave: 'avvisi:u1',
      payload: cached,
      aggiornato_il: '2026-01-01T00:00:00.000Z',
    });

    const res = await fetchConCache('avvisi:u1', '/api/avvisi');

    expect(res).toEqual({ data: cached, offline: true });
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it("rete giù + cache assente: rilancia l'errore originale", async () => {
    const err = new TypeError('Failed to fetch');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(err));
    mocks.get.mockResolvedValue(undefined);

    await expect(fetchConCache('avvisi:u1', '/api/avvisi')).rejects.toBe(err);
  });

  it('risposta !ok + cache presente: serve la cache (offline:true), niente scrittura', async () => {
    const cached = [{ id: 'vecchio' }];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeResponse({ error: 'boom' }, false, 500)));
    mocks.get.mockResolvedValue({ chiave: 'k', payload: cached, aggiornato_il: 'x' });

    const res = await fetchConCache('k', '/api/x');

    expect(res).toEqual({ data: cached, offline: true });
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it('risposta !ok + cache assente: lancia un errore', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeResponse({ error: 'boom' }, false, 500)));
    mocks.get.mockResolvedValue(undefined);

    await expect(fetchConCache('k', '/api/x')).rejects.toBeInstanceOf(Error);
  });

  it('scrittura cache fallita: ignorata (best-effort), ritorna comunque i dati freschi', async () => {
    const payload = { ok: 1 };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeResponse(payload)));
    mocks.put.mockRejectedValue(new Error('quota exceeded'));

    const res = await fetchConCache('k', '/api/x');

    expect(res).toEqual({ data: payload, offline: false });
  });

  it('non-browser (SSR): fetch normale, offline:false, nessun accesso alla cache', async () => {
    const payload = { x: 1 };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeResponse(payload)));

    const originalWindow = globalThis.window;
    // Simula un ambiente senza window (SSR / server).
    // @ts-expect-error rimozione temporanea di window per il ramo non-browser
    delete globalThis.window;
    try {
      const res = await fetchConCache('k', '/api/x');
      expect(res).toEqual({ data: payload, offline: false });
      expect(mocks.get).not.toHaveBeenCalled();
      expect(mocks.put).not.toHaveBeenCalled();
    } finally {
      globalThis.window = originalWindow;
    }
  });
});
