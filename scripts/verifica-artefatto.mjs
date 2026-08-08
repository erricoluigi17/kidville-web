#!/usr/bin/env node
// =============================================================================
// IL QUINTO CANCELLO: GUARDARE DENTRO CIÒ CHE SI SPEDISCE
//
// Il 2026-08-08, con eslint 0, tsc 0, 7.694 test verdi e `npm run build` uscito
// 0, otto rotte dell'applicazione rispondevano **500 con corpo vuoto a ogni
// utente**. La causa non era nel sorgente: era nell'ARTEFATTO. Turbopack aveva
// compilato
//
//     return (await qualcheFiglioSospeso(...)) ? negato(...) : null
//
// trasformando il ramo `: null` nella STRINGA «TURBOPACK unreachable». Per ogni
// genitore non sospeso — cioè per tutti — la funzione restituiva una stringa
// verissima, la rotta la ritornava come se fosse una risposta, e Next rifiutava:
// «Expected a Response object but received 'string'».
//
// ─── PERCHÉ NESSUN TEST L'AVREBBE MAI VISTO ─────────────────────────────────
//
// eslint, tsc e vitest girano sul SORGENTE TypeScript, dove quel codice è
// corretto e lo è sempre stato. `npm run build` esce 0 perché la build RIESCE: è
// il codice che genera a essere sbagliato. Fra i quattro cancelli del gate non ce
// n'era nessuno che aprisse il pacco prima di spedirlo.
//
// Questo script è quel cancello. Gira come `postbuild`, quindi `npm run build`
// diventa rosso da solo — in locale e in CI — senza che nessuno debba ricordarsi
// di invocarlo.
//
// ─── COSA CERCA, E COSA NON PROMETTE ────────────────────────────────────────
//
// Cerca i marcatori che un compilatore lascia quando ha DECISO qualcosa su un
// ramo di codice: sono stringhe che nessun sorgente di questo repo scriverebbe
// mai, quindi la loro presenza è di per sé la prova. Non è un verificatore di
// correttezza del bundle: non sa niente di logica, di prestazioni o di ciò che
// il codice fa. Sa dire una cosa sola, e la dice bene: *il compilatore ha
// sostituito un pezzo del tuo codice con un segnaposto*.
//
// Se un giorno un marcatore nuovo comparirà con una versione nuova di Turbopack,
// va aggiunto qui — e il modo per accorgersene è che un difetto come questo torni.
// =============================================================================

import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, sep } from 'node:path'

/**
 * ─── LA DISTINZIONE CHE RENDE UTILE QUESTO CANCELLO ─────────────────────────
 *
 * `TURBOPACK unreachable` compare **migliaia di volte** in un build sano, ed è
 * giusto così: è la forma normale con cui Turbopack elimina i rami morti.
 *
 *     if ("TURBOPACK compile-time falsy", 0) //TURBOPACK unreachable ;
 *     return ("TURBOPACK compile-time falsy", 0) ? "TURBOPACK unreachable" : x;
 *
 * In entrambi i casi la condizione è una COSTANTE decisa a compilazione, quindi
 * il segnaposto non viene mai valutato. Un cancello che li conta tutti dice
 * «11.507 guasti» su un artefatto perfetto, e si impara a scavalcarlo in un
 * giorno — la prima stesura di questo script faceva esattamente questo.
 *
 * Il caso pericoloso è l'altro, ed è quello del 2026-08-08:
 *
 *     return await qualcheFiglioSospeso(...) ? (…403…) : "TURBOPACK unreachable"
 *
 * qui la condizione è un valore di RUNTIME: quando è falsa — cioè per ogni
 * genitore non sospeso — la funzione restituisce davvero quella stringa.
 *
 * Quindi si segnala un `"TURBOPACK unreachable"` **in posizione di valore** che
 * NON sia governato da un `TURBOPACK compile-time` lì accanto. È una euristica,
 * e la sua taratura è verificata: rimettendo il ternario che ha causato il
 * guasto, questo script torna rosso (provato il 2026-08-08, non dedotto).
 */
const MARCATORE = '"TURBOPACK unreachable"'

/**
 * Quanto indietro si guarda per trovare la decisione del compilatore.
 *
 * 400 e non 80: fra la condizione e il segnaposto può starci un oggetto intero
 * (`... ? { devCredentials: { email, password } } : "TURBOPACK unreachable"`), e
 * con una finestra corta quelle forme — perfettamente sane — risultavano guaste.
 * Tarato misurando, non stimando: a 80 dava 12 falsi positivi, a 400 ne dà zero,
 * e il difetto vero resta rosso (il ternario incriminato non ha nessuna costante
 * di compilazione nei 420 caratteri che lo precedono).
 */
const FINESTRA = 400

/**
 * Cosa NON si guarda:
 *  · `node_modules` — codice non nostro, che non riscriveremmo comunque;
 *  · `.next/dev` — i chunk del server di sviluppo, che non vengono spediti e
 *    contengono di proposito rami compilati via (`devCode`, `devCredentials`).
 */
const estraneo = (p) => p.includes('node_modules') || p.includes(`${sep}dev${sep}`)

const RADICE = process.cwd()
const CARTELLA = join(RADICE, '.next')

/** Tutti i `.js` sotto `.next`, esclusa la cache (che non viene spedita). */
function* fileJs(dir) {
  for (const voce of readdirSync(dir, { withFileTypes: true })) {
    if (voce.name === 'cache') continue
    const percorso = join(dir, voce.name)
    if (voce.isDirectory()) yield* fileJs(percorso)
    else if (voce.name.endsWith('.js')) yield percorso
  }
}

if (!existsSync(CARTELLA)) {
  // Nessun artefatto: non è un fallimento, è un `postbuild` invocato senza build.
  // Fallire qui renderebbe rosso chi non ha costruito niente — e un cancello che
  // si lamenta a vuoto è un cancello che si impara a scavalcare.
  console.log('verifica-artefatto: nessuna cartella .next, niente da controllare.')
  process.exit(0)
}

const guasti = []
let esaminati = 0

for (const percorso of fileJs(CARTELLA)) {
  if (estraneo(percorso)) continue
  esaminati++
  const testo = readFileSync(percorso, 'utf8')
  let i = testo.indexOf(MARCATORE)
  while (i !== -1) {
    const prima = testo.slice(Math.max(0, i - FINESTRA), i)
    // Governato da una costante di compilazione → è eliminazione di codice morto,
    // e non verrà mai valutato. Tutto normale.
    if (!prima.includes('TURBOPACK compile-time')) {
      guasti.push({
        file: percorso.slice(RADICE.length + 1),
        contesto: testo.slice(Math.max(0, i - 300), i + MARCATORE.length + 20).replace(/\s+/g, ' '),
      })
    }
    i = testo.indexOf(MARCATORE, i + 1)
  }
}

if (guasti.length === 0) {
  console.log(`verifica-artefatto: ${esaminati} file JS esaminati, nessun segnaposto in posizione di valore. ✓`)
  process.exit(0)
}

console.error('')
console.error('⛔ ARTEFATTO AVVELENATO — il compilatore ha sostituito del codice con un segnaposto.')
console.error('')
console.error(`Trovate ${guasti.length} occorrenze in ${new Set(guasti.map((g) => g.file)).size} file.`)
console.error('')
for (const g of guasti.slice(0, 10)) {
  console.error(`  ${g.file}`)
  console.error(`    contesto:  …${g.contesto}`)
  console.error('')
}
if (guasti.length > 10) console.error(`  …e altre ${guasti.length - 10}.`)
console.error('COSA SIGNIFICA: nel punto indicato il compilatore ha deciso che il codice non fosse')
console.error('raggiungibile e ha messo una STRINGA al suo posto. Se quel punto era il ramo che')
console.error('restituisce `null`, adesso restituisce una stringa — e chi la riceve la tratta come')
console.error('un valore vero. Il 2026-08-08 questo ha fatto rispondere 500 a otto rotte, per tutti,')
console.error('con eslint, tsc e 7.694 test verdi.')
console.error('')
console.error('COME SI CHIUDE: riscrivi l’espressione in forma esplicita — un `if` con `return` al')
console.error('posto di un ternario è bastato — poi ricostruisci e rilancia. Il sorgente era')
console.error('corretto: è la forma che il compilatore non ha digerito.')
console.error('')
process.exit(1)
