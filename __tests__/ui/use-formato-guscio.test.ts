import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useFormatoGuscio, QUERY_TABLET, QUERY_SIDEBAR } from '@/lib/ui/use-formato-guscio';

/**
 * QUALE NAVIGAZIONE MONTARE — telefono, binario a icone o sidebar.
 *
 * I confini sono quelli di `globals.css` (`--breakpoint-tablet`, e i `@media` di
 * `[data-kv-guscio-tablet]`): 744 px l'iPad mini in verticale, 1024 l'iPad 13" in verticale.
 * Se il JS e il CSS divergessero, il contenuto lascerebbe lo spazio a un binario che non c'è
 * (o ci finirebbe sotto). Le misure di confine sono provate apposta da entrambi i lati.
 */

const originale = window.matchMedia;

function simulaLarghezza(px: number) {
  window.matchMedia = vi.fn((q: string) => ({
    matches: q === QUERY_TABLET ? px >= 744 : q === QUERY_SIDEBAR ? px >= 1024 : false,
    media: q,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

afterEach(() => {
  window.matchMedia = originale;
});

describe('useFormatoGuscio', () => {
  it.each([
    [390, 'telefono'],
    [743, 'telefono'],
    [744, 'binario'],
    [834, 'binario'],
    [1023, 'binario'],
    [1024, 'sidebar'],
    [1194, 'sidebar'],
  ] as const)('a %i px → %s', (px, atteso) => {
    simulaLarghezza(px);
    expect(renderHook(() => useFormatoGuscio()).result.current).toBe(atteso);
  });

  it('le query sono le stesse misure del CSS (46.5rem = 744 px, 64rem = 1024 px)', () => {
    expect(QUERY_TABLET).toBe('(min-width: 46.5rem)');
    expect(QUERY_SIDEBAR).toBe('(min-width: 64rem)');
  });

  it('senza matchMedia resta telefono (il server, un browser che non l’ha)', () => {
    // @ts-expect-error — simula l'assenza dell'API
    window.matchMedia = undefined;
    expect(renderHook(() => useFormatoGuscio()).result.current).toBe('telefono');
  });
});
