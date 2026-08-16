/**
 * Le misure della carta intestata, in millimetri, in un posto solo.
 *
 * Rilevate sui TRACCIATI VETTORIALI dell'asset (`asset/carta-intestata.pdf`), non stimate a
 * occhio e non lette da uno screenshot: la carta è vettoriale pura — zero elementi di testo
 * estraibile, misurato — quindi il marchio e il piede sono percorsi, e il loro ingombro
 * esatto è un numero, non un'impressione. Chi impagina sopra la carta legge da qui: due
 * motori che si ricopiano le stesse misure divergono sempre, prima o poi, e la divergenza si
 * vede solo su un foglio già consegnato.
 *
 * La pagina, dall'alto verso il basso:
 *
 * ```
 *   0,0  ┬  ─────────────────────────────────────────────
 *        │   (aria)
 *  12,5  ├─  marchio «Kidville» + «NIDO · INFANZIA / PRIMARIA · CAMPO ESTIVO»
 *  27,05 ┴─
 *  34,0  ├─  ← segnaturaRiga: la segnatura di protocollo, quando c'è
 *  40,0  ├─  ← contenutoInizio: qui comincia ciò che scrive l'app
 *        │
 *        │   area libera, con la filigrana mascotte (#F4F4F4) sotto il testo
 *        │
 * 263,5  ├─  ← contenutoFine
 * 266,2  ┆   ← qui l'inchiostro più alto di «Pagina n di m» (7 pt)
 * 268,5  ├─  ← rigaServizio: LINEA DI SCRITTURA del piede dell'app, 7 pt grigio
 * 272,1  ├─  piede STAMPATO sulla carta: ragione sociale · Giugliano · Aversa · Cesa
 * 285,1  ┴─
 * 297,0     ─────────────────────────────────────────────
 * ```
 *
 * `contenutoInizio` è 40 e non 28: sotto il marchio ci vuole aria, altrimenti
 * l'intestazione di sede sembra appiccicata al logo della scuola.
 *
 * ⚠️ **`brandFine` è 27,05 e non 26,8** (corretto il 2026-08-16). Il 26,8 veniva da un
 * rilievo a 150 dpi, cioè da pixel contati su un'immagine; l'inchiostro vero del marchio
 * arriva a **27,026 mm**, verificato in due modi indipendenti — il riquadro d'ingombro che
 * PDF.js consegna e il calcolo analitico degli estremi delle cubiche di Bézier, che danno
 * lo stesso numero. Erano 0,23 mm in cui un lock diceva «libero» e la carta aveva il
 * logotipo. Stessa storia, più piccola, per `piedeFine` (285,0 → 285,085, dichiarato 285,1).
 * I limiti si arrotondano sempre **verso l'esterno della fascia**: una fascia dichiarata più
 * larga del vero costa millimetri, una dichiarata più stretta costa il foglio.
 *
 * ⚠️ **`contenutoFine` è 263,5 e non 266, e i 2,5 mm di differenza sono stati PAGATI.**
 * Fino al 2026-08-15 valeva 266, e questa stessa testata dichiarava che i millimetri fino
 * al piede stampato bastassero «perché dentro ci sta `rigaServizio`». Non bastavano, ed è
 * stato misurato invece che dedotto: `rigaServizio` è la **linea di scrittura**, non la
 * cima delle lettere. Le maiuscole di 7 pt cominciano 1,77 mm più su, cioè a 266,73 — e un
 * riquadro di verifica ancorato a 266 chiudeva a **0,73 mm** da «Pagina 2 di 2»: a occhio
 * si toccano. Sulla stampa di sezione il filetto dell'ultima riga di tabella cadeva a
 * 265,5 e «Riservato — dati di minori · …» cominciava a 266,8, cioè sembrava una riga
 * della tabella.
 *
 * Un commento che promette un'aria che il codice non lascia è la classe di difetto che
 * questo progetto chiama incidente. Ora l'aria c'è davvero, e non si conta a occhio: la
 * conta `ingombroTesto()`, qui sotto, con le metriche vere del carattere.
 *
 * E **non si risale a 266 per guadagnare millimetri**: i millimetri per far stare la firma
 * nella pagina si trovano nel motore — che stringe lo stacco prima di aprire un foglio
 * nuovo — non qui.
 *
 * ⚠️ **E adesso quella promessa ha un nome**: `quotaBloccoFinale()`, in
 * `carta/blocco-finale.ts`. Fino al 2026-08-16 questa riga descriveva un comportamento che
 * **un motore su due** aveva davvero: `prestampati/impaginazione.ts` stringeva lo stacco,
 * `protocolli/documento-pdf.ts` aveva un `+18` fisso e mandava la firma da sola su un foglio
 * di carta intestata. Un commento che promette un'aria che il codice non lascia è la classe
 * di difetto che questo progetto chiama incidente — e la cura non è cancellare la frase, è
 * far esistere la funzione che la mantiene per tutti.
 *
 * Testato in `__tests__/lib/carta-geometria.test.ts`, che le due fasce **le rimisura
 * sull'asset** invece di riscrivere questi numeri: un lock che ricopia il valore che
 * sorveglia non sorveglia niente.
 */

export const CARTA = {
  /** A4 in millimetri. L'asset è 595,276 × 841,89 pt, cioè esattamente questo. */
  larghezzaPagina: 210,
  altezzaPagina: 297,

  /**
   * Il marchio stampato sulla carta: nessun contenuto dell'app entra qui dentro.
   * Inchiostro misurato: 12,500 → 27,026 mm.
   */
  brandInizio: 12.5,
  brandFine: 27.05,

  /**
   * I margini laterali del contenuto. Stanno qui e non dentro ogni motore perché la
   * segnatura di protocollo deve allinearsi a ciò che il motore scrive sotto, e due
   * numeri uguali scritti in due file diversi restano uguali finché qualcuno non tocca
   * uno solo dei due.
   */
  margineSx: 22,
  margineDx: 188,

  /**
   * LA SEGNATURA DI PROTOCOLLO, e perché sta proprio qui.
   *
   * Su un documento acquisito — una scansione, una foto — il registro protocolli stampa
   * la segnatura come una fascia verde alta 64 pt in testa al foglio, col logo bianco
   * dentro (`src/lib/protocolli/timbro.ts`). Su un foglio bianco è la scelta giusta: non
   * copre niente. Sulla carta intestata quella fascia cade ESATTAMENTE sul marchio della
   * scuola (0 → 27,05) e ci stampa sopra un secondo logo Kidville — cioè ricrea i difetti
   * n. 1 e n. 2 della specifica, quelli per cui questo modulo è nato.
   *
   * Qui la segnatura è una riga sola, in 8 pt, nell'aria che `contenutoInizio` già lascia
   * sotto il marchio. Quell'aria è libera per costruzione: `contenutoInizio` È la
   * definizione di «dove l'app comincia a scrivere», quindi nessun motore che rispetti
   * `CARTA` può averci messo qualcosa.
   */
  segnaturaRiga: 34,

  /**
   * Dove l'app può cominciare a scrivere, e dove deve avere finito.
   *
   * ⚠️ **I due limiti NON hanno la stessa semantica, e va detto invece che dedotto.**
   * `contenutoInizio` è una **linea di scrittura**: il motore la usa come baseline della
   * prima riga (`Y_INTESTAZIONE`), e l'inchiostro di quella riga sta ~2,3 mm PIÙ SU (a 40
   * con 9 pt: 37,0 mm). Regge lo stesso, perché fra 27,05 e 37,0 restano dieci millimetri
   * d'aria — ma chi ci appoggia un corpo grande faccia il conto con `ingombroTesto()`.
   * `contenutoFine`, invece, è un limite d'**inchiostro**: vale per TUTTO ciò che l'app
   * disegna — il flusso del testo, il bordo basso di un riquadro ancorato al fondo,
   * l'ultimo filetto di una tabella — e lascia 2,7 mm liberi sopra la cima delle lettere
   * di `rigaServizio`.
   */
  contenutoInizio: 40,
  contenutoFine: 263.5,

  /**
   * La riga di servizio dell'app: il piede per modello e «Pagina n di m». Sta SOPRA il
   * piede stampato, nell'aria fra i due — non a 287, che cade dentro l'elenco delle tre
   * sedi già presente sulla carta.
   *
   * ⚠️ È la **linea di scrittura**, non la cima del testo: in 7 pt le maiuscole
   * cominciano 1,77 mm più su e l'inchiostro più alto del carattere 2,30 mm più su. Chi
   * confronta una quota con questo numero sta misurando dal posto sbagliato — ed è
   * esattamente l'errore che ha fatto chiudere il riquadro di verifica a 0,73 mm da
   * «Pagina 2 di 2». Il conto lo fa `ingombroTesto()`.
   */
  rigaServizio: 268.5,

  /**
   * Il piede a quattro colonne stampato sulla carta: ragione sociale e le tre sedi.
   * Inchiostro misurato: 272,112 → 285,085 mm.
   */
  piedeInizio: 272.1,
  piedeFine: 285.1,
} as const

export type GeometriaCarta = typeof CARTA

const MM_PER_PUNTO = 25.4 / 72

/**
 * LE METRICHE DEL CARATTERE, e perché non sono un numero tirato a indovinare.
 *
 * Helvetica standard (la stessa che usano jsPDF e pdf-lib senza font incorporati) dichiara
 * nel proprio AFM: `CapHeight 718`, `Descender -207`, **`FontBBox [-166 -225 1000 931]`**,
 * su mille unità di em. Il riquadro del carattere è l'unico limite che vale per OGNI
 * glifo: la «È» maiuscola accentata arriva a 0,931 em, cioè 0,213 em sopra l'altezza delle
 * maiuscole normali — e le parole gridate in italiano sono proprio quelle che i moduli
 * mettono in cima alla pagina.
 *
 * Perciò qui si usa il riquadro, non `CapHeight`: un limite tarato sulle maiuscole normali
 * è un limite che sbaglia sulle parole più grandi del foglio.
 */
const SALITA_MASSIMA = 0.931
const DISCESA_MASSIMA = 0.225

/** L'ingombro d'inchiostro di una riga di testo: cima e fondo, in millimetri. */
export interface IngombroTesto {
  /** Il punto più alto che l'inchiostro può raggiungere (millimetri dal bordo alto). */
  cima: number
  /** Il punto più basso, discendenti comprese. */
  fondo: number
}

/**
 * Da una LINEA DI SCRITTURA all'INGOMBRO che quella riga occupa davvero sul foglio.
 *
 * Serve ovunque si confronti una quota di testo con una fascia vietata: `pagina.text(…, y)`
 * mette a `y` la baseline, e le lettere stanno sopra. Una guardia che confronta la baseline
 * ha le maglie larghe quanto l'altezza del carattere — in 12 pt sono 3,3 mm, cioè più della
 * distanza che separa un piede di pagina dal piede stampato sulla carta.
 */
export function ingombroTesto(baseline: number, corpoPt: number): IngombroTesto {
  const corpo = Math.max(0, corpoPt) * MM_PER_PUNTO
  return { cima: baseline - SALITA_MASSIMA * corpo, fondo: baseline + DISCESA_MASSIMA * corpo }
}

/** Un rettangolo sul foglio da stampare: millimetri dal bordo alto-sinistro. */
export interface Rettangolo {
  sinistra: number
  alto: number
  larghezza: number
  altezza: number
}

/** Come la carta si posa su un foglio: quanto è scalata, se è girata, dove finisce. */
export interface StesuraCarta {
  /** Fattore di scala UNIFORME: il marchio di una scuola non si stira, mai. */
  scala: number
  /** 0 oppure 90 gradi, in senso antiorario come vuole il formato PDF. */
  giro: 0 | 90
  /** L'ingombro della carta sul foglio, giro compreso. */
  riquadro: Rettangolo
  /** Frazione di foglio coperta dalla carta: sotto 1 restano fasce bianche. */
  copertura: number
}

const VUOTO: Rettangolo = { sinistra: 0, alto: 0, larghezza: 0, altezza: 0 }

/**
 * Dove finisce la carta su un foglio che non è per forza il suo, e con quale verso.
 *
 * Due regole, in quest'ordine:
 *
 *  1. **la scala è uniforme** — mai due fattori diversi sui due assi. Fino al 2026-08-15 il
 *     motore diceva «riempi il foglio»: su A4 verticale era esatto per coincidenza, su A4
 *     orizzontale allargava la carta di 1,414× e la schiacciava di 0,707×, e il logotipo
 *     «Kidville» diventava grasso e piatto;
 *  2. **fra dritta e girata di 90° vince quella che copre di più.**
 *
 * ⚠️ **SUL FOGLIO ORIZZONTALE MARCHIO E CONTENUTO NON POSSONO ESSERE DRITTI INSIEME, e
 * questa funzione sceglie il marchio.** La carta è un foglio A4 verticale: su una pagina
 * orizzontale ci sta solo girata (e allora la copre tutta, scala 1) oppure dritta e
 * rimpicciolita al 70,7%, con 74 mm di bianco per lato. Girarla è ciò che rimette il
 * marchio in testa al foglio FISICO — esattamente come stampare una tabella orizzontale su
 * un foglio di carta intestata vera — al prezzo che, per leggere il contenuto, il foglio si
 * gira in senso orario e in quel momento il marchio si legge di lato.
 *
 * Fino al 2026-08-16 il commento qui accanto sosteneva che dopo il giro il marchio tornasse
 * «in alto a sinistra» e taceva sull'altra metà: reso e guardato, il contenuto dell'app
 * finiva SOPRA la riga «NIDO · INFANZIA / PRIMARIA · CAMPO ESTIVO». Non era la rotazione a
 * essere sbagliata — era che **nessuno poteva sapere dove il giro portasse le due fasce
 * vietate**. Adesso lo dice `fasceVietate()`, e sull'orizzontale sono due colonne: il
 * marchio a 12,5→27,05 dal bordo sinistro, il piede stampato a 272,1→285,1 (cioè 11,9 mm
 * dal bordo destro). Fra le due restano 245 mm buoni, che è quanto serve al registro
 * presenze: con la carta «contain» ne resterebbero 148,5 e il registro uscirebbe per metà
 * fuori dal foglio della scuola.
 *
 * Su un formato che non è né A4 né A4 girato non c'è una risposta giusta: la carta si stende
 * «contain» e centrata, e resta dell'aria ai lati. Aria bianca si vede e si corregge; un
 * marchio stirato passa per una scelta grafica.
 */
export function stesuraCarta(larghezzaFoglio: number, altezzaFoglio: number): StesuraCarta {
  const W = CARTA.larghezzaPagina
  const H = CARTA.altezzaPagina
  if (!(larghezzaFoglio > 0) || !(altezzaFoglio > 0)) {
    return { scala: 0, giro: 0, riquadro: VUOTO, copertura: 0 }
  }

  const dritta = Math.min(larghezzaFoglio / W, altezzaFoglio / H)
  const girata = Math.min(larghezzaFoglio / H, altezzaFoglio / W)
  const giro: 0 | 90 = girata > dritta ? 90 : 0
  const scala = giro === 90 ? girata : dritta
  // Girata, la carta occupa sul foglio la propria ALTEZZA in larghezza e viceversa.
  const larghezza = scala * (giro === 90 ? H : W)
  const altezza = scala * (giro === 90 ? W : H)

  return {
    scala,
    giro,
    riquadro: {
      sinistra: (larghezzaFoglio - larghezza) / 2,
      alto: (altezzaFoglio - altezza) / 2,
      larghezza,
      altezza,
    },
    copertura: (larghezza * altezza) / (larghezzaFoglio * altezzaFoglio),
  }
}

/**
 * Una fascia orizzontale della CARTA (da `da` a `a`, per tutta la sua larghezza), portata
 * sul foglio con la stessa stesura che ci stende la carta.
 *
 * Il verso del giro non è indifferente e non è deducibile: con `rotate: 90°` pdf-lib porta
 * il bordo ALTO della carta sul bordo SINISTRO del foglio, quindi una fascia che sulla
 * carta è orizzontale diventa una colonna, e la distanza dalla cima della carta diventa
 * distanza dal bordo sinistro del foglio. Verificato misurando l'inchiostro della carta sul
 * foglio composto, non ragionandoci sopra: `__tests__/lib/carta-applica.test.ts`.
 */
function fasciaSulFoglio(stesura: StesuraCarta, da: number, a: number): Rettangolo {
  const { riquadro, scala, giro } = stesura
  const spessore = Math.max(0, a - da) * scala
  if (giro === 90) {
    return {
      sinistra: riquadro.sinistra + da * scala,
      alto: riquadro.alto,
      larghezza: spessore,
      altezza: riquadro.altezza,
    }
  }
  return {
    sinistra: riquadro.sinistra,
    alto: riquadro.alto + da * scala,
    larghezza: riquadro.larghezza,
    altezza: spessore,
  }
}

/**
 * Le due fasce che l'app non può toccare, sul foglio davvero stampato.
 *
 * Il marchio della scuola e il piede a quattro colonne: chi impagina su un formato che non
 * sia l'A4 verticale — il registro presenze è orizzontale — chiede QUI dove sono, invece di
 * assumere che siano «in alto» e «in basso». Sull'orizzontale non lo sono: sono a sinistra
 * e a destra.
 */
export function fasceVietate(
  larghezzaFoglio: number,
  altezzaFoglio: number
): { marchio: Rettangolo; piede: Rettangolo } {
  const stesura = stesuraCarta(larghezzaFoglio, altezzaFoglio)
  if (stesura.scala === 0) return { marchio: VUOTO, piede: VUOTO }
  return {
    marchio: fasciaSulFoglio(stesura, CARTA.brandInizio, CARTA.brandFine),
    piede: fasciaSulFoglio(stesura, CARTA.piedeInizio, CARTA.piedeFine),
  }
}
