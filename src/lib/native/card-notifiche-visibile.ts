import { useSyncExternalStore } from 'react'

/**
 * «La card “Le notifiche sono spente” è nella pagina»: un solo bit, di modulo.
 *
 * Il docente ha due avvisi che dicono la stessa cosa: la card fissa della home (`AvvisoNotificheDocente`)
 * e il foglio settimanale in basso (`AvvisiSettimanaliApp`, montato dal layout, quindi su ogni pagina). Insieme
 * il foglio copre la lista sopra la barra e ripete il messaggio. Il rimedio più piccolo: la card, quando è a
 * schermo, lo scrive qui; il foglio, finché lo legge acceso, non si disegna. Il foglio non è «chiuso»: tolta la
 * card (o cambiata pagina) torna da solo, se è ancora la sua settimana.
 */
let visibile = false
const ascoltatori = new Set<() => void>()

export function segnalaCardNotifiche(valore: boolean): void {
  if (visibile === valore) return
  visibile = valore
  ascoltatori.forEach((a) => a())
}

export function cardNotificheVisibile(): boolean {
  return visibile
}

function iscrivi(a: () => void): () => void {
  ascoltatori.add(a)
  return () => {
    ascoltatori.delete(a)
  }
}

/** `true` mentre la card è a schermo. Sul server vale `false`. */
export function useCardNotificheVisibile(): boolean {
  return useSyncExternalStore(iscrivi, cardNotificheVisibile, () => false)
}
