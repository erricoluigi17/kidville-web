/**
 * Le misure della carta intestata, in millimetri, in un posto solo.
 *
 * Rilievo a 150 dpi sul rendering del PDF reale (`asset/carta-intestata.pdf`), non
 * stimato a occhio. Chi impagina sopra la carta legge da qui: due motori che si
 * ricopiano le stesse misure divergono sempre, prima o poi, e la divergenza si vede solo
 * su un foglio già consegnato.
 *
 * La pagina, dall'alto verso il basso:
 *
 * ```
 *   0,0  ┬  ─────────────────────────────────────────────
 *        │   (aria)
 *  12,5  ├─  marchio «Kidville» + «NIDO · INFANZIA / PRIMARIA · CAMPO ESTIVO»
 *  26,8  ┴─
 *  34,0  ├─  ← segnaturaRiga: la segnatura di protocollo, quando c'è
 *  40,0  ├─  ← contenutoInizio: qui comincia ciò che scrive l'app
 *        │
 *        │   area libera, con la filigrana mascotte (#F4F4F4) sotto il testo
 *        │
 * 266,0  ├─  ← contenutoFine
 * 268,5  ├─  ← rigaServizio: piede dell'app e «Pagina n di m», 7 pt grigio
 * 272,1  ├─  piede STAMPATO sulla carta: ragione sociale · Giugliano · Aversa · Cesa
 * 285,0  ┴─
 * 297,0     ─────────────────────────────────────────────
 * ```
 *
 * `contenutoInizio` è 40 e non 27: sotto il marchio ci vuole aria, altrimenti
 * l'intestazione di sede sembra appiccicata al logo della scuola. `contenutoFine` è 266
 * e non 272,1: 6,1 mm di margine sopra il piede stampato, perché il fondo di una cornice
 * o la coda di un descender non arrivino a toccarlo.
 *
 * ⚠️ **`contenutoFine` non si abbassa per guadagnare millimetri**, ed è stato misurato
 * invece che dedotto (2026-08-15). Portarlo a 270 sembra gratis — restano 2,1 mm d'aria
 * sopra il piede stampato — ma quei 6,1 mm non sono margine di cortesia: dentro ci sta
 * `rigaServizio`. «Pagina n di m» ha la linea di scrittura a 268,5 e in 7 pt le sue
 * lettere cominciano a 266,0. Un riquadro che scendesse a 270 ci finirebbe SOPRA. I
 * millimetri per far stare la firma nella pagina si trovano nel motore — che stringe lo
 * stacco prima di aprire un foglio nuovo — non qui.
 *
 * Testato in `__tests__/lib/carta-geometria.test.ts`.
 */

export const CARTA = {
  /** A4 in millimetri. L'asset è 595,276 × 841,89 pt, cioè esattamente questo. */
  larghezzaPagina: 210,
  altezzaPagina: 297,

  /** Il marchio stampato sulla carta: nessun contenuto dell'app entra qui dentro. */
  brandInizio: 12.5,
  brandFine: 26.8,

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
   * scuola (0 → 26,8) e ci stampa sopra un secondo logo Kidville — cioè ricrea i difetti
   * n. 1 e n. 2 della specifica, quelli per cui questo modulo è nato.
   *
   * Qui la segnatura è una riga sola, in 8 pt, nell'aria che `contenutoInizio` già lascia
   * sotto il marchio. Quell'aria è libera per costruzione: `contenutoInizio` È la
   * definizione di «dove l'app comincia a scrivere», quindi nessun motore che rispetti
   * `CARTA` può averci messo qualcosa.
   */
  segnaturaRiga: 34,

  /** Dove l'app può cominciare a scrivere, e dove deve avere finito. */
  contenutoInizio: 40,
  contenutoFine: 266,

  /**
   * La riga di servizio dell'app: il piede per modello e «Pagina n di m». Sta SOPRA il
   * piede stampato, nell'aria fra i due — non a 287, che cade dentro l'elenco delle tre
   * sedi già presente sulla carta.
   */
  rigaServizio: 268.5,

  /** Il piede a quattro colonne stampato sulla carta: ragione sociale e le tre sedi. */
  piedeInizio: 272.1,
  piedeFine: 285.0,
} as const

export type GeometriaCarta = typeof CARTA
