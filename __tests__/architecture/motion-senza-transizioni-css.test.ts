// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * LOCK · un elemento `motion.*` che anima l'opacità non ha transizioni CSS né classi di opacità.
 *
 * LA STORIA (iPad, 2026-10-18). Nelle schermate WebKit dell'E2E tablet di #239 e #240 due card
 * degli avvisi per giro restavano bianche, a opacità 0, in posizioni diverse ogni volta. La card
 * era un `motion.div` che entrava con `initial={{ opacity: 0 }}` e aveva fra le classi anche
 * `transition-all`: framer-motion anima l'opacità con le Web Animations e alla fine scrive il
 * valore in linea, e una transizione CSS sulla stessa proprietà dello stesso elemento gli contende
 * quel valore. Lo schema stava in sette componenti.
 *
 * Lo stesso censimento ne ha trovato un secondo, certo e non solo su WebKit: due di quei sette
 * (`StudentTagger`, `TaskCard`) «spegnevano» un elemento con `opacity-40`/`opacity-80` fra le
 * classi, e lo stile in linea `opacity: 1` dell'animazione lo cancellava. Il bambino non
 * taggabile e il compito approvato non sono mai apparsi spenti.
 *
 * COSA SORVEGLIA, sui tag `<motion.…>` di `src/` che dichiarano l'opacità in `initial`:
 *  1. nessuna `transition-all`, `transition-opacity`, `transition-transform` o `transition`
 *     nuda fra le classi (`transition-colors` e `transition-[…]` senza opacity/transform vanno
 *     bene: il colore e l'ombra non li anima framer);
 *  2. nessuna classe `opacity-NN`: un'opacità diversa da 1 si dichiara in `animate`.
 *
 * Si legge il tag di apertura con le graffe bilanciate, non il file come testo: i commenti che
 * raccontano il difetto (questo compreso) non contano.
 */

const RADICE = join(__dirname, '..', '..', 'src');

function fileTsx(dir: string): string[] {
  return (readdirSync(dir, { recursive: true }) as string[])
    .filter((f) => f.endsWith('.tsx'))
    .map((f) => join(dir, f));
}

/** I tag di apertura `<motion.x …>`, letti fino al `>` fuori dalle graffe. */
function tagMotion(testo: string): { riga: number; tag: string }[] {
  const out: { riga: number; tag: string }[] = [];
  for (const m of testo.matchAll(/<motion\.\w+/g)) {
    let profondita = 0;
    let j = m.index + m[0].length;
    for (; j < testo.length; j++) {
      const c = testo[j];
      if (c === '{') profondita++;
      else if (c === '}') profondita--;
      else if (c === '>' && profondita === 0) break;
    }
    out.push({ riga: testo.slice(0, m.index).split('\n').length, tag: testo.slice(m.index, j) });
  }
  return out;
}

/**
 * Le parole dell'espressione `className=`, template e ternari compresi: si spezza su spazi,
 * apici, graffe e `?`, così `${ok ? 'opacity-80' : ''}` dà `opacity-80` e non `'opacity-80'`.
 */
function classiDelTag(tag: string): string[] {
  const m = tag.match(/className=(\{`[\s\S]*?`\}|"[^"]*"|\{[\s\S]*\})/);
  if (!m) return [];
  return m[1].split(/[\s'"`?{}$]+/).filter(Boolean);
}

const VIETATE = /^(transition|transition-all|transition-opacity|transition-transform)$/;
const OPACITA_DI_CLASSE = /^opacity-\d+$/;

const FILE = fileTsx(RADICE);
let tagConOpacita = 0;
const violazioni: string[] = [];
for (const assoluto of FILE) {
  const file = relative(RADICE, assoluto);
  for (const { riga, tag } of tagMotion(readFileSync(assoluto, 'utf8'))) {
    if (!/initial=\{\{[^}]*\bopacity\s*:/.test(tag)) continue;
    tagConOpacita++;
    for (const c of classiDelTag(tag)) {
      // `transition-[…]` è ammessa solo se non nomina opacità o trasformazioni.
      const arbitrariaVietata = /^transition-\[/.test(c) && /opacity|transform|translate|all/.test(c);
      if (VIETATE.test(c) || arbitrariaVietata || OPACITA_DI_CLASSE.test(c)) violazioni.push(`${file}:${riga} ${c}`);
    }
  }
}

describe('motion.* che anima l’opacità: niente transizioni CSS né classi di opacità', () => {
  it('trova davvero i tag motion con l’opacità in `initial` (un lock che non legge niente è verde per niente)', () => {
    expect(FILE.length).toBeGreaterThan(300);
    expect(tagConOpacita).toBeGreaterThan(20);
  });

  it('nessuna transizione su opacità/trasformazioni e nessuna `opacity-NN` fra le classi', () => {
    expect(violazioni).toEqual([]);
  });
});
