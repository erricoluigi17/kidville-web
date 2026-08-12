/**
 * I CONTROLLI RAGGIUNGIBILI DENTRO UN DIALOGO — un pezzo solo, due dialoghi.
 *
 * Questo selettore e il filtro di visibilità vivevano dentro `src/components/ui/Modal.tsx`,
 * privati. Il 2026-08-12 è servito lo stesso ciclo di Tab per il `Drawer` del cockpit
 * (`src/components/ui/cockpit.tsx`), che NON passa da `Modal` e non può passarci: `Modal`
 * centra il proprio contenuto, e uno slide-over ancorato a destra e alto quanto lo schermo
 * non ci entra senza cambiare la primitiva.
 *
 * Ricopiare le due funzioni sarebbe stato il modo di farle divergere: il filtro `visibile`
 * esiste perché una prima versione portava il fuoco su controlli di un ramo
 * `display:none` e all'utente sembrava sparito — una correzione che, scritta due volte,
 * la seconda modifica ne aggiusta una sola.
 *
 * Modulo senza dipendenze da React: è DOM puro, come `inerti.ts` accanto.
 */

/**
 * Ciò che il browser mette nel giro del Tab. `[tabindex="-1"]` è escluso di proposito:
 * un nodo con `-1` riceve il fuoco se glielo si dà, ma non è una tappa del ciclo — ed è
 * esattamente il caso del contenitore `role="dialog"`, che si mette a fuoco all'apertura
 * e non deve poi ripresentarsi a ogni giro come una tappa muta.
 */
export const FOCUSABILI =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

/**
 * Un controllo entra nel giro del focus solo se è davvero a schermo.
 *
 * `querySelectorAll(FOCUSABILI)` restituisce anche i controlli di un ramo nascosto
 * (`display:none`, `visibility:hidden`, `[hidden]`): il ciclo di Tab ci portava sopra il
 * fuoco e all'utente sembrava sparito. Si risale fino alla radice del dialogo perché
 * `display:none` NON si eredita: `getComputedStyle` sul figlio di un ramo nascosto
 * continua a rispondere `inline-block`.
 */
export function visibileIn(el: HTMLElement, radice: HTMLElement): boolean {
  let nodo: HTMLElement | null = el
  while (nodo) {
    if (nodo.hasAttribute('hidden')) return false
    const stile = getComputedStyle(nodo)
    if (stile.display === 'none' || stile.visibility === 'hidden') return false
    if (nodo === radice) break
    nodo = nodo.parentElement
  }
  return true
}

/** I controlli tabbabili DAVVERO a schermo dentro `radice`, in ordine di documento. */
export function focusabiliIn(radice: HTMLElement | null): HTMLElement[] {
  if (!radice) return []
  return Array.from(radice.querySelectorAll<HTMLElement>(FOCUSABILI)).filter((el) =>
    visibileIn(el, radice),
  )
}
