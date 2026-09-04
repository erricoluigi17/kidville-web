import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * IL BUCO DI FORMATO DEL LOCK SU `muted` — e come si chiude.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LA STORIA, in due righe. `--color-kidville-muted` (#9AA6A2) vale 2,51:1 su bianco e
 * 2,27:1 su crema, contro i 4,5:1 di WCAG 1.4.3 AA. Il repo lo sa e ha già un lock
 * scritto apposta — `__tests__/a11y/testo-muted-allowlist.test.ts` — che vieta il token
 * come inchiostro su TUTTI i file, con un'allowlist del debito residuo che può solo
 * accorciarsi. Quel lock è buono. Ma cerca **una stringa sola, in due estensioni sole**:
 * `text-kidville-muted` dentro i `.ts`/`.tsx`.
 *
 * COSA GLI È PASSATO SOTTO IL NASO, misurato il 2026-08-04:
 *
 *  1. **I CSS module.** Il token può essere scritto come `color: var(--color-kidville-muted)`
 *     in un `.css`, dove la stringa `text-kidville-muted` non compare mai. Erano tre
 *     dichiarazioni, e non erano marginali: la didascalia «Caricamento…» dell'overlay che
 *     copre OGNI pagina (2,27:1 sulla crema — rilievo T09-F2), e **il segnaposto dei campi
 *     della schermata di login** (2,51:1 su bianco), cioè il testo più esposto dell'intero
 *     prodotto, che nessun rilievo del collaudo aveva nominato.
 *  2. **Il prefisso `placeholder-`.** `placeholder-kidville-muted` dipinge testo esattamente
 *     come `text-kidville-muted`, ma NON contiene quella sottostringa: 16 usi in 9 file
 *     erano invisibili al lock.
 *
 * LA LEZIONE, che è la ragione per cui questo file esiste invece di un `git blame`: una
 * regola che cerca una STRINGA sta cercando una convenzione di scrittura, non un difetto.
 * Il difetto è «questo colore dipinge testo»; le forme in cui lo si può scrivere sono
 * almeno quattro, e le prime due erano già in uso nel repo il giorno in cui il lock è nato.
 *
 * COSA FA QUESTO FILE. Copre le due superfici che l'altro non vede, con la stessa
 * disciplina:
 *  · §1 CSS — tolleranza ZERO: nessun `.css` sotto `src/` dipinge con quel token. Le tre
 *    dichiarazioni sono state bonificate in questo ciclo, quindi l'elenco parte vuoto e
 *    vuoto deve restare.
 *  · §2 `placeholder-` — inventario CONGELATO qui sotto (16 usi, 9 file, misurati il
 *    2026-08-04): un file nuovo è rosso subito, un file dell'elenco che ne aggiunge uno è
 *    rosso, i numeri possono solo scendere.
 *  · §3 controlli positivi: il difetto è misurato (non dedotto), e la sonda vede davvero
 *    una violazione piantata apposta.
 *  · §4 la forma del buco, scritta come asserzione: se qualcuno un giorno la legge e non
 *    ci crede, il test glielo dimostra in due righe.
 *
 * PERCHÉ UN FILE NUOVO E NON UNA MODIFICA A QUELLO ESISTENTE. I tetti di quel lock
 * (`TETTO_FILE`/`TETTO_OCCORRENZE`) sono la misura di UNA sonda: allargare la sonda li
 * farebbe salire, e «alzare il tetto» è esattamente la mossa che quel file vieta a parole
 * sue. Sonda nuova, misura nuova, tetto nuovo — e i due lock restano leggibili entrambi.
 */

const RADICE = process.cwd();
const SRC = path.join(RADICE, 'src');

/** La stringa che cerca il lock storico. Serve al §4 per dimostrare cosa NON vede. */
const SONDA_STORICA = 'text-kidville-muted';

// ── WCAG 2.x §1.4.3 — il rapporto di contrasto ───────────────────────────────
// Nove righe di aritmetica pura, ricopiate come già fa `testo-muted-allowlist.test.ts`:
// importarle da lì farebbe eseguire i suoi `describe` dentro questo file.
const canale = (c: number) => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
};
const luminanza = (hex: string) => {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return 0.2126 * canale(r) + 0.7152 * canale(g) + 0.0722 * canale(b);
};
const contrasto = (a: string, b: string) => {
  const [x, y] = [luminanza(a), luminanza(b)];
  const [alto, basso] = x > y ? [x, y] : [y, x];
  return Math.round(((alto + 0.05) / (basso + 0.05)) * 100) / 100;
};

/** Il valore dichiarato di un token nel blocco `@theme inline` di globals.css. */
function tokenTema(nome: string): string {
  const css = fs.readFileSync(path.join(RADICE, 'src/app/globals.css'), 'utf8');
  const blocco = css.slice(css.indexOf('@theme inline'));
  const m = blocco.match(new RegExp(`--color-kidville-${nome}\\s*:\\s*(#[0-9A-Fa-f]{6})`));
  expect(m, `token --color-kidville-${nome} non trovato in globals.css`).toBeTruthy();
  return m![1].toUpperCase();
}

/** Sostituisce i commenti `/* … *\/` con spazi. Un commento che CITA il token è
 *  documentazione — e questo ciclo ne ha scritti apposta, accanto a ogni bonifica. */
function mascheraCommentiCss(sorgente: string): string {
  return sorgente.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

/** Come sopra per TS/TSX, lasciando INTATTE le stringhe (dove vivono le classi). */
function mascheraCommentiTs(sorgente: string): string {
  let out = '';
  let i = 0;
  let stato: 'code' | 'riga' | 'blocco' | 'str' = 'code';
  let apice = '';
  while (i < sorgente.length) {
    const c = sorgente[i];
    const d = sorgente[i + 1];
    if (stato === 'code') {
      if (c === '/' && d === '/') { stato = 'riga'; out += '  '; i += 2; continue; }
      if (c === '/' && d === '*') { stato = 'blocco'; out += '  '; i += 2; continue; }
      if (c === '"' || c === "'" || c === '`') { stato = 'str'; apice = c; out += c; i++; continue; }
      out += c; i++; continue;
    }
    if (stato === 'riga') {
      if (c === '\n') { stato = 'code'; out += '\n'; } else out += ' ';
      i++; continue;
    }
    if (stato === 'blocco') {
      if (c === '*' && d === '/') { stato = 'code'; out += '  '; i += 2; continue; }
      out += c === '\n' ? '\n' : ' '; i++; continue;
    }
    if (c === '\\') { out += c + (d ?? ''); i += 2; continue; }
    if (c === apice) stato = 'code';
    out += c; i++;
  }
  return out;
}

function file(estensioni: RegExp, dir = SRC): string[] {
  const out: string[] = [];
  for (const voce of fs.readdirSync(dir, { withFileTypes: true })) {
    const assoluto = path.join(dir, voce.name);
    if (voce.isDirectory()) { out.push(...file(estensioni, assoluto)); continue; }
    if (!estensioni.test(voce.name)) continue;
    out.push(path.relative(RADICE, assoluto).split(path.sep).join('/'));
  }
  return out;
}

/**
 * §1 — il token usato come INCHIOSTRO in CSS.
 *
 * Si cerca la DICHIARAZIONE `color: var(--color-kidville-muted…)`, non la semplice
 * presenza del nome: in `globals.css` il token si dichiara (`--color-kidville-muted: …`),
 * si usa per i BORDI (`border-kidville-muted`, che è un contorno e ha una soglia diversa,
 * 3:1 di 1.4.11) e compare nei selettori delle regole di ALTO CONTRASTO — che sono il
 * rimedio, non l'uso. Contare quelle righe vorrebbe dire chiedere di cancellare proprio
 * ciò che corregge il difetto.
 *
 * `color:` copre anche i glifi: un `<svg>` che eredita `currentColor` è inchiostro quanto
 * una lettera, ed è così che il token dipingeva l'icona dentro i campi della login.
 */
const RE_COLOR_MUTED = /(^|[;{\s])color\s*:\s*var\(\s*--color-kidville-muted\b/;

function dichiarazioniColoreMuted(rel: string): number[] {
  const righe = mascheraCommentiCss(fs.readFileSync(path.join(RADICE, rel), 'utf8')).split('\n');
  const out: number[] = [];
  righe.forEach((r, i) => { if (RE_COLOR_MUTED.test(r)) out.push(i + 1); });
  return out;
}

/** §2 — il token usato come inchiostro del SEGNAPOSTO in TS/TSX. */
const RE_PLACEHOLDER = /placeholder-kidville-muted|placeholder:text-kidville-muted/g;

function quantiSegnaposto(rel: string): number {
  const sorgente = mascheraCommentiTs(fs.readFileSync(path.join(RADICE, rel), 'utf8'));
  return (sorgente.match(RE_PLACEHOLDER) ?? []).length;
}

/**
 * INVENTARIO CONGELATO DEI SEGNAPOSTI — misurato il 2026-08-04, 16 usi in 9 file.
 * Nessuno di questi file appartiene alle superfici pubbliche: sono pannelli interni
 * (costruttore di moduli, graduatorie, chat, diario). Il numero può solo scendere;
 * un file che non è in elenco è rosso subito.
 */
const SEGNAPOSTO_NOTI: { path: string; n: number }[] = [];
const TETTO_SEGNAPOSTO_FILE = 0;
const TETTO_SEGNAPOSTO_OCCORRENZE = 0;

const CSS = file(/\.css$/);
const TSX = file(/\.tsx?$/);
const MISURA_SEGNAPOSTO = TSX.map((f) => ({ path: f, n: quantiSegnaposto(f) })).filter((v) => v.n > 0);

describe('lock — `muted` non è un inchiostro, nemmeno nei formati che l’altro lock non vede', () => {
  // ── §3 — controlli positivi ────────────────────────────────────────────────
  it('CONTROLLO POSITIVO: il difetto è MISURATO — `muted` sotto AA, `sub` sopra', () => {
    const muted = tokenTema('muted');
    const sub = tokenTema('sub');
    // I due numeri del rilievo T09-F2 e del segnaposto della login, ricalcolati qui.
    expect(contrasto(muted, tokenTema('cream'))).toBe(3.43);
    expect(contrasto(muted, tokenTema('white'))).toBe(3.8);
    expect(contrasto(sub, tokenTema('cream'))).toBeGreaterThanOrEqual(4.5);
    expect(contrasto(sub, tokenTema('white'))).toBeGreaterThanOrEqual(4.5);
    // Taratura della formula: se fosse sbagliata, questa riga cadrebbe per prima.
    expect(contrasto('#000000', '#FFFFFF')).toBe(21);
  });

  it('CONTROLLO POSITIVO: la sonda CSS vede una violazione piantata, e ignora rimedi e bordi', () => {
    const finto = [
      '.a { color: var(--color-kidville-muted); }',
      '.b { color: var(--color-kidville-muted, #9AA6A2); }',
      '  --color-kidville-muted: #9AA6A2;',                       // dichiarazione del token
      '  border-color: var(--color-kidville-muted);',             // bordo: soglia 3:1, altra regola
      '[data-contrast="high"] .x .text-kidville-muted { color: #000; }', // il RIMEDIO
      '/* color: var(--color-kidville-muted) — spiegato in un commento */',
    ].join('\n');
    const visti = mascheraCommentiCss(finto)
      .split('\n')
      .filter((r) => RE_COLOR_MUTED.test(r));
    expect(visti.length, `viste: ${JSON.stringify(visti)}`).toBe(2);
  });

  it('CONTROLLO POSITIVO: la sonda dei segnaposti vede gli usi veri e non i commenti', () => {
    const finto = [
      'const a = "placeholder-kidville-muted";',
      'const b = `p-2 placeholder:text-kidville-muted`;',
      '// era placeholder-kidville-muted, ora è sub',
      '/* placeholder-kidville-muted su bianco = 2,51:1 */',
    ].join('\n');
    expect((mascheraCommentiTs(finto).match(RE_PLACEHOLDER) ?? []).length).toBe(2);
    // E sul repo vero: la misura non è vuota. Una sonda cieca farebbe passare tutto.
    // Il debito è a ZERO dal 2026-09-04: tutti e 18 i segnaposti sono passati a
    // `hint` (#65716C, 5,08:1 sul bianco), il token nato apposta per il
    // suggerimento dentro un campo. L'asserzione si INVERTE e si irrigidisce:
    // prima passava con qualunque numero > 0, ora passa solo con 0.
    // Che la sonda non sia cieca lo prova la riga qui sopra sul sorgente finto,
    // più i due elenchi di file, che devono restare non vuoti.
    expect(TSX.length, 'nessun .ts/.tsx sotto src/: la sonda guarda altrove').toBeGreaterThan(0);
    expect(
      MISURA_SEGNAPOSTO,
      'un segnaposto è tornato a `muted`: la destinazione è `hint`, non `muted`',
    ).toEqual([]);
    expect(CSS.length, 'nessun file .css trovato sotto src/: la sonda guarda altrove').toBeGreaterThan(0);
  });

  // ── §4 — la forma del buco, dimostrata ─────────────────────────────────────
  it('la forma del BUCO: nessuna delle due scritture contiene la stringa cercata dal lock storico', () => {
    expect('color: var(--color-kidville-muted)').not.toContain(SONDA_STORICA);
    expect('placeholder-kidville-muted').not.toContain(SONDA_STORICA);
    // …e il lock storico guarda solo `.ts`/`.tsx`: un CSS module gli è invisibile
    // due volte, per estensione e per stringa.
    const storico = fs.readFileSync(
      path.join(RADICE, '__tests__/a11y/testo-muted-allowlist.test.ts'),
      'utf8',
    );
    expect(storico, 'il lock storico non cerca più quella stringa: rileggi questo file').toContain(
      `const TOKEN = '${SONDA_STORICA}'`,
    );
    expect(storico).toContain('/\\.tsx?$/');
  });

  // ── §1 — CSS: tolleranza zero ──────────────────────────────────────────────
  it('nessun file .css sotto src/ dipinge testo o glifi con `muted`', () => {
    const colpevoli = CSS.flatMap((f) => dichiarazioniColoreMuted(f).map((r) => `${f}:${r}`));
    expect(
      colpevoli,
      'Qui `--color-kidville-muted` sta dipingendo INCHIOSTRO: 2,51:1 su bianco, 2,27:1 su ' +
        'crema, contro i 4,5:1 di WCAG 1.4.3 AA (e i 3:1 di 1.4.11 per un glifo, che nemmeno ' +
        'raggiunge). Usa `--color-kidville-sub` (#55615C). Le tre dichiarazioni che c’erano ' +
        'erano la didascalia dell’overlay di caricamento e il segnaposto della LOGIN: sono ' +
        'sopravvissute per due anni a un lock scritto apposta, perché quel lock guardava solo ' +
        'i .ts/.tsx. Questo elenco parte vuoto e vuoto deve restare.',
    ).toEqual([]);
  });

  // ── §2 — segnaposti: inventario congelato ──────────────────────────────────
  it('nessun file FUORI dall’inventario dipinge il segnaposto con `muted`', () => {
    const noti = new Set(SEGNAPOSTO_NOTI.map((v) => v.path));
    const nuovi = MISURA_SEGNAPOSTO.filter((v) => !noti.has(v.path)).map((v) => `${v.path} (${v.n})`);
    expect(
      nuovi,
      'Segnaposto dipinto con `muted` (2,51:1 su bianco). Non aggiungere il file all’inventario ' +
        '— può solo accorciarsi: usa `placeholder-kidville-sub`. Un segnaposto è testo a tutti ' +
        'gli effetti, e spesso è l’unica istruzione che il campo dà.',
    ).toEqual([]);
  });

  it('nei file dell’inventario il numero può solo SCENDERE, e i file devono esistere', () => {
    const cresciuti: string[] = [];
    for (const v of SEGNAPOSTO_NOTI) {
      expect(fs.existsSync(path.join(RADICE, v.path)), `file sparito: ${v.path} — togli la voce`).toBe(true);
      const n = quantiSegnaposto(v.path);
      if (n > v.n) cresciuti.push(`${v.path}: dichiarati ${v.n}, misurati ${n}`);
    }
    expect(cresciuti, 'Il debito si smaltisce, non si rifinanzia.').toEqual([]);
  });

  it('i tetti scendono e non risalgono', () => {
    const occorrenze = MISURA_SEGNAPOSTO.reduce((s, v) => s + v.n, 0);
    expect(MISURA_SEGNAPOSTO.length).toBeLessThanOrEqual(TETTO_SEGNAPOSTO_FILE);
    expect(occorrenze, `occorrenze: ${occorrenze} (tetto ${TETTO_SEGNAPOSTO_OCCORRENZE})`).toBeLessThanOrEqual(
      TETTO_SEGNAPOSTO_OCCORRENZE,
    );
    expect(SEGNAPOSTO_NOTI.length).toBeLessThanOrEqual(TETTO_SEGNAPOSTO_FILE);
  });

  /**
   * ALTO CONTRASTO: perché NON è la risposta a niente di tutto questo.
   *
   * Verificato, perché è la prima obiezione che viene in mente («tanto c'è l'Alto
   * Contrasto»): in `[data-contrast="high"]` il token `--color-kidville-muted` viene
   * rimappato a #E0E0E0 su fondo nero — ma quella rimappatura raggiunge SOLO chi legge
   * il token con `var()`, cioè i CSS module. Le utility Tailwind (`text-kidville-muted`,
   * `placeholder-kidville-muted`) nascono da `@theme inline`, che INLINA l'hex dentro la
   * classe: restano #9AA6A2 anche con l'Alto Contrasto acceso. È il motivo per cui
   * `globals.css` è pieno di regole `[data-contrast="high"] .kv-… .text-kidville-muted`
   * scritte a mano, una superficie alla volta. Il fatto già misurato altrove
   * (`contrasto-cascata.test.tsx`, «l'utility inlinata resta chiara con l'HC attivo»)
   * viene qui asserito sulla FONTE: se un giorno si passasse a `@theme` senza `inline`,
   * questa riga diventerebbe rossa e la nota andrebbe riscritta da capo.
   */
  it('l’Alto Contrasto NON protegge le utility: `@theme inline` inlina l’hex', () => {
    const css = fs.readFileSync(path.join(RADICE, 'src/app/globals.css'), 'utf8');
    expect(css).toContain('@theme inline');
    // La rimappatura in HC esiste, e serve ai CSS module — ma il token da
    // guardare è `sub`, non `muted`. Fino al 2026-09-04 questa riga asseriva
    // `--color-kidville-muted: #E0E0E0`, che era una DICHIARAZIONE INERTE:
    // `var(--color-kidville-muted)` non esiste in src/, quindi quella riga non
    // ribaltava niente e il test citava una prova morta. `sub` invece è letto da
    // tre file, ed è verificato qui sotto — altrimenti sarebbe inerte pure lui.
    const hc = css.slice(css.indexOf('[data-contrast="high"]'));
    expect(hc).toMatch(/--color-kidville-sub\s*:\s*#E0E0E0/i);
    expect(
      hc.split('\n').some((r) => /^\s*--color-kidville-muted\s*:/.test(r)),
      '`muted` è tornato nel blocco HC: o qualcuno ha aggiunto un `var()` che lo legge, e allora va bene, oppure è di nuovo una riga che mente',
    ).toBe(false);
    const lettoriSub = ['src/app/auth/login/page.module.css', 'src/components/ui/PageLoader.module.css']
      .map((f) => fs.readFileSync(path.join(RADICE, f), 'utf8'))
      .filter((t) => t.includes('var(--color-kidville-sub'));
    expect(
      lettoriSub.length,
      'nessun CSS module legge `sub`: allora anche QUESTA ridefinizione è inerte, come lo era quella di `muted`',
    ).toBeGreaterThan(0);
    // …ma non basta: restano le regole scritte a mano, superficie per superficie.
    expect(
      (css.match(/\[data-contrast="high"\][^{]*\.text-kidville-muted/g) ?? []).length,
      'sparite le regole HC scritte a mano per `text-kidville-muted`: o le utility hanno ' +
        'smesso di essere inlinate, o qualcuno ha tolto il rimedio senza togliere il difetto',
    ).toBeGreaterThan(0);
  });
});
