import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { mascheraSorgente } from '../fixtures/sorgente';

/**
 * LOCK — nessun colore della palette DI SERIE di Tailwind dentro `src/`.
 *
 * ─── PERCHÉ ESISTE ──────────────────────────────────────────────────────────
 * Il 2026-09-04 la segnalazione era: «in alcune parti dell'app sono comparsi
 * elementi in nero, e alcune scritte sono poco visibili perché il colore è
 * troppo simile allo sfondo». Cercandolo, sono saltate fuori 81 utility grigie
 * di serie in sei file — `text-gray-400` (2,29:1 sul crema, sotto i 4,5:1 di
 * WCAG 1.4.3), `bg-gray-800` sulle tessere video, e tre classi che Tailwind
 * NON GENERA (`border-gray-150` ×2, `hover:bg-gray-250`): un bordo che qualcuno
 * credeva di aver messo e che non c'era.
 *
 * Il lock che avrebbe dovuto prenderle esiste da tempo —
 * `design-tokens-admin.test.ts` — ma copre SOLO `admin`. Le aree segnalate,
 * genitore e docente, non erano protette da niente. Questo file chiude quel
 * buco per tutto `src/`.
 *
 * ─── PERCHÉ UN COLORE DI SERIE È UN DIFETTO, NON UNA PREFERENZA ─────────────
 * L'app ha DUE modalità visive, e i token `kidville-*` sono ciò che le tiene
 * insieme. Un colore scritto a mano non partecipa: resta identico in Alto
 * Contrasto, dove le superfici attorno cambiano. E la palette di serie di
 * Tailwind è fredda e blu-grigia, mentre Clay Village è calda e verde-grigia:
 * anche quando il contrasto regge, il risultato «non rispecchia il brand» —
 * che è esattamente la seconda metà della segnalazione.
 * `design.md:41` lo dice da sempre: «Prevalentemente #006A5F su sfondi chiari,
 * AL POSTO del classico nero/grigio scuro».
 *
 * ─── COME SI SMALTISCE IL DEBITO ────────────────────────────────────────────
 * Le voci qui sotto hanno un numero ESATTO, e il meccanismo è quello di
 * `catch-muti-allowlist.test.ts`: se sale è rosso (stai rifinanziando il
 * debito), se scende è rosso (hai bonificato: scrivi il numero nuovo e abbassa
 * i tetti), se il file sparisce è rosso, se arriva a zero è rosso finché non
 * togli la voce. Il credito non speso non si accumula: è lo spazio in cui il
 * difetto rientra restando verde, ed è già successo in questo repo.
 */

const RADICE = path.resolve(__dirname, '../..');

/** Le famiglie di colore che Tailwind genera di suo. Nessuna è di brand. */
const PALETTE_DI_SERIE =
  'slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|' +
  'cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose';

/** Le proprietà che dipingono. `black`/`white`/`transparent` NON sono qui: sono
 *  senza tinta, e i loro casi legittimi (letterbox di un player, gradiente che
 *  rende leggibile una didascalia sopra una foto) non si distinguono staticamente
 *  da quelli sbagliati — li misura il contrasto a runtime, non una regex. */
const PROPRIETA =
  'text|bg|border|divide|from|via|to|ring|outline|decoration|shadow|accent|caret|placeholder|fill|stroke';

const RE_COLORE = new RegExp(`\\b(?:${PROPRIETA})-(?:${PALETTE_DI_SERIE})-\\d{2,3}\\b`, 'g');

/** Le tinte che Tailwind NON genera: la classe non produce NIENTE, in silenzio. */
const TINTE_INESISTENTI = new Set(['150', '250', '350', '450', '550', '650', '750', '850', '1000']);

function sorgenti(): string[] {
  const out: string[] = [];
  const giro = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) giro(p);
      else if (/\.tsx?$/.test(e.name) && !/\.(test|spec)\./.test(e.name)) {
        out.push(path.relative(RADICE, p));
      }
    }
  };
  giro(path.join(RADICE, 'src'));
  return out.sort();
}

/** I commenti si mascherano SEMPRE: in questo repo si documentano i rapporti di
 *  contrasto misurati, e una regex ingenua diventerebbe rossa proprio dove
 *  qualcuno ha fatto la cosa giusta. È la trappola già pagata da
 *  `utility-kidville-esistenti.test.ts` (5 falsi positivi). */
function colori(rel: string): string[] {
  const src = fs.readFileSync(path.join(RADICE, rel), 'utf8');
  return mascheraSorgente(src).senzaCommenti.match(RE_COLORE) ?? [];
}

/**
 * DEBITO DICHIARATO — misurato il 2026-09-04, 76 occorrenze in 11 file.
 * Nessuna di queste è un grigio: i grigi sono stati bonificati tutti lo stesso
 * giorno. Sono colori SEMANTICI di serie dove il tema ha già il proprio token.
 */
/**
 * DEBITO DICHIARATO — **VUOTO dal 2026-09-04**.
 * La misura di partenza era 76 occorrenze in 11 file. Sono state bonificate tutte
 * nello stesso giro, su decisione del titolare: «devono restare solo i colori del
 * brand». Le sostituzioni non sono state inventate — ognuna aveva gia' il proprio
 * token: `red`→`error`, `amber`→`warn`, `blue`→`info`, `yellow`→la scala gialla,
 * `orange`→`warn` (era gia' mescolato a `kidville-warn` nello stesso className),
 * `pink`→ le tinte per grado, che `globals.css:136-138` dichiara da sempre.
 * La lista resta qui, vuota e col suo meccanismo intatto: se un giorno serve di
 * nuovo, si riapre — ma il tetto e' ZERO e non risale.
 */
const DEBITO: { path: string; n: number; nota: string }[] = [];
const TETTO_FILE = 0;
const TETTO_OCCORRENZE = 0;

const MISURA = sorgenti()
  .map((p) => ({ path: p, n: colori(p).length }))
  .filter((v) => v.n > 0);

describe('lock — nessun colore della palette di serie di Tailwind in src/', () => {
  it('CONTROLLO POSITIVO: la sonda vede gli usi veri, ignora i commenti e non è cieca', () => {
    const finto = [
      'const a = "text-gray-400";',
      'const b = `p-2 bg-red-50 border-amber-200`;',
      '// era text-gray-400, ora è text-kidville-sub',
      '/* `muted` #9AA6A2 su bianco = 2,51:1 — misurato, e il commento resta */',
    ].join('\n');
    const visti = mascheraSorgente(finto).senzaCommenti.match(RE_COLORE) ?? [];
    expect(visti.sort(), `visti: ${JSON.stringify(visti)}`).toEqual(['bg-red-50', 'border-amber-200', 'text-gray-400']);
    // …e sul repo vero la sonda deve avere qualcosa da leggere: uno SCOPE
    // sbagliato deve far cadere QUESTA riga, non rendere verde tutto il resto.
    expect(sorgenti().length, 'nessun sorgente trovato sotto src/: la sonda guarda altrove').toBeGreaterThan(500);
  });

  it('il debito è ben formato e senza doppioni', () => {
    for (const v of DEBITO) {
      expect(typeof v.path).toBe('string');
      expect(v.path.startsWith('src/'), `path fuori da src/: ${v.path}`).toBe(true);
      expect(Number.isInteger(v.n) && v.n > 0, `n non valido: ${v.path}`).toBe(true);
      expect(v.nota.length, `voce senza motivazione: ${v.path}`).toBeGreaterThan(0);
    }
    const doppi = DEBITO.map((v) => v.path).filter((p, i, a) => a.indexOf(p) !== i);
    expect(doppi, 'stesso file due volte: il conteggio non sarebbe più leggibile').toEqual([]);
    expect(DEBITO.reduce((s, v) => s + v.n, 0)).toBe(TETTO_OCCORRENZE);
    expect(DEBITO.length).toBe(TETTO_FILE);
    // Debito a ZERO: la misura sul repo vero deve essere vuota. E' l'asserzione
    // piu' forte che questo lock possa fare, e sostituisce i tetti: prima
    // passava con qualunque numero <= 76, ora solo con 0.
    expect(
      MISURA,
      'Colori della palette di serie di Tailwind in src/. Il debito e stato azzerato il ' +
        '2026-09-04: non si riapre. Usa i token `kidville-*`.',
    ).toEqual([]);
  });

  it('ogni voce esiste ancora e ha ESATTAMENTE il numero dichiarato', () => {
    const scomparsi: string[] = [];
    const bonificati: string[] = [];
    const divergenti: string[] = [];
    for (const v of DEBITO) {
      if (!fs.existsSync(path.join(RADICE, v.path))) { scomparsi.push(v.path); continue; }
      const n = colori(v.path).length;
      if (n === 0) { bonificati.push(v.path); continue; }
      if (n !== v.n) divergenti.push(`${v.path}: dichiarati ${v.n}, misurati ${n} → scrivi n: ${n}`);
    }
    expect(scomparsi, 'File spariti: togli la voce e abbassa i tetti.').toEqual([]);
    expect(
      bonificati,
      'Questi file non usano più colori di serie: ottimo. Ora togli la voce e abbassa TETTO_FILE / ' +
        'TETTO_OCCORRENZE. Se la voce resta, resta anche il permesso, e il prossimo colore di serie ' +
        'rientra lì senza che nessuno se ne accorga.',
    ).toEqual([]);
    expect(
      divergenti,
      'Il numero non combacia. Se è SALITO: il debito si smaltisce, non si rifinanzia — usa i token ' +
        '`kidville-*`. Se è SCESO: hai bonificato, scrivi il numero nuovo invece di lasciare credito ' +
        'non speso, che è lo spazio in cui il difetto rientra restando verde.',
    ).toEqual([]);
  });

  it('nessun file FUORI dal debito usa la palette di serie', () => {
    const noti = new Set(DEBITO.map((v) => v.path));
    const nuovi = MISURA.filter((v) => !noti.has(v.path)).map(
      (v) => `${v.path} (${v.n}): ${[...new Set(colori(v.path))].join(', ')}`,
    );
    expect(
      nuovi,
      'Colori della palette di serie di Tailwind fuori dal debito dichiarato. Usa i token: testo ' +
        '`text-kidville-ink`/`-sub`, linee `border-kidville-line`, superfici `bg-kidville-cream`/' +
        '`-neutral-soft`, stati `error`/`warn`/`info`-soft e -strong. Un colore scritto a mano non ' +
        'partecipa all\'Alto Contrasto e non è di brand.',
    ).toEqual([]);
  });

  it('i tetti scendono e non risalgono', () => {
    const occorrenze = MISURA.reduce((s, v) => s + v.n, 0);
    expect(MISURA.length, `file: ${MISURA.length} (tetto ${TETTO_FILE})`).toBeLessThanOrEqual(TETTO_FILE);
    expect(occorrenze, `occorrenze: ${occorrenze} (tetto ${TETTO_OCCORRENZE})`).toBeLessThanOrEqual(TETTO_OCCORRENZE);
  });

  it('nessuna TINTA INESISTENTE: `gray-150` non produce niente, in silenzio', () => {
    // Il 2026-09-04 in `MediaGrid.tsx` c'erano due `border-gray-150` e un
    // `hover:bg-gray-250`. Tailwind non genera quelle tinte: le classi erano
    // inerti, e il bordo che qualcuno credeva di aver messo non c'era. È il
    // difetto più silenzioso del lotto, perché il codice sembra giusto.
    const inesistenti: string[] = [];
    for (const p of sorgenti()) {
      for (const c of colori(p)) {
        const tinta = c.split('-').pop()!;
        if (TINTE_INESISTENTI.has(tinta)) inesistenti.push(`${p} → ${c}`);
      }
    }
    expect(
      inesistenti,
      'Tailwind non genera queste tinte: la classe non dipinge NIENTE e non dà errore. ' +
        'Usa una tinta esistente o, meglio, un token `kidville-*`.',
    ).toEqual([]);
  });
});
