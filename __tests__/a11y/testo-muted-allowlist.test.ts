import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Lock su `text-kidville-muted` — il grigio che non è un inchiostro.
 *
 * LA STORIA. `--color-kidville-muted` (#9AA6A2) vale 2,51:1 su bianco e 2,27:1 su crema,
 * contro i 4,5:1 di WCAG AA. Il repo lo sapeva già: `__tests__/a11y/contrasto-token.test.ts`
 * lo misura e lo asserisce come CONTROLLO POSITIVO («è il difetto»). Nello stesso ciclo sono
 * state sostituite 85 occorrenze con `text-kidville-sub` (#55615C, 6,46:1).
 *
 * IL DIFETTO NON ERA LA SOSTITUZIONE: ERA LA LISTA. Quel lock vieta il token in SEI file
 * elencati a mano (`FILE_S16`). Fuori da quei sei, `text-kidville-muted` restava il modo in
 * cui in questo repo si dice «testo secondario» — e il ciclo successivo lo ha riscritto su
 * righe NUOVE, fra cui la colonna «Sede» dell'anagrafica: cioè proprio il dato su cui ruota
 * tutto il lavoro multi-sede, dipinto col grigio meno leggibile della tabella. Una regola che
 * vale su una lista chiusa non è una regola: è un elenco di file già corretti.
 *
 * COSA FA QUESTO FILE. Sposta la regola da «questi sei file» a «tutti i file», e mette il
 * debito residuo in un'ALLOWLIST ESPLICITA (`docs/superpowers/testo-muted-allowlist.json`,
 * 179 file / 1184 occorrenze misurate il 2026-08-02). Da qui in poi:
 *   · un file NUOVO che usa il token è rosso subito — non c'è nessuna lista da aggiornare,
 *     c'è `text-kidville-sub`;
 *   · un file dell'allowlist che ne aggiunge una è rosso — il numero può solo scendere;
 *   · i tetti qui sotto scendono con la bonifica e non risalgono mai.
 *
 * PERCHÉ NESSUNA ESENZIONE PERMANENTE. `text-*` è per costruzione il colore dell'INCHIOSTRO
 * (testo o glifo di un'icona): non esiste l'uso «decorativo» che salvi il criterio, perché il
 * token è sotto soglia su tutte e tre le superfici chiare del tema — bianco, crema e linea.
 * L'allowlist non è una deroga motivata: è debito misurato, e come tale si smaltisce.
 *
 * PERCHÉ SOLO `.ts`/`.tsx`. In `globals.css` la stringa `.text-kidville-muted` compare nelle
 * regole di ALTO CONTRASTO, che sono il rimedio (`color: #000`), non l'uso. Contarle vorrebbe
 * dire chiedere di cancellare proprio le righe che correggono il difetto.
 */

const RADICE = process.cwd();
const SRC = path.join(RADICE, 'src');
const ALLOWLIST = path.join(RADICE, 'docs/superpowers/testo-muted-allowlist.json');
const TOKEN = 'text-kidville-muted';

/**
 * TETTI MONOTONI DECRESCENTI — la misura del 2026-08-02, dopo la bonifica dell'anagrafica.
 * Si abbassano quando si bonifica, non si alzano mai. Chi si trova a doverli ALZARE sta
 * scrivendo testo a 2,51:1 su dati di famiglie e bambini, ed è quello il momento di fermarsi.
 */
const TETTO_FILE = 179;
const TETTO_OCCORRENZE = 1184;

/**
 * Bonificati in questo ciclo, e non possono rientrare: sono le due viste dell'anagrafica —
 * la tabella e la sua gemella mobile — dove il token dipingeva il nome della SEDE, cioè
 * l'unica cosa che distingue due bambini omonimi di due plessi diversi.
 */
const MAI_PIU_IN_ALLOWLIST = [
  'src/components/features/admin/StudentTable.tsx',
  'src/components/features/admin/StudentRowCard.tsx',
];

// ── WCAG 2.x §1.4.3 — il rapporto di contrasto, ricalcolato qui ──────────────
// La stessa matematica sta in `contrasto-token.test.ts`, che la esporta: importarla da lì
// significherebbe però eseguire i `describe` di quel file dentro questo, e vedere i suoi test
// contati due volte. Sono nove righe di aritmetica pura, senza stato: la copia costa meno
// dell'accoppiamento.
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

/** Il valore dichiarato di un token in `@theme inline`. */
function tokenTema(nome: string): string {
  const css = fs.readFileSync(path.join(RADICE, 'src/app/globals.css'), 'utf8');
  const blocco = css.slice(css.indexOf('@theme inline'));
  const m = blocco.match(new RegExp(`--color-kidville-${nome}\\s*:\\s*(#[0-9A-Fa-f]{6})`));
  expect(m, `token --color-kidville-${nome} non trovato in globals.css`).toBeTruthy();
  return m![1].toUpperCase();
}

/**
 * Sostituisce i commenti con spazi lasciando INTATTE le stringhe. Un commento che *cita* il
 * token — e questo ciclo ne ha scritti parecchi, a spiegare perché è stato tolto — è
 * documentazione, non un uso: contarlo renderebbe il lock rosso proprio dove qualcuno ha
 * fatto la cosa giusta e l'ha anche spiegata.
 */
function mascheraCommenti(sorgente: string): string {
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
    // stato === 'str'
    if (c === '\\') { out += c + (d ?? ''); i += 2; continue; }
    if (c === apice) stato = 'code';
    out += c; i++;
  }
  return out;
}

function sorgenti(dir = SRC): string[] {
  const out: string[] = [];
  for (const voce of fs.readdirSync(dir, { withFileTypes: true })) {
    const assoluto = path.join(dir, voce.name);
    if (voce.isDirectory()) { out.push(...sorgenti(assoluto)); continue; }
    if (!/\.tsx?$/.test(voce.name)) continue;
    out.push(path.relative(RADICE, assoluto).split(path.sep).join('/'));
  }
  return out;
}

/** Quante volte quel file usa il token come inchiostro. `0` significa bonificato. */
function quanteVolte(rel: string): number {
  const sorgente = mascheraCommenti(fs.readFileSync(path.join(RADICE, rel), 'utf8'));
  return (sorgente.match(new RegExp(TOKEN, 'g')) ?? []).length;
}

type Voce = { path: string; n: number };
type Allowlist = { misurato_il: string; totale_file: number; totale_occorrenze: number; file: Voce[] };

const leggiAllowlist = (): Allowlist => JSON.parse(fs.readFileSync(ALLOWLIST, 'utf8')) as Allowlist;

/** La misura vera, su disco, adesso. */
const MISURA = sorgenti()
  .map((f) => ({ path: f, n: quanteVolte(f) }))
  .filter((v) => v.n > 0);

describe('lock — `text-kidville-muted` non è un inchiostro (WCAG 1.4.3)', () => {
  it('CONTROLLO POSITIVO: il token è misurato SOTTO AA, e `sub` sopra', () => {
    // Se un giorno qualcuno scurisse `muted`, questa riga diventerebbe rossa e l'intero lock
    // andrebbe riletto: senza il difetto misurato, la regola sarebbe solo un gusto.
    expect(contrasto(tokenTema('muted'), tokenTema('white'))).toBeLessThan(4.5);
    expect(contrasto(tokenTema('muted'), tokenTema('cream'))).toBeLessThan(4.5);
    expect(contrasto(tokenTema('sub'), tokenTema('white'))).toBeGreaterThanOrEqual(4.5);
    expect(contrasto(tokenTema('sub'), tokenTema('cream'))).toBeGreaterThanOrEqual(4.5);
  });

  it('CONTROLLO POSITIVO: la sonda vede gli usi veri e ignora quelli citati nei commenti', () => {
    const finto = [
      'const a = "text-kidville-muted";',
      '// era text-kidville-muted, ora è sub',
      '/* text-kidville-muted su bianco = 2,51:1 */',
      'const b = `p-2 text-kidville-muted`;',
    ].join('\n');
    expect((mascheraCommenti(finto).match(new RegExp(TOKEN, 'g')) ?? []).length).toBe(2);

    // E, sul repo vero: la misura non è vuota. Una sonda cieca farebbe passare tutto.
    expect(MISURA.length, 'la sonda non trova NESSUN uso: sta guardando altrove').toBeGreaterThan(0);
  });

  it('l’allowlist esiste, è ben formata e non ha doppioni', () => {
    expect(
      fs.existsSync(ALLOWLIST),
      'Manca docs/superpowers/testo-muted-allowlist.json: è l’elenco del debito residuo, ' +
        'senza il quale questo lock non sa distinguere il vecchio dal nuovo.',
    ).toBe(true);

    const a = leggiAllowlist();
    expect(Array.isArray(a.file)).toBe(true);
    for (const v of a.file) {
      expect(typeof v.path, `voce senza path: ${JSON.stringify(v)}`).toBe('string');
      expect(v.path.startsWith('src/'), `path fuori da src/: ${v.path}`).toBe(true);
      expect(Number.isInteger(v.n) && v.n > 0, `voce con n non valido: ${v.path}`).toBe(true);
      expect(fs.existsSync(path.join(RADICE, v.path)), `file sparito: ${v.path} — togli la voce`).toBe(true);
    }
    const doppi = a.file.map((v) => v.path).filter((p, i, arr) => arr.indexOf(p) !== i);
    expect(doppi, 'stesso file due volte: il conteggio non sarebbe più leggibile').toEqual([]);
    expect(a.totale_file, 'totale_file non combacia con le voci').toBe(a.file.length);
    expect(a.totale_occorrenze, 'totale_occorrenze non combacia con la somma').toBe(
      a.file.reduce((s, v) => s + v.n, 0),
    );
  });

  it('nessun file FUORI dall’allowlist dipinge testo con `muted`', () => {
    const noti = new Set(leggiAllowlist().file.map((v) => v.path));
    const nuovi = MISURA.filter((v) => !noti.has(v.path)).map((v) => `${v.path} (${v.n})`);

    expect(
      nuovi,
      'Testo dipinto con `text-kidville-muted`: 2,51:1 su bianco, contro i 4,5:1 di WCAG AA. ' +
        'Non aggiungere il file all’allowlist — l’allowlist può solo accorciarsi. Usa ' +
        '`text-kidville-sub` (#55615C, 6,46:1), che è il token del testo secondario. Questo è ' +
        'esattamente il difetto che, nel ciclo precedente, ha reso il NOME DELLA SEDE la ' +
        'colonna meno leggibile dell’anagrafica: la regola c’era, ma valeva su sei file.',
    ).toEqual([]);
  });

  it('nei file dell’allowlist il numero può solo SCENDERE', () => {
    const cresciuti: string[] = [];
    for (const v of leggiAllowlist().file) {
      if (!fs.existsSync(path.join(RADICE, v.path))) continue; // già segnalato dal test sulla forma
      const n = quanteVolte(v.path);
      if (n > v.n) cresciuti.push(`${v.path}: dichiarati ${v.n}, misurati ${n}`);
    }
    expect(
      cresciuti,
      'In questi file gli usi di `muted` sono AUMENTATI. Il debito si smaltisce, non si ' +
        'rifinanzia: la riga nuova va scritta con `text-kidville-sub`.',
    ).toEqual([]);
  });

  it('i tetti scendono e non risalgono', () => {
    const occorrenze = MISURA.reduce((s, v) => s + v.n, 0);
    expect(
      MISURA.length,
      `File che usano il token: ${MISURA.length} (tetto ${TETTO_FILE}). Alzare il tetto non è ` +
        'la risposta: è la mossa che ha lasciato il difetto arrivare a 1192 occorrenze.',
    ).toBeLessThanOrEqual(TETTO_FILE);
    expect(
      occorrenze,
      `Occorrenze totali: ${occorrenze} (tetto ${TETTO_OCCORRENZE}).`,
    ).toBeLessThanOrEqual(TETTO_OCCORRENZE);
    expect(leggiAllowlist().file.length, 'l’allowlist è più lunga del tetto').toBeLessThanOrEqual(TETTO_FILE);
  });

  it('l’anagrafica bonificata non rientra in allowlist', () => {
    const noti = new Set(leggiAllowlist().file.map((v) => v.path));
    expect(
      MAI_PIU_IN_ALLOWLIST.filter((p) => noti.has(p)),
      'La tabella alunni e la sua card mobile sono state bonificate apposta: è lì che il ' +
        'token dipingeva il nome del plesso.',
    ).toEqual([]);

    // Controllo POSITIVO accanto a quello negativo: i due file esistono e sono puliti davvero.
    for (const p of MAI_PIU_IN_ALLOWLIST) {
      expect(fs.existsSync(path.join(RADICE, p)), `sparito: ${p}`).toBe(true);
      expect(quanteVolte(p), `\`muted\` è tornato in ${p}`).toBe(0);
    }
  });
});
