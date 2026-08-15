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
 * Testato in `__tests__/lib/carta-geometria.test.ts`.
 */

export const CARTA = {
  /** A4 in millimetri. L'asset è 595,276 × 841,89 pt, cioè esattamente questo. */
  larghezzaPagina: 210,
  altezzaPagina: 297,

  /** Il marchio stampato sulla carta: nessun contenuto dell'app entra qui dentro. */
  brandInizio: 12.5,
  brandFine: 26.8,

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
