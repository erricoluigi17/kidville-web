'use client'

import { useCallback, useEffect, useRef } from 'react'
import { useOverlayIndietro } from '@/lib/mobile/overlay-indietro'

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

/**
 * COMPORTAMENTO DA DIALOGO per i bottom-sheet che NON passano da `ui/Modal`.
 *
 * Il collaudo del 2026-08-03 (T08-F6, e con più gravità T09) ha contato **18**
 * superfici `fixed inset-0` che si comportano da finestra modale senza esserlo:
 * niente chiusura con `Escape`, nessuna annuncio come dialogo, nessun ritorno del
 * focus. Fra queste c'erano le DUE bottom-nav — cioè la navigazione principale del
 * telefono per ogni famiglia e per ogni docente.
 *
 * `AdminMenuSheet` era l'unica eccezione virtuosa, e la sua ricetta era scritta lì
 * dentro. Questo modulo è quella ricetta ESTRATTA, non riscritta: `ui/Modal` non è
 * adottabile qui senza buttare via l'animazione a molla di `framer-motion` che
 * governa l'entrata del foglio, ma il comportamento di accessibilità non ha nulla a
 * che vedere con l'animazione e non ha motivo di essere diverso.
 *
 * Perché in un posto solo e non copiato nei due file: la lezione pagata il
 * 2026-08-01 su questo repo — *una regola valida per due strade deve vivere in un
 * posto solo* — è stata pagata esattamente così, con due navigazioni gemelle che
 * avevano ricevuto la stessa correzione una volta sola.
 *
 * Cosa fa, quando `aperto` è vero:
 *  - blocca lo scorrimento del `body` (il contenuto dietro non deve scorrere);
 *  - porta il focus sul bottone «Chiudi» e lo RESTITUISCE, alla chiusura, a chi ce
 *    l'aveva prima (di norma il bottone «Menu» che ha aperto il foglio);
 *  - chiude con `Escape` e cicla il `Tab` dentro il foglio (focus-trap);
 *  - aggancia il tasto Indietro fisico di Android (`useOverlayIndietro`), così
 *    Indietro chiude il foglio invece di portare via la pagina sotto.
 *
 * Chi lo usa deve ancora mettere sul contenitore del foglio `role="dialog"`,
 * `aria-modal="true"` e `aria-labelledby`: sono marcature dell'HTML, non
 * comportamento, e stanno dove sta il titolo.
 */
export function useFoglioModale(aperto: boolean, chiudi: () => void) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeBtnRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!aperto) return
    // Chi aveva il focus PRIMA dell'apertura: alla chiusura torna lì. Va letto
    // dentro l'effetto e non al render — al render il foglio è già montato.
    const precedente = document.activeElement as HTMLElement | null
    const overflowPrecedente = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeBtnRef.current?.focus()
    return () => {
      document.body.style.overflow = overflowPrecedente
      precedente?.focus?.()
    }
  }, [aperto])

  useOverlayIndietro(aperto, chiudi)

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        chiudi()
        return
      }
      if (e.key !== 'Tab') return
      const nodi = dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE)
      if (!nodi || nodi.length === 0) return
      const primo = nodi[0]
      const ultimo = nodi[nodi.length - 1]
      const attivo = document.activeElement
      if (e.shiftKey && attivo === primo) {
        e.preventDefault()
        ultimo.focus()
      } else if (!e.shiftKey && attivo === ultimo) {
        e.preventDefault()
        primo.focus()
      }
    },
    [chiudi],
  )

  return { dialogRef, closeBtnRef, onKeyDown }
}
