import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Lock: i flow Maestro non toccano un'etichetta AMBIGUA per solo testo.
 *
 * ─── IL DIFETTO CHE QUESTO TEST RENDE IMPOSSIBILE ──────────────────────────
 * Collaudo Android del 2026-07-31, `android-percorso-segreteria.yaml`:
 * `tapOn: "Mensa"` non navigava. L'app era sana. Nell'albero di accessibilità
 * della WebView Capacitor «Mensa» esiste DUE volte sulla dashboard del cockpit:
 *   1) la tile della griglia «Tutti i moduli» (fondo pagina, misurata FUORI
 *      viewport, schiacciata a y=1857 con ALTEZZA 0);
 *   2) il tab vero della bottom-nav.
 * Maestro prende la PRIMA corrispondenza: il tap finiva su un'area morta.
 * Identica causa sul tap «Anagrafica» dentro il bottom-sheet, dove la tile
 * omonima resta nell'albero DIETRO il foglio modale.
 *
 * ─── PERCHÉ UN LOCK, E NON «basta ricordarsene» ────────────────────────────
 * Questa classe di difetto ha due facce, e la seconda è peggiore della prima:
 *  - faccia rumorosa: il passo dopo il tap va in timeout e il flow fallisce
 *    (è così che l'abbiamo scoperto);
 *  - faccia SILENZIOSA: se il testo atteso dopo il tap esiste anche nella
 *    pagina di partenza, l'asserzione passa lo stesso e il flow dichiara PASS
 *    senza essersi mai mosso. È già successo — la trappola 1 in
 *    `android-screenshot-playstore.yaml` la descrive per esteso.
 * Da qui la regola R3: un tap a coordinate deve provare di essere atterrato
 * (asserzione POSITIVA sulla destinazione) e di aver lasciato la pagina di
 * partenza (asserzione NEGATIVA). Una sola delle due non basta.
 *
 * Il test è STATICO di proposito: la prova sul device richiede emulatore,
 * server e credenziali degli account TEST, che non stanno nel repo. Questo lock
 * gira in ogni `vitest run`, non solo quando qualcuno ha un emulatore acceso.
 */

const DIR_FLOWS = path.join(process.cwd(), '.claude', 'maestro-flows');

/**
 * Etichette che sul cockpit `/admin` esistono in DUE posti (bottom-nav / griglia
 * «Tutti i moduli» di `src/app/(dashboard)/admin/page.tsx`), quindi non possono
 * essere il selettore di un `tapOn`. Sono elencate come stringhe ESATTE e nella
 * loro forma regex non ancorata: entrambe le scritture matchano i due nodi.
 */
const ETICHETTE_AMBIGUE_COCKPIT = ['Mensa', '.*Mensa.*', 'Anagrafica', '.*Anagrafica.*'];

/** I flow che navigano il cockpit Direzione/Segreteria. */
const FLOWS_COCKPIT = ['android-percorso-segreteria.yaml', 'ios-percorso-segreteria.yaml'];

function leggiFlow(nome: string): string {
  return fs.readFileSync(path.join(DIR_FLOWS, nome), 'utf8');
}

function tuttiIFlow(): string[] {
  return fs
    .readdirSync(DIR_FLOWS)
    .filter((f) => f.endsWith('.yaml'))
    .sort();
}

/**
 * Corpo del flow (dopo il separatore `---`), senza commenti.
 * Il `#` si toglie solo se non è dentro una stringa fra virgolette — altrimenti
 * un selettore che contenesse `#` verrebbe mutilato in silenzio.
 */
function corpoSenzaCommenti(testo: string): string[] {
  const righe = testo.split('\n');
  const sep = righe.findIndex((r) => r.trim() === '---');
  if (sep < 0) return [];
  return righe
    .slice(sep + 1)
    .map((r) => {
      const i = r.search(/\s#/);
      if (i < 0) return r;
      const prima = r.slice(0, i);
      const virgolette = (prima.match(/"/g) ?? []).length;
      return virgolette % 2 === 0 ? prima.trimEnd() : r;
    })
    .filter((r) => !/^\s*#/.test(r))
    .filter((r) => r.trim() !== '');
}

function senzaVirgolette(v: string): string {
  const t = v.trim();
  return t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t;
}

/**
 * Selettori di TUTTI i `tapOn` del flow, anche quelli annidati dentro `runFlow`.
 * Restituisce il testo del selettore (forma inline `- tapOn: "X"` oppure campo
 * `text:` del blocco) o `@point` quando il tap è a coordinate.
 */
function selettoriDeiTap(testo: string): string[] {
  const righe = corpoSenzaCommenti(testo);
  const fuori: string[] = [];
  for (let i = 0; i < righe.length; i++) {
    const m = righe[i].match(/^(\s*)-\s+tapOn:\s*(.*)$/);
    if (!m) continue;
    const indentDash = m[1].length;
    const inline = m[2].trim();
    if (inline !== '') {
      fuori.push(senzaVirgolette(inline));
      continue;
    }
    // blocco: righe più indentate del trattino
    for (let j = i + 1; j < righe.length; j++) {
      const ind = righe[j].search(/\S/);
      if (ind <= indentDash) break;
      const t = righe[j].match(/^\s*text:\s*(.+)$/);
      if (t) fuori.push(senzaVirgolette(t[1]));
      if (/^\s*point:\s*/.test(righe[j])) fuori.push('@point');
    }
  }
  return fuori;
}

/** Comandi di primo livello, in ordine: `[{ nome, corpo }]`. */
function passi(testo: string): { nome: string; corpo: string }[] {
  const righe = corpoSenzaCommenti(testo);
  const indentBase = Math.min(
    ...righe.filter((r) => /^\s*-\s+/.test(r)).map((r) => r.search(/\S/)),
  );
  const fuori: { nome: string; corpo: string }[] = [];
  for (const r of righe) {
    const ind = r.search(/\S/);
    const m = r.match(/^\s*-\s+([A-Za-z]+)/);
    if (m && ind === indentBase) {
      fuori.push({ nome: m[1], corpo: r });
    } else if (fuori.length > 0) {
      fuori[fuori.length - 1].corpo += `\n${r}`;
    }
  }
  return fuori;
}

describe('lock: selettori dei flow Maestro (nodi duplicati)', () => {
  it('ogni flow ha il separatore --- e almeno un comando', () => {
    const flows = tuttiIFlow();
    expect(flows.length).toBeGreaterThan(0);
    for (const f of flows) {
      const p = passi(leggiFlow(f));
      expect(p.length, `${f}: nessun comando dopo il separatore ---`).toBeGreaterThan(0);
    }
  });

  it('R1 · i flow del cockpit non toccano «Mensa»/«Anagrafica» per solo testo', () => {
    const colpevoli: string[] = [];
    for (const f of FLOWS_COCKPIT) {
      for (const s of selettoriDeiTap(leggiFlow(f))) {
        if (ETICHETTE_AMBIGUE_COCKPIT.includes(s)) colpevoli.push(`${f} → tapOn "${s}"`);
      }
    }
    expect(
      colpevoli,
      'Etichetta ambigua sul cockpit: esiste sia nella bottom-nav sia nella griglia ' +
        '«Tutti i moduli». Maestro prende la prima corrispondenza (la tile fuori ' +
        'viewport, altezza 0) e tocca un\'area morta. Vedi .claude/maestro-flows/README.md.',
    ).toEqual([]);
  });

  it('R2 · il tab Mensa e la voce Anagrafica sono raggiunti con selettori disambiguati', () => {
    // Controllo POSITIVO: senza, R1 tornerebbe verde anche cancellando i passi.
    for (const f of FLOWS_COCKPIT) {
      const sel = selettoriDeiTap(leggiFlow(f));
      expect(sel, `${f}: manca il tap a coordinate sul tab «Mensa» della bottom-nav`).toContain(
        '@point',
      );
      expect(
        sel.some((s) => s.includes('Alunni, famiglie e personale')),
        `${f}: la voce «Anagrafica» del bottom-sheet va toccata sul sottotitolo univoco ` +
          '«Alunni, famiglie e personale» (messages/it/adminNav.json → anagraficaSub)',
      ).toBe(true);
    }
  });

  it('R3 · nessun tap a coordinate senza prova di essere atterrato e di essersi mosso', () => {
    const colpevoli: string[] = [];
    for (const f of tuttiIFlow()) {
      const p = passi(leggiFlow(f));
      p.forEach((passo, i) => {
        if (passo.nome !== 'tapOn' || !/point:/.test(passo.corpo)) return;
        const seguito = p.slice(i + 1, i + 7).map((x) => x.nome);
        if (!seguito.includes('extendedWaitUntil')) {
          colpevoli.push(`${f} · tap #${i}: manca l'asserzione POSITIVA sulla destinazione`);
        }
        if (!seguito.includes('assertNotVisible')) {
          colpevoli.push(`${f} · tap #${i}: manca l'asserzione NEGATIVA (aver lasciato la pagina)`);
        }
      });
    }
    expect(
      colpevoli,
      'Un tap a coordinate è cieco: se il layout si sposta, il tap cade nel vuoto. Senza ' +
        'un controllo positivo (sono arrivato) E uno negativo (non sono più dov\'ero) il ' +
        'flow può dichiarare PASS senza essersi mosso.',
    ).toEqual([]);
  });
});
