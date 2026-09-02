import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * LOCK · il chip della veste regge il contrasto — nei DUE temi.
 *
 * ─── PERCHÉ QUESTO FILE ESISTE ──────────────────────────────────────────────
 * Il chip sta dentro la fascia verde della AppBar, e su quel verde questo repo
 * si è già bruciato due volte: `#FDC400` (il giallo di brand) su `#006A5F` vale
 * **4,05:1**, sotto la soglia AA di 4,5:1 per il testo normale — è la misura
 * scritta in `globals.css` intorno alle righe 24-37, ed è il difetto degli skip
 * link (T19) e della pillola del selettore figlio (T20).
 *
 * ─── E LA METÀ CHE SI DIMENTICA SEMPRE È L'ALTO CONTRASTO ───────────────────
 * In `[data-contrast="high"]` il token `--color-kidville-green` diventa
 * **bianco**: un chip pensato «bianco su verde» diventerebbe bianco su bianco.
 * Non succede, perché `.kv-appbar` in quel tema è dipinta di NERO da una regola
 * dedicata — ma è una difesa che vive in un altro punto del foglio di stile, e
 * se qualcuno la togliesse il chip sparirebbe senza che nulla diventi rosso.
 * Qui le due cose sono misurate insieme: il colore del fondo si LEGGE dal CSS,
 * non si scrive a mano.
 *
 * ─── COSA MISURA DAVVERO ────────────────────────────────────────────────────
 * `bg-white/15` è bianco al 15% sopra il fondo della barra: il colore che l'occhio
 * riceve è la MISCELA, non `#FFFFFF`. Il calcolo la fa (composizione alpha in
 * spazio sRGB, che è ciò che fa il browser per un colore non premoltiplicato).
 */

const RADICE = process.cwd();
const CSS = fs.readFileSync(path.join(RADICE, 'src/app/globals.css'), 'utf8');

// ── WCAG 2.x §1.4.3 ──────────────────────────────────────────────────────────
const canale = (c: number) => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
};
const rgb = (hex: string): [number, number, number] => {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
};
const luminanza = (hex: string) => {
  const [r, g, b] = rgb(hex);
  return 0.2126 * canale(r) + 0.7152 * canale(g) + 0.0722 * canale(b);
};
const contrasto = (a: string, b: string) => {
  const [x, y] = [luminanza(a), luminanza(b)];
  const [alto, basso] = x > y ? [x, y] : [y, x];
  return Math.round(((alto + 0.05) / (basso + 0.05)) * 100) / 100;
};

/** Composizione di `sopra` con opacità `alpha` su `sotto` (sRGB, come il browser). */
function componi(sopra: string, alpha: number, sotto: string): string {
  const [rs, gs, bs] = rgb(sopra);
  const [rf, gf, bf] = rgb(sotto);
  const mix = (a: number, b: number) => Math.round(a * alpha + b * (1 - alpha));
  return (
    '#' +
    [mix(rs, rf), mix(gs, gf), mix(bs, bf)]
      .map((v) => v.toString(16).padStart(2, '0').toUpperCase())
      .join('')
  );
}

/** Il valore di un token dichiarato nel blocco `@theme inline`. */
function tokenTema(nome: string): string {
  const blocco = CSS.slice(CSS.indexOf('@theme inline'));
  const m = blocco.match(new RegExp(`--color-kidville-${nome}\\s*:\\s*(#[0-9A-Fa-f]{6})`));
  if (!m) throw new Error(`token --color-kidville-${nome} non dichiarato in @theme inline`);
  return m[1].toUpperCase();
}

/** Il fondo che `.kv-appbar` prende in Alto Contrasto, letto dalla sua regola. */
function fondoAppbarAltoContrasto(): string {
  const i = CSS.indexOf('[data-contrast="high"] .kv-appbar');
  expect(i, 'la regola che annerisce la AppBar in Alto Contrasto non esiste più').toBeGreaterThan(-1);
  const blocco = CSS.slice(i, CSS.indexOf('}', i));
  const m = blocco.match(/background:\s*(#[0-9A-Fa-f]{6})/);
  if (!m) throw new Error('`[data-contrast="high"] .kv-appbar` non dichiara più un `background` esadecimale');
  return m[1].toUpperCase();
}

/** L'opacità del velo del chip, letta dalla classe scritta nel componente. */
const APPBAR = fs.readFileSync(
  path.join(RADICE, 'src/components/features/shell/AppBar.tsx'),
  'utf8',
);

const SOGLIA_AA = 4.5;
const BIANCO = '#FFFFFF';

describe('chip della veste — bianco su velo bianco, e regge in tutti e due i temi', () => {
  it('il componente usa davvero `bg-white/15` + `text-white` (la misura vale per QUESTE classi)', () => {
    // Se un giorno il chip cambiasse riempimento, le due misure qui sotto
    // parlerebbero di un elemento che non esiste più — e resterebbero verdi.
    expect(APPBAR).toContain('bg-white/15');
    expect(APPBAR).toContain('text-white');
    expect(
      APPBAR.slice(APPBAR.indexOf('function ChipVeste'), APPBAR.indexOf('export function AppBar')),
      'Il giallo di brand su verde vale 4,05:1: sotto AA. Non entra nel chip.',
    ).not.toMatch(/kidville-yellow/);
  });

  it('TEMA NORMALE: bianco sul velo posato sul verde di brand ≥ 4,5:1', () => {
    const verde = tokenTema('green');
    const fondoChip = componi(BIANCO, 0.15, verde);
    const rapporto = contrasto(BIANCO, fondoChip);

    // Il CONTROLLO NEGATIVO accanto al positivo: il giallo di brand, sullo stesso
    // fondo, NON passa. È la prova che la sonda sa distinguere i due casi — senza,
    // un calcolo rotto che restituisse sempre un numero grande resterebbe verde.
    const giallo = tokenTema('yellow');
    expect(
      contrasto(giallo, verde),
      'Se questa misura passasse la soglia, il calcolo sarebbe rotto: 4,05:1 è un ' +
        'numero noto e scritto in globals.css.',
    ).toBeLessThan(SOGLIA_AA);

    expect(rapporto, `bianco su ${fondoChip} (velo 15% su ${verde})`).toBeGreaterThanOrEqual(SOGLIA_AA);
  });

  it('ALTO CONTRASTO: la AppBar diventa nera e il chip guadagna, non perde', () => {
    const fondoBarra = fondoAppbarAltoContrasto();
    const fondoChip = componi(BIANCO, 0.15, fondoBarra);
    const rapporto = contrasto(BIANCO, fondoChip);

    expect(rapporto, `bianco su ${fondoChip} (velo 15% su ${fondoBarra})`).toBeGreaterThanOrEqual(7);

    // ⚠️ LA PARTE CHE SI DIMENTICA: senza la regola che annerisce `.kv-appbar`,
    // in Alto Contrasto il fondo sarebbe il token `green` RIMAPPATO — cioè
    // bianco — e il chip bianco su bianco sparirebbe. Qui si misura proprio
    // quello scenario, per dimostrare che la difesa serve davvero.
    const verdeInHC = CSS.slice(CSS.indexOf('[data-contrast="high"] {'))
      .match(/--color-kidville-green:\s*(#[0-9A-Fa-f]{6})/)?.[1]
      .toUpperCase();
    expect(verdeInHC, 'in Alto Contrasto `--color-kidville-green` non è più rimappato').toBe('#FFFFFF');
    expect(
      contrasto(BIANCO, componi(BIANCO, 0.15, verdeInHC!)),
      'Senza la regola nera su `.kv-appbar` il chip sarebbe illeggibile: è la prova ' +
        'che quella regola è parte di QUESTO componente, non un dettaglio altrui.',
    ).toBeLessThan(1.2);
  });
});
