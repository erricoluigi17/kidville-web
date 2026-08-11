#!/usr/bin/env node
/**
 * Genera `src/lib/fiscale/dati/comuni-belfiore.ts` — la tabella dei codici catastali
 * (Belfiore) dei comuni italiani e degli stati esteri.
 *
 *     node scripts/genera-comuni.mjs              # riscrive il file generato
 *     node scripts/genera-comuni.mjs --stdout     # stampa e basta (usato dal test)
 *     node scripts/genera-comuni.mjs --data=2026-08-10   # fissa la data «aggiornato»
 *
 * ─── PERCHÉ UNO SCRIPT, E PERCHÉ IL DATASET È COMMITTATO ────────────────────────────────
 * La tabella Belfiore non esiste nel repo: vive dentro `node_modules`, in
 * `codice-fiscale-js/src/lista-comuni.js`. Dipendere da `node_modules` a runtime
 * significherebbe che il contenuto del prodotto cambia quando cambia un lockfile, senza
 * che nessuna riga di diff lo mostri. Qui invece il dataset è un file committato: si vede
 * nel diff, si conta, si confronta fra due commit. Lo script si rilancia A MANO quando la
 * dipendenza viene aggiornata — NON è agganciato a `npm run build`, così una build non può
 * mai produrre un artefatto diverso da quello che è stato letto e collaudato.
 *
 * ─── PERCHÉ SI LEGGE LA FONTE COME TESTO, INVECE DI IMPORTARLA ─────────────────────────
 * `codice-fiscale-js/src/lista-comuni.js` usa `export const` ma il pacchetto non dichiara
 * `"type": "module"`: per Node quel file è CommonJS e l'import esplode. Il `main` del
 * pacchetto punta a un bundle webpack (`dist/codice.fiscale.commonjs2.js`), da cui la
 * tabella non è estraibile in modo stabile. Quindi si legge il sorgente come TESTO e se ne
 * fa il parsing con una regex sulla forma letterale `["A001","PD","ABANO TERME",1]`.
 * Il parsing è severo: se la fonte cambia forma, lo script si ferma invece di produrre un
 * file muto e sbagliato.
 *
 * ─── PERCHÉ UNA STRINGA SOLA, E NON UN ARRAY DI OGGETTI ────────────────────────────────
 * Il dataset ha ~13.656 righe. Scritto come `[{ belfiore: 'A001', … }, …]` sarebbe 13.656
 * oggetti letterali di cui TypeScript deve inferire il tipo a OGNI compilazione (`tsc`,
 * ogni `next build`, ogni salvataggio nell'editor): secondi di CPU regalati a un dato che
 * non cambia mai. Come singola stringa con tipo annotato è UN TOKEN: il compilatore non ci
 * pensa. L'indice vero lo costruisce `src/lib/fiscale/comuni.ts`, pigramente, al primo uso.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RADICE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FONTE_JS = path.join(RADICE, 'node_modules/codice-fiscale-js/src/lista-comuni.js');
const FONTE_PKG = path.join(RADICE, 'node_modules/codice-fiscale-js/package.json');
const DESTINAZIONE = path.join(RADICE, 'src/lib/fiscale/dati/comuni-belfiore.ts');

/** `["A001","PD","ABANO TERME",1]` — belfiore, sigla, nome, attivo (1) / soppresso (0). */
const RIGA = /\[\s*"([^"]*)"\s*,\s*"([^"]*)"\s*,\s*"([^"]*)"\s*,\s*([01])\s*\]/g;

/**
 * Caratteri che non possono comparire in un nome, perché il file generato mette il dataset
 * dentro un template literal e usa `|` come separatore di campo. Se la fonte un giorno ne
 * contenesse uno, il file generato sarebbe sintatticamente rotto (backtick, `${`) o
 * silenziosamente sbagliato (`|`, a capo): meglio fermarsi.
 */
const VIETATI = /[`$|\\\r\n]/;

function argomento(nome) {
  const trovato = process.argv.find((a) => a.startsWith(`--${nome}=`));
  return trovato ? trovato.slice(nome.length + 3) : null;
}

function estrai() {
  const testo = readFileSync(FONTE_JS, 'utf8');
  const righe = [];
  let m;
  RIGA.lastIndex = 0;
  while ((m = RIGA.exec(testo)) !== null) {
    const [, belfiore, sigla, nome, attivo] = m;
    if (!/^[A-Z][0-9]{3}$/.test(belfiore)) {
      throw new Error(`Codice Belfiore fuori forma nella fonte: "${belfiore}" (${nome})`);
    }
    if (!/^[A-Z]{2}$/.test(sigla)) {
      throw new Error(`Sigla di provincia fuori forma nella fonte: "${sigla}" (${nome})`);
    }
    if (nome.trim() === '' || VIETATI.test(nome)) {
      throw new Error(`Nome non rappresentabile nella fonte: ${JSON.stringify(nome)}`);
    }
    righe.push({ belfiore, sigla, nome: nome.trim(), attivo: attivo === '1' });
  }

  // La fonte è nota: ~13.656 righe. Una soglia bassa intercetta il caso in cui la regex
  // smette di agganciare (fonte riscritta, minificata, sostituita) e produrrebbe un file
  // vuoto — che compilerebbe benissimo e non risolverebbe più nessun comune.
  if (righe.length < 10_000) {
    throw new Error(`Solo ${righe.length} righe estratte dalla fonte: forma cambiata, non genero.`);
  }
  return righe;
}

/**
 * Ordine stabile: belfiore, poi nome. Non dipende dall'ordine della fonte, così un
 * riordino a monte non produce un diff di 13.656 righe che nessuno rileggerà.
 * `localeCompare` è escluso di proposito: l'ordinamento dev'essere lo stesso su ogni
 * macchina, e il dataset è tutto ASCII maiuscolo.
 */
function ordina(righe) {
  return [...righe].sort((a, b) =>
    a.belfiore === b.belfiore
      ? a.nome < b.nome
        ? -1
        : a.nome > b.nome
          ? 1
          : a.sigla < b.sigla
            ? -1
            : a.sigla > b.sigla
              ? 1
              : 0
      : a.belfiore < b.belfiore
        ? -1
        : 1,
  );
}

function genera() {
  const righe = ordina(estrai());
  const versione = JSON.parse(readFileSync(FONTE_PKG, 'utf8')).version;
  const aggiornato = argomento('data') ?? new Date().toISOString().slice(0, 10);

  const attivi = righe.filter((r) => r.attivo);
  const soppressi = righe.length - attivi.length;
  const esteri = righe.filter((r) => r.belfiore.startsWith('Z'));
  const sigle = [...new Set(righe.map((r) => r.sigla))].sort();
  const corpo = righe.map((r) => `${r.belfiore}|${r.sigla}|${r.nome}|${r.attivo ? 1 : 0}`).join('\n');

  return `// =============================================================================
// FILE GENERATO — non modificare a mano.
// Si rigenera con:  node scripts/genera-comuni.mjs
//
// Tabella dei codici catastali (Belfiore) dei comuni italiani e degli stati esteri,
// usata per comporre e verificare il codice fiscale.
//
// ─── ATTRIBUZIONE (obbligatoria: questo repository è PUBBLICO) ────────────────
// I dati provengono da «codice-fiscale-js» (${versione}) di Luca Vandro e contributori
// — https://github.com/lucavandro/CodiceFiscaleJS — distribuiti sotto licenza
// Creative Commons Attribuzione - Condividi allo stesso modo 4.0 (CC BY-SA 4.0):
// https://creativecommons.org/licenses/by-sa/4.0/deed.it
// Questo file è un'OPERA DERIVATA di quei dati (riformattati, riordinati, non
// alterati nel contenuto) e resta perciò sotto la stessa licenza CC BY-SA 4.0.
//
// ─── ⚠️ L'ELENCO NON È AGGIORNATO A OGGI ──────────────────────────────────────
// La fonte è ferma a circa il 2022, e non lo dichiara da nessuna parte: è stato
// MISURATO su questo stesso dataset, non dedotto dalla data del pacchetto.
//   · MISILISCEMI (TP, M432) — istituito con effetto 2022 — È PRESENTE;
//   · UGGIATE CON RONAGO (CO) — istituito nel 2024 — NON C'È: al suo posto
//     compaiono ancora UGGIATE-TREVANO (L487) e RONAGO (H521) separati.
// Conseguenza pratica, da conoscere prima di fidarsi di una risposta «sconosciuto»:
// un comune nato dopo il 2022 non si risolve, e un comune fuso dopo il 2022 risulta
// ancora attivo. Per un bambino nato oggi il comune di nascita è quello che risulta
// sul certificato, quindi il caso si presenta: si aggiorni la dipendenza e si
// rilanci lo script.
//
// ─── FORMA ────────────────────────────────────────────────────────────────────
// Una sola stringa, righe separate da «\\n», campi separati da «|»:
//     BELFIORE|SIGLA|NOME|ATTIVO      (ATTIVO: 1 = attivo, 0 = soppresso)
// NON un array di oggetti: sarebbero ${righe.length.toLocaleString('it-IT')} letterali di cui TypeScript
// dovrebbe inferire il tipo a ogni compilazione. Così è un token solo.
// L'indice si costruisce pigramente in \`src/lib/fiscale/comuni.ts\`.
//
// ─── NUMERI DI QUESTA GENERAZIONE ─────────────────────────────────────────────
//   righe totali ............. ${righe.length}
//   attivi ................... ${attivi.length}
//   soppressi ................ ${soppressi}
//   stati esteri (Z***) ...... ${esteri.length}   (tutti sotto la sigla «EE»)
//   sigle distinte ........... ${sigle.length}   (le 107 province + EE + PL e ZA storiche)
// =============================================================================

/** Provenienza del dataset. Serve all'attribuzione e a sapere quanto è vecchio. */
export const FONTE = {
  nome: 'codice-fiscale-js',
  versione: '${versione}',
  licenza: 'CC-BY-SA-4.0',
  aggiornato: '${aggiornato}',
} as const;

/**
 * Il dataset grezzo. Tipo annotato \`string\` di proposito: senza annotazione TypeScript
 * inferirebbe il TIPO LETTERALE di 300 KB di testo.
 */
export const COMUNI_GREZZI: string = \`${corpo}\`;
`;
}

const testo = genera();
if (process.argv.includes('--stdout')) {
  process.stdout.write(testo);
} else {
  writeFileSync(DESTINAZIONE, testo, 'utf8');
  process.stdout.write(
    `Scritto ${path.relative(RADICE, DESTINAZIONE)} (${(Buffer.byteLength(testo) / 1024).toFixed(1)} KB)\n`,
  );
}
