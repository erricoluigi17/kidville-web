import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSchermoStretto, QUERY_SCHERMO_STRETTO } from '@/lib/ui/use-schermo-stretto';

/**
 * `useSchermoStretto` — sotto i 1024 px il dettaglio di un elenco diventa un foglio.
 *
 * La domanda è posta al contrario («è stretto?» e non «è largo?») di proposito: dove
 * `matchMedia` non risponde — il server, e il setup dei test che la simula sempre `false` — la
 * risposta deve essere la colonna a destra, cioè il comportamento che c'era già.
 */

type Ascoltatore = (e: { matches: boolean }) => void;

function mediaFinta(iniziale: boolean) {
  let matches = iniziale;
  const ascoltatori = new Set<Ascoltatore>();
  const mql = {
    get matches() {
      return matches;
    },
    media: QUERY_SCHERMO_STRETTO,
    addEventListener: (_: string, fn: Ascoltatore) => ascoltatori.add(fn),
    removeEventListener: (_: string, fn: Ascoltatore) => ascoltatori.delete(fn),
  };
  const matchMedia = vi.fn((q: string) => {
    if (q !== QUERY_SCHERMO_STRETTO) throw new Error(`query inattesa: ${q}`);
    return mql;
  });
  return {
    matchMedia,
    ascoltatori,
    cambia(nuovo: boolean) {
      matches = nuovo;
      ascoltatori.forEach((fn) => fn({ matches: nuovo }));
    },
  };
}

const originale = window.matchMedia;
afterEach(() => {
  window.matchMedia = originale;
});

describe('useSchermoStretto', () => {
  it('chiede proprio «sotto i 1024 px»', () => {
    expect(QUERY_SCHERMO_STRETTO).toBe('(max-width: 1023.98px)');
  });

  it('telefono: vero', () => {
    window.matchMedia = mediaFinta(true).matchMedia as unknown as typeof window.matchMedia;
    const { result } = renderHook(() => useSchermoStretto());
    expect(result.current).toBe(true);
  });

  it('computer: falso', () => {
    window.matchMedia = mediaFinta(false).matchMedia as unknown as typeof window.matchMedia;
    const { result } = renderHook(() => useSchermoStretto());
    expect(result.current).toBe(false);
  });

  it('segue la finestra quando cambia larghezza, e smette di ascoltare allo smontaggio', () => {
    const finta = mediaFinta(false);
    window.matchMedia = finta.matchMedia as unknown as typeof window.matchMedia;
    const { result, unmount } = renderHook(() => useSchermoStretto());
    expect(result.current).toBe(false);

    act(() => finta.cambia(true));
    expect(result.current).toBe(true);

    unmount();
    expect(finta.ascoltatori.size).toBe(0);
  });

  it('senza `matchMedia` (browser vecchi, ambienti senza finestra) vale falso: la colonna', () => {
    // @ts-expect-error — si toglie apposta
    window.matchMedia = undefined;
    const { result } = renderHook(() => useSchermoStretto());
    expect(result.current).toBe(false);
  });
});
