'use client'

import { useEffect, useState, type RefObject } from 'react'
import { usePollingVisibile } from '@/lib/hooks/use-polling-visibile'
import { TracciaSelettore } from '@/lib/gallery/selettore-media'

/**
 * Aggancia `TracciaSelettore` ai due segnali che il selettore dei file non manda al componente:
 *
 *  · l'evento `cancel` dell'`<input type="file">`. React NON lo inoltra a `onCancel` su un input
 *    (lo ascolta solo sul `<dialog>`), quindi va agganciato a mano all'elemento;
 *  · il ritorno della pagina in primo piano, dal solo orologio che il repo ha già per questo:
 *    `usePollingVisibile` con `intervalloMs: null` («solo al ritorno»), che unisce
 *    `visibilitychange` e `appStateChange` di Capacitor e li fa contare una volta. Non si mette un
 *    ascoltatore nuovo accanto a lui: dove `visibilitychange` non scatta in una WebView iOS,
 *    `appStateChange` sì, e la correttezza non deve dipendere da quale dei due.
 *
 * Il tracciatore vive quanto il componente; allo smontaggio il suo timer si spegne.
 */
export function useTracciaSelettore(inputRef: RefObject<HTMLInputElement | null>): TracciaSelettore {
  const [traccia] = useState(() => new TracciaSelettore())

  useEffect(() => {
    const input = inputRef.current
    if (input === null) return
    const suCancel = () => traccia.cancel()
    input.addEventListener('cancel', suCancel)
    return () => input.removeEventListener('cancel', suCancel)
  }, [inputRef, traccia])

  useEffect(() => () => traccia.chiudi(), [traccia])

  usePollingVisibile(() => {
    traccia.ritorno()
  }, null)

  return traccia
}
