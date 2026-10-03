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
 *
 * ⚠️ L'`<input>` DEVE ESSERCI QUANDO IL COMPONENTE SI MONTA. L'effetto qui sotto cerca `inputRef.current`
 * UNA volta sola, e con un input che arriva dopo (dentro un'area di scelta che si disegna solo a
 * rilevazione finita) troverebbe `null`, uscirebbe, e `motivo=cancel` non si scriverebbe mai — senza un
 * errore da nessuna parte. Nell'app 1.2 l'area di scelta aspetta la rilevazione del plugin (spec «caricamenti
 * nativi» §7.2): per questo `MediaUploader` tiene l'`<input>` fuori dall'area, sempre montato, e lo prova
 * `MediaUploader-nativo-12.test.tsx` («l'<input> del browser è montato anche prima che la rilevazione risponda»).
 *
 * Le strade NATIVE del selettore (`selettore-nativo`, `file-nativo`) non passano da questi due segnali: a
 * dire come è finita la scelta è la promise di `scegliMedia`, e `MediaUploader` chiama `traccia` da sé.
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
