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
 *
 * Dal 2026-07-31 il lock copre anche `SedeScopeBoundary` attorno al contenuto
 * (W3-D / R74): è il confine che rimonta le pagine al cambio di sede. Toglierlo
 * non rompe nulla — semplicemente il cockpit continua a mostrare i dati della
 * sede precedente, in silenzio, come faceva prima. È il difetto più difficile da
 * accorgersi che ci sia: la pagina si vede, i numeri ci sono, sono solo di
 * un'altra scuola.
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

  it('avvolge il contenuto in <SedeScopeBoundary> (ri-caricamento al cambio sede)', () => {
    expect(src).toContain('SedeScopeBoundary');
    // Dentro il <main>, non attorno alla shell: topbar, sidebar e bottom-nav
    // NON devono rimontarsi (il menu da cui hai scelto la sede resta aperto).
    const main = src.match(/<main[\s\S]*?<\/main>/);
    expect(main).not.toBeNull();
    expect(main?.[0]).toContain('<SedeScopeBoundary>');
    expect(main?.[0]).toContain('{children}');
  });
});
