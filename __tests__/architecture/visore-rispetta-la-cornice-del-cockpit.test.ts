// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * LOCK · IL VISORE DEI MEDIA NON COPRE BINARIO E SIDEBAR DEL COCKPIT.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * LA STORIA (2026-11-03, revisione del Compito 2 del visore unico). Il visore dei media
 * viveva dentro `MediaGrid`, quindi dentro `<main data-cockpit-content>` del layout admin,
 * e `globals.css` ha una regola che da 744 px fa partire ogni overlay `fixed inset-0` di
 * quell'area DOPO la navigazione:
 *
 *     @media (min-width: 46.5rem) { [data-cockpit-content] .fixed.inset-0 { left: var(--kv-rail-w) } }
 *
 * Estratto in `VisoreMedia` e reso con `createPortal` su `document.body` (per uscire dal
 * contesto d'impilamento della chat), il visore usciva anche da quell'area: la regola non lo
 * vedeva più, e nel cockpit dipingeva a `z-[115]` sopra binario, sidebar e topbar. Nessun test
 * era rosso: i test del visore leggono il DOM, non applicano il CSS.
 *
 * LA CORREZIONE: nel cockpit il portale si monta NELL'area contenuto (`[data-cockpit-content]`),
 * altrove su `body`. La regola esistente copre così radice e `Modal` di conferma (figlio nel
 * DOM, `fixed inset-0`) senza ripetere 88px/16rem in un secondo posto e senza `:has()`, che le
 * WebView iOS 15.0–15.3 non conoscono. Il comportamento resta quello di prima.
 *
 * COSA SORVEGLIA, in tre metà che si reggono a vicenda:
 *  1. `globals.css` ha ancora la regola, con quel selettore, dentro la media query dei 744 px
 *     (se qualcuno la toglie o la riscrive per un altro selettore, il visore torna a coprire
 *     la navigazione e nessun altro test se ne accorge);
 *  2. `VisoreMedia` sceglie quell'area come contenitore, ricade su `body` altrove e NON
 *     riscrive le larghezze della navigazione (una sola fonte: `--kv-rail-w`);
 *  3. il layout admin dichiara `data-cockpit-content` sul `<main>`, e né il guscio, né il
 *     wrapper del tablet, né il `<main>` creano un contesto d'impilamento: se lo creassero, il
 *     `z-[115]` del visore varrebbe solo dentro il `<main>` e la navigazione, `z-[105]`, lo
 *     scavalcherebbe di nuovo (lo stesso difetto del lock `visore-media-sopra-la-bottom-nav`).
 *
 * ⚠️ CIÒ CHE NON PUÒ VEDERE: il CSS applicato in un browser. Lo copre, per la parte DOM, il
 * gruppo «nel cockpit non copre binario e sidebar» di `__tests__/components/VisoreMedia.test.tsx`,
 * che valuta il selettore della regola sul DOM vero. La misura sul dispositivo (cockpit a
 * 744–1023 px e da 1024 px, visore aperto, binario e sidebar visibili) resta da fare e si
 * annota con la data, non si deduce da questo lock.
 *
 * ⚠️ PROVATO A ROMPERSI (2026-11-03), una mutazione alla volta, ripristinando il file dopo
 * ciascuna: togliendo il selettore da `VisoreMedia` (rossi 3: il lock e due test del DOM),
 * togliendo la regola da `globals.css` (rossi 2), spostando `data-cockpit-content` dal
 * `<main>` (rossi 2), dando `relative z-10` al `<main>` (rosso 1), scrivendo `left: 88px` a
 * mano nella regola invece di `var(--kv-rail-w)` (rosso 1). Cinque prove, cinque rossi.
 */

const RADICE = process.cwd();
const leggi = (p: string) => readFileSync(join(RADICE, p), 'utf8');

/** Toglie i commenti: un lock che legge un file come testo legge anche i propri alibi. */
function senzaCommentiCss(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}
function senzaCommentiTs(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((riga) => riga.replace(/(^|[^:'"`\w])\/\/.*$/, '$1'))
    .join('\n');
}
/** Il corpo di un blocco `{ … }` che inizia all'indice `apri` (la graffa di apertura). */
function corpoBlocco(testo: string, apri: number): string {
  let profondita = 0;
  for (let i = apri; i < testo.length; i += 1) {
    if (testo[i] === '{') profondita += 1;
    if (testo[i] === '}') {
      profondita -= 1;
      if (profondita === 0) return testo.slice(apri + 1, i);
    }
  }
  throw new Error('graffa non chiusa');
}

describe('il visore dei media rispetta la cornice del cockpit', () => {
  const REGOLA = '[data-cockpit-content] .fixed.inset-0';

  it('globals.css: da 46.5rem la regola fa partire gli overlay dopo `--kv-rail-w`', () => {
    const css = senzaCommentiCss(leggi('src/app/globals.css'));
    // Il file ha PIÙ media query da 46.5rem (le altre non c'entrano): si guardano tutte.
    const blocchi = [...css.matchAll(/@media \(min-width: 46\.5rem\)\s*\{/g)].map((m) =>
      corpoBlocco(css, m.index! + m[0].length - 1),
    );
    expect(blocchi.length, 'nessuna media query da 46.5rem (744 px) in globals.css').toBeGreaterThan(0);
    const regole = blocchi
      .map((b) => b.match(/\[data-cockpit-content\] \.fixed\.inset-0\s*\{([^}]*)\}/))
      .filter((m): m is RegExpMatchArray => m !== null);
    expect(regole, `dentro nessuna media query da 46.5rem c'è la regola «${REGOLA}»`).toHaveLength(1);
    expect(
      regole[0][1].replace(/\s+/g, ' ').trim(),
      'la regola non fa più partire l’overlay dopo la navigazione (`left: var(--kv-rail-w)`)',
    ).toBe('left: var(--kv-rail-w);');
  });

  it('globals.css: la regola non vive fuori dalla media query, né dietro `:has()`', () => {
    const css = senzaCommentiCss(leggi('src/app/globals.css'));
    const occorrenze = css.split(REGOLA).length - 1;
    expect(occorrenze, `«${REGOLA}» deve comparire UNA volta sola`).toBe(1);
    expect(css, '`:has()` non esiste su iOS 15.0–15.3: dentro una lista di selettori invalida tutta la regola').not.toMatch(
      /:has\([^)]*(data-cockpit-content|data-kv-guscio-admin)/,
    );
  });

  it('VisoreMedia: nel cockpit il portale va nell’area contenuto, altrove su body', () => {
    const src = senzaCommentiTs(leggi('src/components/features/media/VisoreMedia.tsx'));
    expect(src, 'il selettore dell’area contenuto non compare più nel codice di VisoreMedia').toContain(
      "'[data-cockpit-content]'",
    );
    expect(src, 'manca la ricaduta su document.body fuori dal cockpit').toMatch(
      /document\.querySelector<HTMLElement>\([A-Z_]+\)\s*\?\?\s*document\.body/,
    );
    expect(src, 'il portale non usa il contenitore scelto').toMatch(/createPortal\([\s\S]*,\s*contenitore,?\s*\)/);
    expect(src, 'VisoreMedia torna a montarsi su body senza condizioni').not.toMatch(
      /createPortal\([\s\S]*,\s*document\.body,?\s*\)/,
    );
  });

  it('VisoreMedia: non riscrive le larghezze della navigazione (una sola fonte, `--kv-rail-w`)', () => {
    const src = senzaCommentiTs(leggi('src/components/features/media/VisoreMedia.tsx'));
    for (const copia of ['88px', '16rem', '--kv-rail-w', 'left-[88px]', 'left-64', 'lg:left-', 'tablet:left-']) {
      expect(src, `VisoreMedia copia la larghezza della navigazione («${copia}»): vale solo ciò che dice globals.css`).not.toContain(
        copia,
      );
    }
  });

  it('il layout admin dichiara l’area contenuto sul <main>, dentro il guscio che porta `--kv-rail-w`', () => {
    const layout = leggi('src/app/(dashboard)/admin/layout.tsx');
    // Il guscio è il `<div …>` vero, NON la prima occorrenza della parola: il commento di testa del
    // layout (riga 20) cita `data-kv-guscio-admin` ben prima di qualunque elemento, e con
    // `indexOf` il confronto «il <main> sta a valle del guscio» era vero per costruzione, anche
    // con il <main> fuori dal guscio (corretto il 2026-11-03, revisione del Compito 2).
    const guscio = layout.search(/<div[^>]*data-kv-guscio-admin/);
    const main = layout.search(/<main[^>]*data-cockpit-content/);
    expect(guscio, 'manca `data-kv-guscio-admin` nel layout admin').toBeGreaterThan(-1);
    expect(main, 'il <main> del layout admin non dichiara più `data-cockpit-content`').toBeGreaterThan(-1);
    expect(main, '`<main data-cockpit-content>` deve stare dentro il guscio, a valle di `data-kv-guscio-admin`').toBeGreaterThan(
      guscio,
    );
    const occorrenze = layout.split('data-cockpit-content').length - 1;
    expect(occorrenze, '`data-cockpit-content` deve stare su UN solo elemento').toBe(1);
  });

  it('guscio, wrapper del tablet e <main> non creano un contesto d’impilamento', () => {
    const layout = leggi('src/app/(dashboard)/admin/layout.tsx');
    const classiDi = (apertura: RegExp): string[] => {
      const tag = layout.match(apertura)?.[0];
      expect(tag, `nel layout admin non trovo l'elemento ${apertura}`).toBeDefined();
      return (tag!.match(/className="([^"]*)"/)?.[1] ?? '').split(/\s+/).filter(Boolean);
    };
    const elementi: Array<[string, string[]]> = [
      ['il guscio `data-kv-guscio-admin`', classiDi(/<div[^>]*data-kv-guscio-admin[^>]*>/)],
      ['il wrapper `tablet:flex`', classiDi(/<div className="tablet:flex">/)],
      ['il <main data-cockpit-content>', classiDi(/<main[^>]*data-cockpit-content[^>]*>/)],
    ];
    // Ogni famiglia che il CSS elenca fra le cause di un contesto d'impilamento (o di un
    // blocco contenitore per i `fixed`) raggiungibile con una classe Tailwind.
    const CREA_CONTESTO =
      /^(z-|transform|translate-|scale-|rotate-|skew-|opacity-(?!100$)|will-change|filter|blur-|brightness-|contrast-|backdrop-|isolate$|contain-|sticky$|fixed$|mix-blend-|perspective|origin-|overflow-clip$)/;
    for (const [nome, classi] of elementi) {
      for (const classe of classi) {
        const base = classe.includes(':') ? classe.slice(classe.lastIndexOf(':') + 1) : classe;
        expect(
          CREA_CONTESTO.test(base),
          `${nome} porta «${classe}», che crea un contesto d'impilamento: il z-[115] del visore smette di valere sulla navigazione`,
        ).toBe(false);
      }
    }
  });
});
