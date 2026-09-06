/**
 * IL MOTORE DI CASCATA — risolvere `globals.css` come lo risolve un browser.
 *
 * ─── PERCHÉ ESISTE, E PERCHÉ NON È UNA RISCRITTURA ──────────────────────────
 * `__tests__/a11y/contrasto-cascata.test.tsx` ha inventato questa tecnica il
 * 2026-08-01 per un BLOCCANTE che nessun test poteva vedere: un testo bianco su
 * fondo giallo che nessuna riga di CSS dichiarava: lo diceva la CASCATA di due
 * regole ciascuna sensata da sola. Quel file però è un file di TEST: importarlo
 * eseguirebbe i suoi `describe` dentro la suite di chi importa, cioè li
 * farebbe girare due volte. Il motore vive quindi qui, in un modulo che vitest
 * non raccoglie (non è `*.test.ts`) — stessa forma, stesse regole di cascata.
 *
 * L'ARITMETICA WCAG **non** è riscritta: arriva da `e2e/lib/sonda-contrasto.ts`,
 * l'unica copia che il repo tara (`__tests__/a11y/sonda-contrasto.test.ts`).
 * Qui sopra ci sta solo il pezzo che quel file non ha: la CASCATA.
 *
 * ⚠️ La convivenza con `contrasto-cascata.test.tsx` NON è tacita: chi usa questo
 * modulo deve ritarare il motore sulle stesse coppie che quel lock già misura
 * (le specificità, il difetto storico a 1,28:1, l'ordine delle regole). Se i due
 * motori divergono, la taratura diventa rossa. È la stessa disciplina con cui
 * `sonda-contrasto.test.ts` sorveglia la doppia copia della formula.
 *
 * ─── L'ASSUNTO CHE REGGE TUTTO ──────────────────────────────────────────────
 * `@theme inline` INLINA l'hex dentro l'utility Tailwind: `.text-kidville-green`
 * compila a `color:#006a5f`, non a un `var()`. Perciò ridefinire
 * `--color-kidville-*` sotto `[data-contrast="high"]` **non tocca nessuna
 * utility**: l'Alto Contrasto è dipinto superficie per superficie a mano. Le
 * utility sono in `@layer utilities` → perdono contro qualunque regola
 * non-layered di `globals.css`, a prescindere dalla specificità.
 */

import fs from 'node:fs';
import path from 'node:path';
import { contrasto as rapportoRgb, soglia } from '../../e2e/lib/sonda-contrasto';

// ── Aritmetica: importata, mai ricalcolata ──────────────────────────────────

/** `#RRGGBB` → la terna che `e2e/lib/sonda-contrasto.ts` sa misurare. */
export const rgb = (h: string): [number, number, number] => {
  const s = h.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16)) as [number, number, number];
};

/** Rapporto WCAG fra due hex. Il calcolo è quello condiviso, non una copia. */
export const contrasto = (a: string, b: string) => rapportoRgb(rgb(a), rgb(b));

export { soglia };

// ── Parser CSS: regole ordinate, con il contesto delle at-rule ──────────────
export type Dich = { prop: string; val: string };
export type Regola = {
  sel: string;
  dich: Dich[];
  contesto: string[];
  ordine: number;
  layer: boolean;
  /** Il selettore così come sta nel file, virgole comprese: serve ai messaggi. */
  gruppo: string;
};

function dichiarazioni(corpo: string): Dich[] {
  return corpo
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.includes(':'))
    .map((s) => ({
      prop: s.slice(0, s.indexOf(':')).trim().toLowerCase(),
      val: s.slice(s.indexOf(':') + 1).trim(),
    }))
    .filter((d) => d.prop.length > 0);
}

export function parseRegole(css: string): Regola[] {
  const testo = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: Regola[] = [];
  let ordine = 0;
  const scendi = (src: string, contesto: string[]) => {
    let buf = '';
    let i = 0;
    while (i < src.length) {
      const c = src[i];
      if (c === '{') {
        let liv = 1;
        let k = i + 1;
        while (k < src.length && liv > 0) {
          if (src[k] === '{') liv++;
          else if (src[k] === '}') liv--;
          k++;
        }
        const sel = buf.trim().replace(/\s+/g, ' ');
        const corpo = src.slice(i + 1, k - 1);
        if (corpo.includes('{')) scendi(corpo, [...contesto, sel]);
        else {
          const dich = dichiarazioni(corpo);
          const pos = ordine++;
          for (const uno of sel.split(',').map((s) => s.trim()).filter(Boolean)) {
            out.push({ sel: uno, dich, contesto, ordine: pos, layer: false, gruppo: sel });
          }
        }
        buf = '';
        i = k;
        continue;
      }
      if (c === '}' || c === ';') {
        buf = '';
        i++;
        continue;
      }
      buf += c;
      i++;
    }
  };
  scendi(testo, []);
  return out;
}

/** Specificità CSS (a,b,c) — id / classi+attributi+pseudo-classi / elementi. */
export function specificita(sel: string): [number, number, number] {
  const s = sel.replace(/\\./g, 'µ'); // gli escape (`.text-white\/70`) non sono combinatori
  const id = (s.match(/#[-\wµ]+/g) ?? []).length;
  const cls = (s.match(/\.[-\wµ]+/g) ?? []).length;
  const attr = (s.match(/\[[^\]]*\]/g) ?? []).length;
  const pcl = (s.match(/(?<![:\w])::?[-\w]+/g) ?? []).filter((p) => !p.startsWith('::')).length;
  const pel = (s.match(/::[-\w]+/g) ?? []).length;
  const elementi = (
    s
      .replace(/\[[^\]]*\]/g, ' ')
      .replace(/[.#]{1}[-\wµ]+/g, ' ')
      .replace(/::?[-\w]+(\([^)]*\))?/g, ' ')
      .match(/[a-zA-Z][-\w]*/g) ?? []
  ).length;
  return [id, cls + attr + pcl, elementi + pel];
}

/** I token `--color-kidville-*` dichiarati in un blocco di `globals.css`. */
export function token(selettore: string, regole: Regola[]): Record<string, string> {
  const blocco = regole.filter((r) => r.sel === selettore);
  if (blocco.length === 0) throw new Error(`blocco «${selettore}» assente da globals.css`);
  const out: Record<string, string> = {};
  for (const d of blocco.flatMap((r) => r.dich)) {
    const m = d.prop.match(/^--color-kidville-([a-z0-9-]+)$/);
    const h = d.val.match(/^#[0-9A-Fa-f]{6}$/);
    if (m && h) out[m[1]] = h[0].toUpperCase();
  }
  return out;
}

// ── Le proprietà che la sonda sa risolvere ──────────────────────────────────
export type Prop =
  | 'color'
  | 'background-color'
  | 'border-color'
  | 'outline-color'
  | 'text-decoration-line'
  | 'border-bottom-width'
  | 'box-shadow';

/** Le shorthand che portano dentro di sé il valore della loro proprietà lunga. */
const SHORTHAND: Partial<Record<Prop, string>> = {
  'background-color': 'background',
  'border-color': 'border',
  'outline-color': 'outline',
  'text-decoration-line': 'text-decoration',
  'border-bottom-width': 'border-bottom',
};

function coloreDaShorthand(val: string): string | null {
  if (/gradient|url\(/i.test(val)) return null;
  const m = val.match(/#[0-9A-Fa-f]{3,6}\b|var\(\s*--[-\w]+\s*\)|transparent/i);
  return m ? m[0] : null;
}

function valoreProp(r: Regola, prop: Prop): string | null {
  let v: string | null = null;
  const corta = SHORTHAND[prop];
  const cromatica = prop.endsWith('-color');
  for (const d of r.dich) {
    if (d.prop === prop) v = d.val;
    else if (prop === 'color' && d.prop === 'color') v = d.val;
    else if (corta && d.prop === corta) {
      if (cromatica) {
        const c = coloreDaShorthand(d.val);
        if (c) v = c;
      } else {
        v = d.val;
      }
    }
  }
  return v;
}

/** Confronto lessicografico dei pesi di cascata: `a` batte `b`? */
function batte(a: number[], b: number[]): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

// ── La sonda vera e propria ─────────────────────────────────────────────────

export interface Sonda {
  /** I token base, letti da `@theme inline`. Mai hex ricopiati a mano. */
  T: Record<string, string>;
  /** I token rimappati sotto `[data-contrast="high"]`. */
  T_HC: Record<string, string>;
  /** Tutte le regole: utility Tailwind (layered) + `globals.css` (non-layered). */
  REGOLE: Regola[];
  /** Solo le regole scritte a mano in `globals.css`. */
  REGOLE_CSS: Regola[];
  /**
   * Solo le utility Tailwind, come il compilatore le emette (hex INLINATO).
   * Esposte perché un censimento che parta dalle UTILITY invece che dalle regole
   * deve leggerle dalla stessa fonte che poi le misura: un elenco ricopiato a
   * mano accanto a questo divergerebbe alla prima ritintura di un token.
   */
  UTILITY: Regola[];
  vince(el: Element, prop: Prop, regole?: Regola[]): string | null;
  coloreTesto(el: Element, hc: boolean, regole?: Regola[]): string;
  sfondo(el: Element, hc: boolean, regole?: Regola[]): string;
  monta(html: string, hc: boolean): Element;
  /**
   * Monta un frammento che porta PIÙ sonde (`id` diversi): non pretende
   * `#sonda`, e chi lo usa poi misura gli elementi che gli interessano. Serve
   * agli stati vuoti delle news, dove il titolo e il testo cadono per motivi
   * diversi e vanno misurati separatamente.
   */
  montaAlbero(html: string, hc: boolean): void;
  /** Costruisce il DOM implicito in un selettore CSS e restituisce la foglia. */
  montaDaSelettore(sel: string, hc: boolean, guscio?: string): Element;
  misuraEl(el: Element, hc: boolean, regole?: Regola[]): { fg: string; bg: string; rapporto: number };
  misura(html: string, hc: boolean, regole?: Regola[]): { fg: string; bg: string; rapporto: number };
  pulisci(): void;
}

export function creaSonda(css: string): Sonda {
  const REGOLE_CSS = parseRegole(css);
  const T = token('@theme inline', REGOLE_CSS);
  const T_HC = token('[data-contrast="high"]', REGOLE_CSS);

  /**
   * Le utility Tailwind dei token, come le emette davvero il compilatore: con
   * `@theme inline` l'hex è INLINATO nella classe, NON è un `var()`.
   */
  const utility: Regola[] = [];
  let o = 0;
  for (const [nome, hex] of Object.entries(T)) {
    for (const [pref, prop] of [
      ['text', 'color'],
      ['bg', 'background-color'],
      ['border', 'border-color'],
    ] as const) {
      utility.push({
        sel: `.${pref}-kidville-${nome}`,
        dich: [{ prop, val: hex }],
        contesto: [],
        ordine: o++,
        layer: true,
        gruppo: `.${pref}-kidville-${nome}`,
      });
    }
  }
  for (const [sel, prop, val] of [
    ['.text-white', 'color', '#FFFFFF'],
    ['.bg-white', 'background-color', '#FFFFFF'],
    ['.text-black', 'color', '#000000'],
    ['.bg-black', 'background-color', '#000000'],
    ['.underline', 'text-decoration-line', 'underline'],
    ['.no-underline', 'text-decoration-line', 'none'],
  ] as const) {
    utility.push({ sel, dich: [{ prop, val }], contesto: [], ordine: o++, layer: true, gruppo: sel });
  }

  const REGOLE = [...utility, ...REGOLE_CSS];

  function vince(el: Element, prop: Prop, regole: Regola[] = REGOLE): string | null {
    let miglioreVal: string | null = null;
    let migliore: number[] | null = null;
    for (const r of regole) {
      if (r.contesto.length > 0) continue; // nessuna at-rule dichiara colore
      const v = valoreProp(r, prop);
      if (v === null) continue;
      let ok = false;
      try {
        ok = el.matches(r.sel);
      } catch {
        ok = false; // selettori non-CSS (`@theme inline`) → non colpiscono nulla
      }
      if (!ok) continue;
      const [a, b, c] = specificita(r.sel);
      const peso = [r.layer ? 0 : 1, a, b, c, r.ordine];
      if (migliore === null || batte(peso, migliore)) {
        migliore = peso;
        miglioreVal = v;
      }
    }
    return miglioreVal;
  }

  function risolviVar(v: string, hc: boolean): string | null {
    const m = v.match(/var\(\s*(--color-kidville-[a-z0-9-]+)\s*\)/);
    if (m) {
      const nome = m[1].replace('--color-kidville-', '');
      const val = (hc ? T_HC[nome] : undefined) ?? T[nome];
      return val ?? null;
    }
    const h = v.match(/#[0-9A-Fa-f]{6}\b/) ?? v.match(/#([0-9A-Fa-f])([0-9A-Fa-f])([0-9A-Fa-f])\b/);
    if (!h) return null;
    if (h[0].length === 4) return `#${h[1]}${h[1]}${h[2]}${h[2]}${h[3]}${h[3]}`.toUpperCase();
    return h[0].toUpperCase();
  }

  /**
   * L'INCHIOSTRO EFFETTIVO. Sale di padre in padre perché `color` si eredita:
   * un elemento che non dichiara nulla porta il colore del primo antenato che
   * lo dichiara. È esattamente il meccanismo del difetto D1.
   * Il ripiego finale è il valore di `body` risolto sui token, non un hex fisso.
   */
  function coloreTesto(el: Element, hc: boolean, regole: Regola[] = REGOLE): string {
    for (let n: Element | null = el; n; n = n.parentElement) {
      const v = vince(n, 'color', regole);
      if (v) {
        const c = risolviVar(v, hc);
        if (c) return c;
      }
    }
    return (hc ? T_HC.green : T.green) ?? '#000000';
  }

  /**
   * LA CARTA VERA. Sale di padre in padre finché non trova un fondo dipinto:
   * `background-color` NON si eredita, ma si VEDE attraverso i figli
   * trasparenti — ed è per questo che il fondo di un testo è quello del primo
   * antenato che ne dipinge uno, non quello dichiarato dalla regola che lo
   * riguarda. Sul difetto D1 è il punto decisivo: `[data-contrast="high"] body`
   * dipinge nero, ma il guscio della pagina ci mette sopra il crema.
   */
  function sfondo(el: Element, hc: boolean, regole: Regola[] = REGOLE): string {
    for (let n: Element | null = el; n; n = n.parentElement) {
      const v = vince(n, 'background-color', regole);
      if (v) {
        const c = risolviVar(v, hc);
        if (c) return c;
      }
    }
    return (hc ? T_HC.cream : T.cream) ?? '#FFFFFF';
  }

  function montaAlbero(html: string, hc: boolean): void {
    document.documentElement.setAttribute('data-contrast', hc ? 'high' : 'normal');
    document.body.innerHTML = html;
  }

  function monta(html: string, hc: boolean): Element {
    montaAlbero(html, hc);
    const el = document.getElementById('sonda');
    if (!el) throw new Error('elemento #sonda assente dal frammento montato');
    return el;
  }

  /** Un pezzo di selettore composto → tag, classi e attributi da mettere in DOM. */
  function compone(compound: string) {
    let tag = '';
    const classi: string[] = [];
    const attr: [string, string][] = [];
    let i = 0;
    while (i < compound.length) {
      const c = compound[i];
      if (c === '.') {
        i++;
        let n = '';
        while (i < compound.length && compound[i] !== '.' && compound[i] !== '[') {
          if (compound[i] === '\\') {
            i++;
            n += compound[i] ?? '';
            i++;
          } else {
            n += compound[i];
            i++;
          }
        }
        if (n) classi.push(n);
      } else if (c === '[') {
        const fine = compound.indexOf(']', i);
        const dentro = compound.slice(i + 1, fine === -1 ? compound.length : fine);
        const m = dentro.match(/^([-\w]+)(?:\s*=\s*"?([^"']*)"?)?$/);
        if (m) attr.push([m[1], m[2] ?? '']);
        i = fine === -1 ? compound.length : fine + 1;
      } else {
        tag += c;
        i++;
      }
    }
    return { tag: tag || 'div', classi, attr };
  }

  /**
   * Costruisce il DOM che un selettore PRETENDE, e lo appende dentro un guscio.
   * `A B > C` diventa `<A><B><C id="sonda">`. Serve a §2: le superfici nere
   * dell'Alto Contrasto non si elencano a mano — si leggono dal CSS, e per
   * misurarle bisogna saperle montare partendo dal loro solo selettore.
   */
  function montaDaSelettore(sel: string, hc: boolean, guscio = GUSCIO_PARENT): Element {
    const pezzi = sel
      .split(/\s+/)
      .filter((p) => p !== '>' && p.length > 0)
      .filter((p) => !/^\[data-contrast=/.test(p));
    document.documentElement.setAttribute('data-contrast', hc ? 'high' : 'normal');
    document.body.innerHTML = guscio;
    const radice = document.getElementById('guscio');
    if (!radice) throw new Error('guscio senza #guscio');
    let cursore: Element = radice;
    for (const pezzo of pezzi) {
      const { tag, classi, attr } = compone(pezzo);
      const nodo = document.createElement(tag);
      for (const c of classi) nodo.classList.add(c);
      for (const [k, v] of attr) nodo.setAttribute(k, v);
      cursore.appendChild(nodo);
      cursore = nodo;
    }
    // La sonda è un figlio NUDO: nessuna classe, nessun inchiostro proprio.
    // È il caso peggiore e insieme il più comune (il testo dentro una barra).
    const sonda = document.createElement('span');
    sonda.id = 'sonda';
    sonda.textContent = 'x';
    cursore.appendChild(sonda);
    return sonda;
  }

  function misuraEl(el: Element, hc: boolean, regole: Regola[] = REGOLE) {
    const fg = coloreTesto(el, hc, regole);
    const bg = sfondo(el, hc, regole);
    return { fg, bg, rapporto: contrasto(fg, bg) };
  }

  function misura(html: string, hc: boolean, regole: Regola[] = REGOLE) {
    return misuraEl(monta(html, hc), hc, regole);
  }

  function pulisci() {
    document.documentElement.removeAttribute('data-contrast');
    document.body.innerHTML = '';
  }

  return {
    T,
    T_HC,
    REGOLE,
    REGOLE_CSS,
    UTILITY: utility,
    vince,
    coloreTesto,
    sfondo,
    monta,
    montaAlbero,
    montaDaSelettore,
    misuraEl,
    misura,
    pulisci,
  };
}

// ── I gusci REALI dell'app, copiati dai layout ──────────────────────────────
// Non sono inventati: `src/app/(dashboard)/{parent,teacher,admin}/layout.tsx`
// portano tutti e tre `className="min-h-screen bg-kidville-cream" data-kv-shell`.
// La carta è CREMA — `#FEF1E4` inlinato da `@theme inline` — e in Alto Contrasto
// resta crema, perché il rimappaggio dei token non tocca le utility.
export const GUSCIO_PARENT =
  '<div id="guscio" class="min-h-screen bg-kidville-cream" data-kv-shell></div>';
/** Lo stesso guscio, ma con dentro una card bianca: l'altra carta dell'app. */
export const GUSCIO_CARD_BIANCA =
  '<div class="min-h-screen bg-kidville-cream" data-kv-shell><div id="guscio" class="rounded-card bg-white p-5 shadow-sm"></div></div>';
/** Il guscio delle 5 pagine pubbliche statiche (privacy, termini, assistenza, …). */
export const GUSCIO_PUBBLICO =
  '<main id="guscio" class="kv-public min-h-screen bg-kidville-cream px-4 py-10"></main>';

/** `src/app/globals.css`, letto una volta sola. */
export function leggiGlobals(): string {
  return fs.readFileSync(path.join(process.cwd(), 'src', 'app', 'globals.css'), 'utf8');
}
