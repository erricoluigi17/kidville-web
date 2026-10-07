import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { createElement } from 'react';

const logClient = vi.fn();
vi.mock('@/lib/logging/client', () => ({
  logClient: (e: unknown) => logClient(e),
  nomeErrore: (e: unknown) => ((e as { name?: string }).name ?? 'Errore'),
}));

const CHIAVE = 'kv:contabilita-cifre-nascoste:u1';

function depositoRotto() {
  return {
    getItem: () => {
      throw new DOMException('negato', 'SecurityError');
    },
    setItem: () => {
      throw new DOMException('pieno', 'QuotaExceededError');
    },
  };
}

beforeEach(() => {
  logClient.mockClear();
});
afterEach(() => localStorage.clear());

describe('cifre-nascoste — deposito che non funziona', () => {
  it('lettura falsa, scrittura in memoria e UN solo log anche dopo più accessi', async () => {
    vi.resetModules();
    const { leggiCifreNascoste, scriviCifreNascoste } = await import(
      '@/components/features/admin/pagamenti/cifre-nascoste'
    );
    const dep = depositoRotto();
    expect(leggiCifreNascoste('u1', dep)).toBe(false);
    expect(leggiCifreNascoste('u1', dep)).toBe(false);
    scriviCifreNascoste('u1', true, dep);
    expect(leggiCifreNascoste('u1', dep)).toBe(true);
    scriviCifreNascoste('u1', false, dep);
    expect(leggiCifreNascoste('u1', dep)).toBe(false);
    expect(logClient).toHaveBeenCalledTimes(1);
    const evento = logClient.mock.calls[0][0] as { livello: string; messaggio: string; campi: Record<string, string>; route?: string };
    expect(evento.livello).toBe('warn');
    expect(evento.messaggio).toBe('cifre-nascoste-storage-non-disponibile');
    expect(evento.campi).toEqual({ operazione: 'lettura', error_code: 'SecurityError' });
    expect(evento.route).toBeUndefined();
    expect(evento.messaggio).not.toContain('u1');
  });

  it('quota piena: la scrittura vince sul deposito che riporta il valore vecchio', async () => {
    vi.resetModules();
    const { leggiCifreNascoste, scriviCifreNascoste } = await import(
      '@/components/features/admin/pagamenti/cifre-nascoste'
    );
    const dep = {
      getItem: () => '0',
      setItem: () => {
        throw new DOMException('', 'QuotaExceededError');
      },
    };
    scriviCifreNascoste('u1', true, dep);
    expect(leggiCifreNascoste('u1', dep)).toBe(true);
    expect(logClient).toHaveBeenCalledTimes(1);
    expect((logClient.mock.calls[0][0] as { campi: Record<string, string> }).campi.operazione).toBe('scrittura');
  });

  it('window.localStorage null: si segnala una volta (accesso) e non si rompe', async () => {
    vi.resetModules();
    const { leggiCifreNascoste } = await import('@/components/features/admin/pagamenti/cifre-nascoste');
    const spia = vi.spyOn(window, 'localStorage', 'get').mockReturnValue(null as unknown as Storage);
    try {
      expect(leggiCifreNascoste('u1')).toBe(false);
      expect(leggiCifreNascoste('u1')).toBe(false);
    } finally {
      spia.mockRestore();
    }
    expect(logClient).toHaveBeenCalledTimes(1);
    expect((logClient.mock.calls[0][0] as { campi: Record<string, string> }).campi).toEqual({ operazione: 'accesso' });
  });

  it('senza userId: sempre false e la scrittura non fa niente', async () => {
    vi.resetModules();
    const { leggiCifreNascoste, scriviCifreNascoste } = await import(
      '@/components/features/admin/pagamenti/cifre-nascoste'
    );
    scriviCifreNascoste('', true);
    expect(leggiCifreNascoste('')).toBe(false);
    expect(localStorage.length).toBe(0);
    expect(logClient).not.toHaveBeenCalled();
  });
});

describe('useCifreNascoste', () => {
  it('parte visibile, set(true) nasconde e persiste; un secondo hook si aggiorna', async () => {
    const { useCifreNascoste } = await import('@/components/features/admin/pagamenti/cifre-nascoste');
    const a = renderHook(() => useCifreNascoste('u1'));
    const b = renderHook(() => useCifreNascoste('u1'));
    expect(a.result.current[0]).toBe(false);
    act(() => a.result.current[1](true));
    expect(a.result.current[0]).toBe(true);
    expect(b.result.current[0]).toBe(true);
    expect(localStorage.getItem(CHIAVE)).toBe('1');
    act(() => b.result.current[1](false));
    expect(a.result.current[0]).toBe(false);
  });

  it('utenti diversi sono indipendenti', async () => {
    const { useCifreNascoste } = await import('@/components/features/admin/pagamenti/cifre-nascoste');
    const u1 = renderHook(() => useCifreNascoste('u1'));
    const u2 = renderHook(() => useCifreNascoste('u2'));
    act(() => u1.result.current[1](true));
    expect(u1.result.current[0]).toBe(true);
    expect(u2.result.current[0]).toBe(false);
  });

  it('una modifica da un’altra scheda (evento storage) si vede', async () => {
    const { useCifreNascoste } = await import('@/components/features/admin/pagamenti/cifre-nascoste');
    const a = renderHook(() => useCifreNascoste('u1'));
    expect(a.result.current[0]).toBe(false);
    act(() => {
      localStorage.setItem(CHIAVE, '1');
      window.dispatchEvent(new StorageEvent('storage', { key: CHIAVE, newValue: '1' }));
    });
    expect(a.result.current[0]).toBe(true);
  });

  it('idratazione: con «1» già salvato il rendering sul server dice «visibili»', async () => {
    const { useCifreNascoste } = await import('@/components/features/admin/pagamenti/cifre-nascoste');
    localStorage.setItem(CHIAVE, '1');
    function Prova() {
      const [n] = useCifreNascoste('u1');
      return createElement('span', null, n ? 'nascoste' : 'visibili');
    }
    expect(renderToString(createElement(Prova))).toContain('visibili');
  });
});
