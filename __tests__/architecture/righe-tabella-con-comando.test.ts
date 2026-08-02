import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Lock — una riga di tabella che apre un dettaglio col MOUSE deve portare
 * dentro di sé un comando vero che fa la STESSA cosa da tastiera.
 *
 * LA STORIA. Nel registro dei protocolli il dettaglio di una registrazione si
 * apriva da `<tr onClick>` e da nient'altro: nessun `role`, nessun `tabIndex`,
 * nessun `onKeyDown`. La riga non è un tab stop e non risponde a Invio/Spazio,
 * quindi da tastiera quel dettaglio — dove si annulla una registrazione, si
 * verifica l'impronta, si rettificano i dati — non si apriva in nessun modo
 * (WCAG 2.1.1, livello A). L'unico controllo raggiungibile nella riga scaricava
 * il PDF timbrato: un bottone c'era, ma faceva un'altra cosa.
 *
 * PERCHÉ UN LOCK E NON TRE FIX. Le tabelle con questo schema in `src/` sono
 * tre, e finora la differenza fra quella accessibile e quelle no era CASUALE,
 * non progettata: in `/admin/avvisi` la riga si salva perché contiene per caso
 * un bottone «Apri»; nel registro dei protocolli e nel prospetto della primaria
 * quel bottone non c'era. È lo stesso difetto già chiuso a mano su
 * `StudentTable` nel ciclo precedente — e il difetto è tornato altrove, che è
 * la definizione di problema sistemico.
 *
 * LA REGOLA, UNA SOLA PER TUTTO IL REPO: il click sul `<tr>` resta la comodità
 * del mouse; l'accessibilità è un `<button>` (o un `<a href>`) dentro una cella
 * che invoca la STESSA azione. Non `role="button"` sul `<tr>`: una riga
 * trasformata in bottone prende come nome accessibile tutto il suo contenuto e
 * inghiotte i controlli che ci vivono dentro.
 *
 * COSA GUARDA. Per ogni `<tr …>` che ha un `onClick`: estrae il corpo
 * dell'handler (l'azione), e pretende che dentro la riga esista un `<button>` o
 * un `<a>` il cui `onClick` contenga quella stessa azione. Non basta «c'è un
 * bottone»: nel registro dei protocolli il bottone c'era già, e scaricava un PDF.
 *
 * LIMITE DICHIARATO. È un'analisi TESTUALE: se l'azione della riga fosse
 * incapsulata in due funzioni con nomi diversi (`apri(r)` sul `<tr>`,
 * `mostra(r)` sul bottone) il lock non le riconoscerebbe come la stessa cosa e
 * chiederebbe una riga in più nel debito dichiarato. Va bene così: preferiamo un
 * falso allarme, che si spegne leggendo il codice, a una riga muta in più.
 */

const RADICE = process.cwd();
const SRC = path.join(RADICE, 'src');

/**
 * DEBITO DICHIARATO — righe cliccabili ancora senza comando gemello.
 *
 * Non è un permesso: è un elenco che deve solo accorciarsi. Chi corregge uno di
 * questi file toglie la sua riga da qui.
 *
 * `teacher/primaria/[sectionId]/prospetto` — la riga della materia apre il
 * dettaglio delle valutazioni e non ha nessun controllo dentro. È lo stesso
 * difetto del registro protocolli, misurato dalla stessa scansione, ma sta
 * FUORI dal perimetro dell'intervento che ha scritto questo lock (altri agenti
 * stavano lavorando in parallelo sui file del docente): correggerlo qui avrebbe
 * sovrascritto il lavoro di qualcun altro. Segnalato nel report del ciclo.
 */
const DEBITO_DICHIARATO: Record<string, string> = {
  'app/(dashboard)/teacher/primaria/[sectionId]/prospetto/page.tsx':
    'riga «materia» del prospetto: apre il dettaglio solo col mouse — da chiudere col prossimo intervento sull\'area docente',
};

/** Quante righe mute il repo tollera. Solo verso il basso. */
const TETTO_DEBITO = 1;

function sorgentiTsx(dir = SRC): string[] {
  const out: string[] = [];
  for (const voce of fs.readdirSync(dir, { withFileTypes: true })) {
    const assoluto = path.join(dir, voce.name);
    if (voce.isDirectory()) { out.push(...sorgentiTsx(assoluto)); continue; }
    if (voce.name.endsWith('.tsx')) out.push(assoluto);
  }
  return out;
}

/**
 * Fine del tag JSX aperto in `da`: la prima `>` che sta FUORI da una graffa.
 * Serve perché dentro un tag vivono le frecce (`() => …`), e fermarsi alla prima
 * `>` troncherebbe il tag a metà handler.
 */
function fineTag(testo: string, da: number): number {
  let graffe = 0;
  for (let i = da; i < testo.length; i++) {
    const c = testo[i];
    if (c === '{') graffe++;
    else if (c === '}') graffe--;
    else if (c === '>' && graffe === 0) return i;
  }
  return -1;
}

/** Il valore di `attributo={…}` dentro `tag`, con le graffe bilanciate. */
function valoreProp(tag: string, attributo: string): string | null {
  const i = tag.indexOf(`${attributo}={`);
  if (i < 0) return null;
  const inizio = i + attributo.length + 1;
  let graffe = 0;
  for (let j = inizio; j < tag.length; j++) {
    if (tag[j] === '{') graffe++;
    else if (tag[j] === '}') { graffe--; if (graffe === 0) return tag.slice(inizio + 1, j); }
  }
  return null;
}

/**
 * L'AZIONE di un handler: quel che sta dopo l'ultima freccia, senza spazi.
 * `() => setDettaglioId(r.id)` → `setDettaglioId(r.id)`.
 */
function azione(handler: string): string {
  const pezzi = handler.split('=>');
  return pezzi[pezzi.length - 1].replace(/[\s;{}]/g, '');
}

/** Il nome del tag che porta l'`onClick` che comincia in `pos`. */
function tagDiAppartenenza(corpo: string, pos: number): string {
  const apertura = corpo.lastIndexOf('<', pos);
  if (apertura < 0) return '';
  return (corpo.slice(apertura + 1, apertura + 20).match(/^[A-Za-z][A-Za-z0-9]*/) ?? [''])[0].toLowerCase();
}

interface RigaCliccabile {
  file: string;      // percorso relativo a src/
  linea: number;
  azione: string;
  /** L'azione della riga è invocata anche da un `<button>`/`<a>` dentro la riga? */
  haComando: boolean;
}

function righeCliccabili(): RigaCliccabile[] {
  const trovate: RigaCliccabile[] = [];
  for (const assoluto of sorgentiTsx()) {
    const testo = fs.readFileSync(assoluto, 'utf8');
    const relativo = path.relative(SRC, assoluto);
    for (let i = testo.indexOf('<tr'); i >= 0; i = testo.indexOf('<tr', i + 1)) {
      // `<trascorso…` no: dopo `<tr` deve venire uno spazio o la chiusura.
      if (!/[\s>]/.test(testo[i + 3] ?? '')) continue;
      const fine = fineTag(testo, i);
      if (fine < 0) continue;
      const tag = testo.slice(i, fine + 1);
      const handler = valoreProp(tag, 'onClick');
      if (!handler) continue;

      const chiusura = testo.indexOf('</tr>', fine);
      const corpo = testo.slice(fine + 1, chiusura < 0 ? testo.length : chiusura);
      const bersaglio = azione(handler);

      let haComando = false;
      for (let j = corpo.indexOf('onClick={'); j >= 0; j = corpo.indexOf('onClick={', j + 1)) {
        const tagInterno = tagDiAppartenenza(corpo, j);
        if (tagInterno !== 'button' && tagInterno !== 'a') continue;
        const interno = valoreProp(corpo.slice(j), 'onClick') ?? '';
        if (interno.replace(/[\s;{}]/g, '').includes(bersaglio)) { haComando = true; break; }
      }

      trovate.push({
        file: relativo.split(path.sep).join('/'),
        linea: testo.slice(0, i).split('\n').length,
        azione: bersaglio,
        haComando,
      });
    }
  }
  return trovate;
}

describe('Lock · una riga di tabella cliccabile porta un comando raggiungibile da tastiera', () => {
  const righe = righeCliccabili();

  it('CONTROLLO POSITIVO: la scansione trova davvero le righe cliccabili di `src/`', () => {
    // Se questo numero andasse a zero, tutte le asserzioni sotto diventerebbero
    // vacue e il lock si spegnerebbe da solo senza dirlo a nessuno.
    expect(righe.length, 'nessun `<tr onClick>` trovato: la scansione non sta guardando niente').toBeGreaterThan(0);
    expect(righe.some((r) => r.file.includes('admin/protocolli')), 'la riga del registro protocolli non è più cliccabile: aggiorna il lock').toBe(true);
    // …e che sappia distinguere: la riga degli avvisi il comando ce l'ha già.
    expect(righe.filter((r) => r.file.includes('admin/avvisi')).every((r) => r.haComando)).toBe(true);
  });

  it('ogni riga cliccabile invoca la sua azione anche da un `<button>`/`<a>` interno', () => {
    const mute = righe
      .filter((r) => !r.haComando && !(r.file in DEBITO_DICHIARATO))
      .map((r) => `src/${r.file}:${r.linea} — «${r.azione}» si raggiunge solo col mouse`);
    expect(mute, 'riga di tabella apribile solo col mouse: WCAG 2.1.1 (A)').toEqual([]);
  });

  it('il debito dichiarato non cresce, e i suoi file esistono ancora', () => {
    const voci = Object.keys(DEBITO_DICHIARATO);
    expect(voci.length, 'il debito può solo accorciarsi').toBeLessThanOrEqual(TETTO_DEBITO);
    for (const voce of voci) {
      expect(fs.existsSync(path.join(SRC, voce)), `${voce} non esiste più: togli la voce dal debito`).toBe(true);
    }
  });
});
