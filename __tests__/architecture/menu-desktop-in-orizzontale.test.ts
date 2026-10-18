// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { QUERY_SIDEBAR, QUERY_TABLET } from '@/lib/ui/use-formato-guscio';

/**
 * LOCK · su ogni iPad in orizzontale, OGNI ruolo ha il menu da computer.
 *
 * LA STORIA (18/10/2026). La PR 3 dell'iPad (#241) aveva dato alla segreteria il binario a icone
 * fino a 1279 px, mentre genitori e docenti passano alla sidebar piena da 1024. Un iPad 11" in
 * orizzontale è largo 1180–1210 px: il titolare, che lo usa soprattutto così, vedeva nella
 * segreteria «il menu del cellulare e non quello desktop». Le due soglie vivevano in posti
 * diversi (classi `xl:` da una parte, `QUERY_SIDEBAR` dall'altra) e nessun test le confrontava.
 *
 * COSA SORVEGLIA: la soglia della sidebar piena è la stessa per i tre ruoli, 1024 px (64rem), e
 * quella del binario è la stessa, 744 px (46.5rem).
 *  - genitori e docenti: `QUERY_SIDEBAR` / `QUERY_TABLET` di `use-formato-guscio.ts`;
 *  - segreteria: le classi `lg:` della sidebar e del binario, la variante `pannello` del menu e
 *    `--kv-rail-w` di `[data-kv-guscio-admin]` in `globals.css`.
 */

const RADICE = join(__dirname, '..', '..', 'src');
const leggi = (p: string) => readFileSync(join(RADICE, p), 'utf8');

/** La stringa di classi di un `className="…"` che contiene `segno`. */
function classiCon(testo: string, segno: string): string[] {
  const m = [...testo.matchAll(/className="([^"]*)"/g)].map((x) => x[1]).find((c) => c.includes(segno));
  expect(m, `nessun className con «${segno}»`).toBeDefined();
  return m!.split(/\s+/);
}

describe('menu da computer in orizzontale, per tutti i ruoli', () => {
  it('genitori e docenti: binario da 46.5rem, sidebar da 64rem', () => {
    expect(QUERY_TABLET).toBe('(min-width: 46.5rem)');
    expect(QUERY_SIDEBAR).toBe('(min-width: 64rem)');
  });

  it('segreteria: sidebar piena da `lg:` (64rem), binario solo fra `tablet:` e `lg:`', () => {
    const classiSidebar = classiCon(leggi('components/features/admin/AdminSidebar.tsx'), 'lg:w-64');
    expect(classiSidebar).toEqual(expect.arrayContaining(['hidden', 'lg:flex']));
    expect(classiSidebar.some((c) => c.startsWith('xl:'))).toBe(false);

    const binario = classiCon(leggi('components/features/admin/AdminBinario.tsx'), 'tablet:w-[88px]');
    expect(binario).toEqual(expect.arrayContaining(['hidden', 'tablet:flex', 'lg:hidden']));

    const menu = leggi('components/features/admin/AdminMenuSheet.tsx');
    const pannello = menu.match(/pannello:\s*'([^']*)'/)?.[1].split(/\s+/) ?? [];
    expect(pannello).toEqual(expect.arrayContaining(['hidden', 'tablet:block', 'lg:hidden']));
  });

  it('segreteria: `--kv-rail-w` vale 16rem dalla stessa soglia, 64rem', () => {
    const css = leggi('app/globals.css');
    const blocchi = [...css.matchAll(/@media \(min-width: ([\d.]+rem)\) \{\s*\[data-kv-guscio-admin\] \{\s*--kv-rail-w: ([^;]+);/g)].map(
      (m) => [m[1], m[2].trim()],
    );
    expect(blocchi).toEqual([
      ['46.5rem', '88px'],
      ['64rem', '16rem'],
    ]);
  });
});
