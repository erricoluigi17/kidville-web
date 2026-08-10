import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { mascheraSorgente, fileSorgente, riga } from '../fixtures/sorgente';

/**
 * LOCK DI FORMA — la tabella dei comuni NON deve finire nel bundle del browser.
 *
 * ─── IL FATTO ────────────────────────────────────────────────────────────────────
 * `src/lib/fiscale/dati/comuni-belfiore.ts` sono ~294 KB di testo: 13.656 righe fra
 * comuni italiani e stati esteri. Al browser non serve NIENTE di tutto questo. Per
 * comporre un codice fiscale serve il codice Belfiore — quattro caratteri — e quei
 * quattro caratteri glieli consegna una tendina, cioè un elenco già ridotto alla
 * provincia che l'utente ha scelto. Il dataset intero lo legge una sola cosa: una
 * route API, sul server, dove sta in memoria una volta per istanza.
 *
 * ─── PERCHÉ SERVE UN LOCK, INVECE DI RICORDARSELO ────────────────────────────────
 * Perché nessun errore si accende. Un `import { comuniDiProvincia } from
 * '@/lib/fiscale/comuni'` dentro un componente `'use client'` compila, passa i test,
 * passa il build, e la pagina funziona: l'unica cosa che cambia è che ogni famiglia
 * che apre il modulo d'iscrizione scarica 294 KB in più, dalla rete mobile, per
 * usarne quattro caratteri. È la definizione di guasto invisibile — e in questo repo
 * l'invisibile è già costato mesi (le email che rispondevano 403 e nessuno lo sapeva).
 *
 * ─── E SI GUARDA LA CATENA, NON SOLO L'IMPORT DIRETTO ────────────────────────────
 * Il bundler non si ferma al primo salto: un file client che importa un helper che
 * importa il dataset se lo porta dietro lo stesso. Quindi qui non si cerca «un file
 * `'use client'` che nomina il dataset»: si costruisce il GRAFO degli import dentro
 * `src/` e si chiude transitivamente a partire da tutti i file client. Quando è
 * rosso, il test stampa la catena intera — che è l'unica cosa utile da leggere.
 *
 * ─── SECONDA REGOLA: `codice-fiscale-js` non si importa da `src/` ────────────────
 * È il pacchetto da cui il dataset è STATO GENERATO, e porta con sé la stessa tabella
 * (il suo `dist` pesa 425 KB). Importarlo significa rimettere nel bundle esattamente
 * ciò che questo lock toglie, passando da un'altra porta. C'è UNA deroga, misurata e
 * scritta qui sotto: non è un'assoluzione, è un debito che si vede.
 *
 * E la porta è larga quanto il pacchetto, non quanto il suo nome: `codice-fiscale-js`
 * espone i suoi sorgenti, e `codice-fiscale-js/src/lista-comuni` È LA TABELLA — è
 * esattamente il file che `scripts/genera-comuni.mjs:41` legge per generare il dataset,
 * quindi è il primo posto dove andrebbe a guardare chiunque la voglia. Un confronto per
 * uguaglianza esatta sullo specificatore lascerebbe passare quell'import senza dire
 * niente, e nemmeno la prima regola lo intercetterebbe: il grafo segue solo i file
 * dentro `src/`, e `node_modules` non ne fa parte. Perciò qui si combaciano ANCHE i
 * sottopercorsi (`codice-fiscale-js/...`), e il collaudo in fondo al file lo fissa.
 */

const RADICE = process.cwd();
const SRC = path.join(RADICE, 'src');

/** I moduli che il browser non deve poter raggiungere, in nessun modo. */
const VIETATI_AL_CLIENT = ['src/lib/fiscale/comuni.ts', 'src/lib/fiscale/dati/'];

/**
 * La sola deroga al divieto di importare `codice-fiscale-js`, con la sua ragione.
 *
 * `src/lib/utils/fiscalCodeApi.ts` lo carica con un `await import()` come RIPIEGO
 * locale quando il servizio esterno di calcolo non risponde — ed è un ripiego che
 * fa bene il suo lavoro: calcola lo stesso codice senza far uscire dal dispositivo
 * il nome e la data di nascita di un bambino. Quel file è precedente a questo lock e
 * sta fuori dal perimetro di chi l'ha scritto.
 *
 * Resta un DEBITO, e va detto per intero: quell'`import()` mette 425 KB (il `dist` di
 * `codice-fiscale-js`) in un chunk del browser, e dentro quei 425 KB c'è la stessa
 * tabella comuni che questo lock tiene fuori dalla porta principale. La via d'uscita
 * esiste già ed è la route API che legge `@/lib/fiscale/comuni`: quando il ripiego
 * passerà da lì, questa voce va TOLTA — e il test qui sotto lo pretende, perché una
 * deroga che non serve più fa fallire il lock invece di restare per sempre.
 */
const DEROGHE_CODICE_FISCALE_JS: Record<string, string> = {
  'src/lib/utils/fiscalCodeApi.ts':
    'Ripiego locale al servizio esterno di calcolo del CF: precedente a questo lock. ' +
    'Costa 425 KB in un chunk del browser. Da sostituire con la route API che legge ' +
    '@/lib/fiscale/comuni, e allora questa voce va tolta.',
};

interface Modulo {
  /** Percorso relativo alla radice del repo, con `/` (stabile fra macchine). */
  rel: string;
  client: boolean;
  /** Specificatori grezzi di import/export-from/import() presenti nel file. */
  specificatori: { testo: string; riga: number }[];
  /** Archi risolti verso altri file di `src/`. */
  archi: string[];
}

/**
 * Ogni forma con cui un modulo ne tira dentro un altro:
 *   import … from 'x' · export … from 'x' · import 'x' · import('x') · require('x')
 * Si legge sul sorgente MASCHERATO (commenti spenti, stringhe leggibili): senza,
 * `import('codice-fiscale-js')` citato dentro un commento — e in questo repo i
 * commenti citano il codice di continuo — varrebbe come un import vero.
 */
const SPECIFICATORE =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g;

function rel(assoluto: string): string {
  return path.relative(RADICE, assoluto).split(path.sep).join('/');
}

/** Risolve uno specificatore in un file di `src/`, o `null` se punta altrove. */
function risolvi(daFile: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = path.join(SRC, spec.slice(2));
  else if (spec.startsWith('./') || spec.startsWith('../'))
    base = path.resolve(path.dirname(path.join(RADICE, daFile)), spec);
  else return null; // pacchetto npm, `node:*`, css, alias sconosciuti

  for (const tentativo of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
  ]) {
    if (fs.existsSync(tentativo) && fs.statSync(tentativo).isFile()) return rel(tentativo);
  }
  return null;
}

function leggiGrafo(): Map<string, Modulo> {
  const grafo = new Map<string, Modulo>();
  for (const assoluto of fileSorgente(SRC)) {
    const originale = fs.readFileSync(assoluto, 'utf8');
    const { senzaCommenti } = mascheraSorgente(originale);
    const relativo = rel(assoluto);

    const specificatori: Modulo['specificatori'] = [];
    SPECIFICATORE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = SPECIFICATORE.exec(senzaCommenti)) !== null) {
      specificatori.push({ testo: m[1], riga: riga(originale, m.index) });
    }

    grafo.set(relativo, {
      rel: relativo,
      // La direttiva è valida solo in testa al file, prima di qualunque istruzione.
      client: /^\s*(?:\/\*[\s\S]*?\*\/\s*|\/\/[^\n]*\n\s*)*['"]use client['"]/.test(originale),
      specificatori,
      archi: [],
    });
  }
  for (const modulo of grafo.values()) {
    for (const s of modulo.specificatori) {
      const bersaglio = risolvi(modulo.rel, s.testo);
      if (bersaglio !== null && grafo.has(bersaglio)) modulo.archi.push(bersaglio);
    }
  }
  return grafo;
}

/**
 * Chiusura transitiva: da ogni radice, tutti i moduli raggiungibili, tenendo per
 * ciascuno il PERCORSO con cui ci si è arrivati. Il percorso è il motivo per cui
 * questa funzione non restituisce un semplice `Set`: quando il lock è rosso, sapere
 * *quale* componente client tira dentro il dataset, e attraverso quali passaggi, è
 * la differenza fra una correzione di due minuti e mezza giornata di ricerca.
 */
export function raggiungibili(
  archi: ReadonlyMap<string, readonly string[]>,
  radici: readonly string[],
): Map<string, string[]> {
  const visti = new Map<string, string[]>();
  const coda: string[][] = [];
  for (const r of radici) {
    if (visti.has(r)) continue;
    visti.set(r, [r]);
    coda.push([r]);
  }
  while (coda.length > 0) {
    const percorso = coda.shift() as string[];
    for (const vicino of archi.get(percorso[percorso.length - 1]) ?? []) {
      if (visti.has(vicino)) continue;
      const nuovo = [...percorso, vicino];
      visti.set(vicino, nuovo);
      coda.push(nuovo);
    }
  }
  return visti;
}

const GRAFO = leggiGrafo();
const ARCHI = new Map([...GRAFO.values()].map((m) => [m.rel, m.archi]));
const CLIENT = [...GRAFO.values()].filter((m) => m.client).map((m) => m.rel);
const DAI_CLIENT = raggiungibili(ARCHI, CLIENT);

describe('il dataset dei comuni non entra nel bundle del browser', () => {
  /**
   * Un lock che punta a file inesistenti è VERDE e non serve a niente: è il modo più
   * comune in cui una protezione muore, perché nessuno se ne accorge. Qui si verifica
   * che i bersagli esistano davvero, e che il grafo sia stato costruito sul serio.
   */
  it('i bersagli esistono e il grafo è stato letto davvero', () => {
    expect(fs.existsSync(path.join(RADICE, 'src/lib/fiscale/comuni.ts'))).toBe(true);
    expect(fs.existsSync(path.join(RADICE, 'src/lib/fiscale/dati/comuni-belfiore.ts'))).toBe(true);
    expect(GRAFO.size).toBeGreaterThan(500);
    expect(CLIENT.length).toBeGreaterThan(100);
    // Il grafo ha archi veri: se la risoluzione degli import si rompesse, questo
    // test resterebbe l'unico rosso invece di lasciare passare un lock cieco.
    expect([...ARCHI.values()].reduce((n, a) => n + a.length, 0)).toBeGreaterThan(500);
    expect(DAI_CLIENT.size).toBeGreaterThan(CLIENT.length);
  });

  it("nessun file 'use client' raggiunge @/lib/fiscale/comuni o @/lib/fiscale/dati/**", () => {
    const colpevoli: string[] = [];
    for (const [modulo, percorso] of DAI_CLIENT) {
      if (!VIETATI_AL_CLIENT.some((v) => modulo === v || modulo.startsWith(v))) continue;
      colpevoli.push(`${modulo}  ←  ${percorso.join(' → ')}`);
    }
    expect(colpevoli).toEqual([]);
  });

  /**
   * Il caso simmetrico e più subdolo: `comuni.ts` che tira dentro un modulo `'use
   * client'`. Non gonfia il browser, ma incrocia i due mondi e finisce per trascinare
   * il dataset dalla parte sbagliata al primo refactor. Il dataset deve dipendere solo
   * da moduli neutri (oggi: `@/lib/anagrafiche/province`, che non è client).
   */
  it('comuni.ts e il dataset non dipendono da nessun modulo client', () => {
    const dalDataset = raggiungibili(ARCHI, [
      'src/lib/fiscale/comuni.ts',
      'src/lib/fiscale/dati/comuni-belfiore.ts',
    ]);
    const client = [...dalDataset.keys()].filter((m) => GRAFO.get(m)?.client);
    expect(client).toEqual([]);
  });
});

/**
 * Vero per il pacchetto E per ogni suo sottopercorso. Il caso che conta non è
 * `import 'codice-fiscale-js'` — quello lo si vede a occhio in una revisione — ma
 * `import { lista } from 'codice-fiscale-js/src/lista-comuni'`, che porta dentro la
 * tabella comuni NUDA e sembra innocuo proprio perché non nomina il bundle.
 *
 * Il prefisso si controlla con lo slash (`codice-fiscale-js/`) e non con un semplice
 * `startsWith('codice-fiscale-js')`: senza slash un ipotetico pacchetto vicino di nome
 * `codice-fiscale-js-utils` verrebbe accusato di una colpa che non ha.
 */
export function eCodiceFiscaleJs(specificatore: string): boolean {
  return specificatore === 'codice-fiscale-js' || specificatore.startsWith('codice-fiscale-js/');
}

describe('`codice-fiscale-js` non si importa da src/', () => {
  const importatori = [...GRAFO.values()]
    .filter((m) => m.specificatori.some((s) => eCodiceFiscaleJs(s.testo)))
    .map((m) => ({
      rel: m.rel,
      righe: m.specificatori
        .filter((s) => eCodiceFiscaleJs(s.testo))
        .map((s) => `${s.riga}:${s.testo}`),
    }));

  it('nessun import nuovo: il pacchetto porta con sé la stessa tabella, ma da un altro ingresso', () => {
    const nuovi = importatori
      .filter((i) => !(i.rel in DEROGHE_CODICE_FISCALE_JS))
      .map((i) => `${i.rel}:${i.righe.join(',')}`);
    expect(nuovi).toEqual([]);
  });

  /**
   * Le deroghe si CONTANO. Una che non serve più — perché il file è stato corretto o
   * cancellato — deve far fallire il lock: è l'unico modo perché l'elenco si accorci
   * invece di diventare arredamento.
   */
  /**
   * Il riconoscitore si collauda a parte, perché è il punto in cui questo lock è già
   * stato verde per il motivo sbagliato: con l'uguaglianza esatta,
   * `codice-fiscale-js/src/lista-comuni` — cioè la tabella comuni nuda, lo stesso file
   * che lo script legge per generare il dataset — passava senza un rilievo, e i sette
   * test restavano verdi. MISURATO: file di sonda in `src/lib/` con quell'import,
   * 7/7 PASSED prima della correzione.
   */
  it('riconosce anche i sottopercorsi, non solo il nome nudo del pacchetto', () => {
    expect(eCodiceFiscaleJs('codice-fiscale-js')).toBe(true);
    expect(eCodiceFiscaleJs('codice-fiscale-js/src/lista-comuni')).toBe(true);
    expect(eCodiceFiscaleJs('codice-fiscale-js/dist/codice.fiscale.commonjs2.js')).toBe(true);
    // Un pacchetto diverso il cui nome comincia allo stesso modo non è questo pacchetto.
    expect(eCodiceFiscaleJs('codice-fiscale-js-utils')).toBe(false);
    expect(eCodiceFiscaleJs('@/lib/fiscale/comuni')).toBe(false);
    expect(eCodiceFiscaleJs('codice-fiscale')).toBe(false);
  });

  it('ogni deroga dichiarata è ancora vera (una che non serve più va tolta)', () => {
    const dichiarate = Object.keys(DEROGHE_CODICE_FISCALE_JS).sort();
    const effettive = importatori.map((i) => i.rel).sort();
    expect(effettive).toEqual(dichiarate);
    expect(dichiarate.length).toBe(1);
    for (const [file, ragione] of Object.entries(DEROGHE_CODICE_FISCALE_JS)) {
      expect(fs.existsSync(path.join(RADICE, file))).toBe(true);
      expect(ragione.length).toBeGreaterThan(60);
    }
  });
});

/**
 * ─── IL LOCK SI COLLAUDA DA SOLO ─────────────────────────────────────────────────
 * Oggi nessun file client raggiunge il dataset, quindi i test qui sopra passerebbero
 * anche se la chiusura transitiva fosse rotta e non guardasse niente. Un lock verde
 * per il motivo sbagliato è peggio di nessun lock. Qui la stessa funzione usata sul
 * repo vero viene messa alla prova su un grafo FINTO in cui il guasto c'è: se smette
 * di vederlo, questo test diventa rosso.
 */
describe('la chiusura transitiva vede davvero le catene lunghe', () => {
  const FINTO = new Map<string, string[]>([
    ['src/app/form.tsx', ['src/lib/helper.ts']], // client
    ['src/lib/helper.ts', ['src/lib/fiscale/comuni.ts']], // innocuo di suo
    ['src/lib/fiscale/comuni.ts', ['src/lib/fiscale/dati/comuni-belfiore.ts']],
    ['src/lib/fiscale/dati/comuni-belfiore.ts', []],
    ['src/app/altro.tsx', []],
  ]);

  it('trova il dataset a due salti di distanza e ne ricostruisce la catena', () => {
    const visti = raggiungibili(FINTO, ['src/app/form.tsx']);
    expect(visti.has('src/lib/fiscale/comuni.ts')).toBe(true);
    expect(visti.get('src/lib/fiscale/dati/comuni-belfiore.ts')).toEqual([
      'src/app/form.tsx',
      'src/lib/helper.ts',
      'src/lib/fiscale/comuni.ts',
      'src/lib/fiscale/dati/comuni-belfiore.ts',
    ]);
  });

  it('non inventa raggiungibilità che non ci sono, e regge i cicli', () => {
    expect(raggiungibili(FINTO, ['src/app/altro.tsx']).size).toBe(1);
    const ciclico = new Map<string, string[]>([
      ['a', ['b']],
      ['b', ['a', 'c']],
      ['c', ['b']],
    ]);
    expect([...raggiungibili(ciclico, ['a']).keys()].sort()).toEqual(['a', 'b', 'c']);
  });
});
