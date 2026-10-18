// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * LOCK · un comando che compare solo al passaggio del mouse deve comparire anche senza mouse.
 *
 * LA STORIA (iPad, 2026-10-18). In Tailwind v4 `hover:` e `group-hover:` valgono solo dentro
 * `@media (hover: hover)`. Su un iPad, su un telefono e nell'app nativa quel media non vale mai:
 * un elemento `opacity-0 group-hover:opacity-100` lì resta invisibile per sempre. Due casi così
 * erano in produzione da mesi:
 *  - il cestino di un campo nel costruttore dei moduli (`DraggableField`): su iPad un campo non
 *    si poteva togliere;
 *  - «Apri ›» sulle schede delle sezioni (`SectionsView`): l'unico segno che la scheda si apre.
 *
 * Nessun test era rosso: in jsdom le classi non si applicano, e la Playwright della CI gira col
 * mouse.
 *
 * COSA SORVEGLIA. Ogni `className` letterale di `src/` che contiene `opacity-0` insieme a un
 * `…hover:opacity-100` deve avere anche `[@media(hover:none)]:opacity-100`. Si leggono SOLO le
 * stringhe dei `className`, non il testo del file: i commenti che raccontano il vecchio difetto
 * (come quello di `MediaGrid` sui pulsanti Scarica/Condividi) non contano.
 *
 * LE ECCEZIONI sono veli che ripetono un'informazione già in vista altrove, non comandi. Ognuna
 * ha la sua ragione accanto, e una firma che deve comparire nella stringa di classi: se la
 * stringa cambia, l'eccezione smette di valere e il lock torna a chiedere.
 */

const RADICE = join(__dirname, '..', '..', 'src');

const ECCEZIONI: { file: string; firma: string; perche: string }[] = [
  {
    file: 'components/features/gallery/MediaGrid.tsx',
    firma: 'bg-gradient-to-t from-black/50',
    perche: 'velo con didascalia e autore della miniatura: li ripete il visore che si apre al tocco',
  },
];

function fileTsx(dir: string): string[] {
  return (readdirSync(dir, { recursive: true }) as string[])
    .filter((f) => f.endsWith('.tsx'))
    .map((f) => join(dir, f));
}

/** Le stringhe di classi letterali: `className="…"` e `className={`…`}`. */
function stringheDiClassi(testo: string): string[] {
  const out: string[] = [];
  for (const m of testo.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)) out.push(m[1] ?? m[2] ?? '');
  return out;
}

const FILE = fileTsx(RADICE);

const violazioni: string[] = [];
const eccezioniUsate = new Set<string>();
for (const assoluto of FILE) {
  const file = relative(RADICE, assoluto);
  for (const classi of stringheDiClassi(readFileSync(assoluto, 'utf8'))) {
    const token = classi.split(/\s+/);
    const nascosto = token.includes('opacity-0');
    const alPassaggio = token.some((t) => /hover:opacity-100$/.test(t));
    if (!nascosto || !alPassaggio) continue;
    if (token.includes('[@media(hover:none)]:opacity-100')) continue;
    const eccezione = ECCEZIONI.find((e) => e.file === file && classi.includes(e.firma));
    if (eccezione) {
      eccezioniUsate.add(eccezione.file + eccezione.firma);
      continue;
    }
    violazioni.push(`${file}: "${classi.trim().slice(0, 120)}"`);
  }
}

describe('comandi visibili anche senza mouse', () => {
  it('scandisce davvero i componenti di src/ (un lock che legge zero file è verde per niente)', () => {
    expect(FILE.length).toBeGreaterThan(300);
  });

  it('nessun `opacity-0 …hover:opacity-100` senza `[@media(hover:none)]:opacity-100`', () => {
    expect(violazioni).toEqual([]);
  });

  it('ogni eccezione corrisponde ancora a una stringa vera (altrimenti è una delega in bianco)', () => {
    for (const e of ECCEZIONI) expect(eccezioniUsate.has(e.file + e.firma), e.file).toBe(true);
  });
});
