import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Lock testuale della shell del cockpit Direzione/Segreteria (Step 4).
 *
 * Il layout admin deve montare, oltre alla TopBar desktop e alla sidebar, le tre
 * superfici mobile del re-skin: `data-kv-shell` (gancio safe-area nativa),
 * `AdminTopBarMobile` (barra verde del brand) e `AdminBottomNav` (bottom-nav a
 * pillola). È un lock testuale — come `design-tokens-admin`/`logging-coverage` —
 * perché rimuovere per sbaglio una di queste righe non romperebbe la build ma
 * lascerebbe la navigazione mobile monca (o senza safe-area su WebView nativa).
 */

const LAYOUT = path.join(
  process.cwd(),
  'src',
  'app',
  '(dashboard)',
  'admin',
  'layout.tsx',
);

describe('admin layout — shell mobile montata (Step 4)', () => {
  const src = fs.readFileSync(LAYOUT, 'utf8');

  it('espone data-kv-shell sul wrapper (gancio safe-area nativa)', () => {
    const occorrenze = src.match(/data-kv-shell/g) ?? [];
    expect(occorrenze.length).toBe(1);
  });

  it('monta la topbar verde mobile e la bottom-nav a pillola', () => {
    expect(src).toContain('<AdminTopBarMobile');
    expect(src).toContain('<AdminBottomNav');
    expect(src).toContain('AdminTopBarMobile');
    expect(src).toContain('AdminBottomNav');
  });

  it('libera lo spazio della bottom-nav flottante sul contenuto (pb-28 lg:pb-0)', () => {
    expect(src).toContain('pb-28');
    expect(src).toContain('lg:pb-0');
  });
});
