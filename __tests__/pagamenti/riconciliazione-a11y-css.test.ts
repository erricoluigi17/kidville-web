import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Lock a11y della Riconciliazione lato CSS (globals.css). Le regole di colore/focus
 * non sono testabili in DOM (jsdom non calcola il contrasto), ma la LORO PRESENZA sì:
 * qui si blocca la regressione dei findings A2 (testo «suggerito» invisibile in Alto
 * Contrasto) e A3 (anello di focus invisibile sui controlli a fondo pieno).
 */
const css = fs.readFileSync(path.join(process.cwd(), 'src', 'app', 'globals.css'), 'utf8')

describe('globals.css — a11y Riconciliazione', () => {
  it('A2: in Alto Contrasto la riga «suggerito» schiarisce ESPLICITAMENTE il testo dei discendenti', () => {
    // Il box diventa nero: il testo `text-kidville-ink` (inlinato scuro da @theme inline)
    // va forzato a un colore chiaro, altrimenti sparisce sul fondo nero.
    expect(css).toMatch(
      /\[data-contrast="high"\][^{]*\.kv-recon-row--suggerito\s+\.text-kidville-ink\s*\{[^}]*color:\s*#(?:FFFFFF|FFF)\b/i,
    )
  })

  /**
   * ─── IL CHIP DI FATTURAZIONE IN ALTO CONTRASTO ──────────────────────────────
   *
   * `@theme inline` INLINA l'hex dentro le utility Tailwind: ridefinire
   * `--color-kidville-*` sotto `[data-contrast="high"]` NON cambia una sola
   * classe già generata. Una superficie nuova, in Alto Contrasto, o è dipinta a
   * mano o non esiste — e «non esiste» qui significa un chip bianco-su-verde
   * lasciato a sé stesso sopra una riga che il tema ha ridisegnato.
   *
   * Il chip prende il linguaggio HC del repo: carta bianca, inchiostro nero,
   * contorno nero 2px (il contorno è ciò che lo stacca dal fondo della riga, non
   * il colore). «Da fatturare» resta l'unico distinguibile a colpo d'occhio —
   * giallo brillante #FFE500, lo stesso di `.kv-recon-row--suggerito` — perché è
   * l'unico chip che chiede di agire: perderlo nella fila dei bianchi
   * annullerebbe la ragione per cui esiste.
   */
  it('il chip di fatturazione ha una regola HC dedicata: carta bianca, inchiostro nero, contorno nero', () => {
    const i = css.indexOf('[data-contrast="high"] .kv-recon-chip {');
    expect(i, 'manca la regola Alto Contrasto di `.kv-recon-chip`').toBeGreaterThan(-1);
    const blocco = css.slice(i, css.indexOf('}', i));
    expect(blocco).toMatch(/background:\s*#(?:FFFFFF|FFF)\b/i);
    expect(blocco).toMatch(/color:\s*#(?:000000|000)\b/i);
    // il contorno, non il colore, è ciò che stacca il chip dal fondo della riga
    expect(blocco).toMatch(/box-shadow:[^;]*2px\s+#(?:000000|000)\b/i);
  });

  it('«Da fatturare» resta giallo brillante in HC (è l’unico chip che chiede di agire)', () => {
    const i = css.indexOf('[data-contrast="high"] .kv-recon-chip--da-fatturare');
    expect(i, 'manca la variante HC di `.kv-recon-chip--da-fatturare`').toBeGreaterThan(-1);
    const blocco = css.slice(i, css.indexOf('}', i));
    expect(blocco).toMatch(/background:\s*#FFE500\b/i);
    // e viene DOPO la regola comune, altrimenti il bianco la coprirebbe
    expect(i).toBeGreaterThan(css.indexOf('[data-contrast="high"] .kv-recon-chip {'));
  });

  it('le regole del chip stanno FUORI da ogni @layer (dentro perderebbero contro le utility)', () => {
    // `@theme inline` genera le utility dentro `@layer utilities`: in CSS un
    // layer perde SEMPRE contro ciò che sta fuori dai layer, a prescindere dalla
    // specificità. È l'unico motivo per cui queste regole vincono senza `!important`.
    const nudo = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const profonditaPrimaDi = (ago: string) => {
      const j = nudo.indexOf(ago);
      expect(j, `selettore non trovato: ${ago}`).toBeGreaterThan(-1);
      let p = 0;
      for (const c of nudo.slice(0, j)) { if (c === '{') p++; else if (c === '}') p--; }
      return p;
    };
    expect(profonditaPrimaDi('[data-contrast="high"] .kv-recon-chip {')).toBe(0);
    expect(profonditaPrimaDi('[data-contrast="high"] .kv-recon-chip--da-fatturare')).toBe(0);
    // CONTROLLO POSITIVO: la sonda sa riconoscere una regola annidata, altrimenti
    // starebbe dicendo «fuori da un layer» su qualunque cosa.
    let p = 0;
    for (const c of '@layer utilities { .x { color: red; } ') { if (c === '{') p++; else if (c === '}') p--; }
    expect(p).toBeGreaterThan(0);
  });

  it('A3: il :focus-visible globale ha colore verde ESPLICITO (non solo var) e uno stacco visibile', () => {
    // La regola globale sta su una riga che inizia con `:focus-visible {`
    // (quella HC è `[data-contrast="high"] *:focus-visible`, esclusa dal match).
    const m = css.match(/\n:focus-visible\s*\{([\s\S]*?)\}/)
    expect(m, 'regola :focus-visible globale presente').toBeTruthy()
    const block = m![1]
    expect(block).toMatch(/#006A5F/i)
    expect(block).toMatch(/box-shadow/)
  })
})
