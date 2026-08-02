'use client'

import { useEffect, useRef } from 'react'
import { useOverlayIndietro } from '@/lib/mobile/overlay-indietro'

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

// Stack degli id dei Modal aperti: SOLO il Modal in cima gestisce Escape e il
// focus-trap. Senza questo, due dialoghi annidati (entrambi in ascolto su
// `document`) si chiuderebbero a vicenda con un solo Escape e si contenderebbero
// il focus. `stopPropagation()` non basta: i listener sono sullo stesso target.
const modalStack: symbol[] = []

/**
 * REGISTRO DEI NODI RESI INERTI — perché il conteggio, e non un booleano.
 *
 * Con due modali sovrapposte gli stessi nodi di sfondo vengono marcati due volte:
 * se la seconda che si chiude togliesse l'attributo d'ufficio, la pagina tornerebbe
 * raggiungibile *sotto* una modale ancora aperta — cioè il difetto che stiamo
 * chiudendo, ricomparso al secondo dialogo. Si tiene quindi un conteggio per
 * elemento e si ripristina solo quando torna a zero, ricordando anche lo stato
 * ORIGINALE (un nodo può essere già `inert` di suo: non glielo si toglie).
 */
const inerti = new Map<
  HTMLElement,
  { conteggio: number; aveaInert: boolean; ariaHiddenOriginale: string | null }
>()

/**
 * Rende inerte tutto il documento TRANNE il sottoalbero del contenitore modale, e
 * restituisce la funzione che ripristina.
 *
 * PERCHÉ SERVE (misurato su Android il 2026-07-31). `aria-modal="true"` su un `div`
 * non esclude niente: Chromium lo onora solo per il top layer (`<dialog>` +
 * `showModal()`). Con la modale «Nuovo avviso» aperta, il dump dell'albero di
 * accessibilità conteneva ancora l'elenco degli avvisi con i suoi bottoni
 * «Modifica» ed «Elimina»: con TalkBack lo swipe portava fuori dalla modale, e i
 * comandi della pagina sotto restavano attivabili.
 *
 * PERCHÉ SI RISALE FINO A `document.body` MARCANDO I FRATELLI A OGNI LIVELLO, invece
 * di marcare i soli figli del `body`. La modale è renderizzata IN LINEA nell'albero
 * React (nessun portale): il suo contenitore è annidato in profondità dentro la
 * pagina, quindi i «fratelli a livello di body» sarebbero uno solo — il guscio che
 * contiene ANCHE la modale. Marcare i fratelli a ogni livello isola davvero il
 * sottoalbero del dialogo, senza cambiare dove la modale viene montata (un portale
 * avrebbe rotto i 15 consumatori e i loro test).
 *
 * `inert` E, SOLO DOVE NON ESISTE, `aria-hidden`. `inert` è la forma giusta: toglie
 * dall'albero di accessibilità E dal giro del focus. Dove il motore non lo conosce
 * (WebKit < 15.5; Chromium ce l'ha dalla 102) l'attributo resta comunque scritto —
 * costa nulla e diventa attivo il giorno in cui il browser si aggiorna — e si
 * affianca `aria-hidden="true"`, che almeno lo screen reader onora. Il ripiego NON
 * si applica dove `inert` esiste: `aria-hidden` su un sottoalbero ancora focusabile
 * sarebbe la violazione `aria-hidden-focus`, e lì il sottoalbero focusabile non
 * c'è più. Lo stato ORIGINALE di entrambi gli attributi si ricorda e si ripristina:
 * un nodo può essere già `inert`, o già `aria-hidden` perché decorativo, e non gli
 * si tocca niente.
 */
const supportaInert = (): boolean =>
  typeof HTMLElement !== 'undefined' && 'inert' in HTMLElement.prototype

function rendiInerteFuoriDa(contenitore: HTMLElement): () => void {
  const marcati: HTMLElement[] = []
  const ripiego = !supportaInert()
  let nodo: HTMLElement = contenitore
  while (nodo !== document.body && nodo.parentElement) {
    for (const fratello of Array.from(nodo.parentElement.children)) {
      if (fratello === nodo || fratello.nodeType !== 1) continue
      const el = fratello as HTMLElement
      const stato = inerti.get(el)
      if (stato) {
        stato.conteggio += 1
      } else {
        inerti.set(el, {
          conteggio: 1,
          aveaInert: el.hasAttribute('inert'),
          ariaHiddenOriginale: el.getAttribute('aria-hidden'),
        })
        el.setAttribute('inert', '')
        if (ripiego) el.setAttribute('aria-hidden', 'true')
      }
      marcati.push(el)
    }
    nodo = nodo.parentElement
  }

  return () => {
    for (const el of marcati) {
      const stato = inerti.get(el)
      if (!stato) continue
      stato.conteggio -= 1
      if (stato.conteggio > 0) continue
      inerti.delete(el)
      if (!stato.aveaInert) el.removeAttribute('inert')
      if (stato.ariaHiddenOriginale === null) el.removeAttribute('aria-hidden')
      else el.setAttribute('aria-hidden', stato.ariaHiddenOriginale)
    }
  }
}

/**
 * Un controllo entra nel giro del focus solo se è davvero a schermo.
 *
 * `querySelectorAll(FOCUSABLE)` restituisce anche i controlli di un ramo nascosto
 * (`display:none`, `visibility:hidden`, `[hidden]`): il focus-trap ci portava
 * sopra il fuoco e all'utente sembrava sparito. Si risale fino alla radice del
 * dialogo perché `display:none` NON si eredita: `getComputedStyle` sul figlio di
 * un ramo nascosto continua a rispondere `inline-block`.
 */
function visibile(el: HTMLElement, radice: HTMLElement): boolean {
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

interface ModalProps {
  open: boolean
  onClose: () => void
  /** Etichetta accessibile del dialog (usata come aria-label se non c'è labelledBy). */
  title: string
  labelledBy?: string
  closeOnBackdrop?: boolean
  className?: string
  /** Stile inline del pannello dialog (es. box-shadow fluttuante). Retrocompatibile: opzionale. */
  style?: React.CSSProperties
  /**
   * Fallback per il ripristino del focus alla chiusura (WCAG 2.4.3). Serve quando il
   * dialog è aperto da un handler async il cui trigger era `disabled` durante la POST:
   * a quell'istante `document.activeElement` è già `<body>`, quindi il capture di
   * `previouslyFocused` perde il bottone. Se fornito, alla chiusura si torna a
   * `returnFocusRef.current` invece che a `<body>`. Retrocompatibile: opzionale.
   */
  returnFocusRef?: React.RefObject<HTMLButtonElement | null>
  children: React.ReactNode
}

/**
 * Primitive modale accessibile (WCAG): role="dialog" + aria-modal, focus-trap
 * (Tab/Shift+Tab ciclici), chiusura con Escape, scroll-lock del body, sfondo reso
 * `inert`, tasto Indietro di Android che chiude invece di navigare e ripristino
 * del focus al trigger alla chiusura. Regge i dialoghi annidati (stack). Nessuna
 * nuova dipendenza. I modali esistenti vi migrano incrementalmente.
 *
 * IL VELO È UN FRATELLO DEL DIALOGO, NON UN SUO ANTENATO. Non è un dettaglio di
 * stile: sulla WebView Chromium di Android un antenato con `backdrop-filter`
 * CANCELLA l'intero sottoalbero dall'albero di accessibilità. Col velo sul
 * contenitore, `uiautomator dump` con la modale a schermo restituiva 120 nodi e
 * nessuno era della modale — per TalkBack la finestra non esisteva, e valeva per
 * tutti e 15 i componenti che usano questa primitiva. Il modello corretto era già
 * nel repo: `AdminMenuSheet`, che mette il blur su un div fratello `aria-hidden`
 * ed è regolarmente esposto. Il `relative` sul dialogo serve a farlo dipingere
 * SOPRA il velo (che è `absolute` e viene prima in ordine di documento): senza,
 * il velo se lo mangerebbe insieme a tutti i suoi click.
 */
export function Modal({ open, onClose, title, labelledBy, closeOnBackdrop = true, className, style, returnFocusRef, children }: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const contenitoreRef = useRef<HTMLDivElement>(null)
  const previouslyFocused = useRef<HTMLElement | null>(null)
  // Id stabile per istanza + onClose via ref: l'effetto dipende solo da `open`,
  // così un handler inline (`onClose={() => …}`, ricreato a ogni render) non
  // fa ripartire l'effetto rubando il focus al primo controllo a ogni render.
  const idRef = useRef<symbol | null>(null)
  if (idRef.current === null) idRef.current = Symbol('modal')
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  })
  // Ref «sempre aggiornata» al fallback di ripristino focus: tenuta fuori dalle
  // deps dell'effetto (che restano `[open]`) esattamente come `onCloseRef`, così
  // un nuovo oggetto ref a ogni render non fa ripartire l'effetto e non ruba il focus.
  const returnFocusRefLatest = useRef(returnFocusRef)
  useEffect(() => {
    returnFocusRefLatest.current = returnFocusRef
  })

  // Il tasto Indietro fisico di Android chiude la modale invece di navigare via.
  // Una riga qui copre i 15 consumatori della primitiva: prima, con «Nuovo avviso»
  // aperto e mezza bozza scritta, un Indietro distratto portava alla dashboard e
  // cancellava il testo. Nel browser è inerte per costruzione — l'unico che legge
  // il registro è il gestore `backButton` della shell nativa.
  useOverlayIndietro(open, onClose)

  useEffect(() => {
    if (!open) return
    const myId = idRef.current as symbol
    modalStack.push(myId)
    previouslyFocused.current = (document.activeElement as HTMLElement) ?? null

    const isTop = () => modalStack[modalStack.length - 1] === myId
    const radice = dialogRef.current
    const focusables = () =>
      Array.from(radice?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter((el) =>
        radice ? visibile(el, radice) : true,
      )
    focusables()[0]?.focus()

    function onKeyDown(e: KeyboardEvent) {
      if (!isTop()) return
      if (e.key === 'Escape') {
        e.stopPropagation()
        onCloseRef.current()
        return
      }
      if (e.key === 'Tab') {
        const list = focusables()
        if (list.length === 0) {
          e.preventDefault()
          return
        }
        const first = list[0]
        const last = list[list.length - 1]
        // Il focus può essere GIÀ uscito dal dialogo senza passare da un Tab: succede
        // ogni volta che si preme un bottone che si disabilita durante la POST (es.
        // «Pubblica avviso»), perché `document.activeElement` diventa `<body>`. Da lì
        // nessuno dei due rami sotto scatterebbe e il Tab successivo portava
        // sull'intestazione della pagina retrostante. Si rientra e basta.
        if (!radice || !radice.contains(document.activeElement)) {
          e.preventDefault()
          first.focus()
          return
        }
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }

    document.addEventListener('keydown', onKeyDown)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const ripristinaInerzia = contenitoreRef.current
      ? rendiInerteFuoriDa(contenitoreRef.current)
      : () => {}

    return () => {
      document.removeEventListener('keydown', onKeyDown)
      const idx = modalStack.lastIndexOf(myId)
      if (idx !== -1) modalStack.splice(idx, 1)
      // Sblocca lo scroll solo quando non resta alcun modale aperto.
      document.body.style.overflow = modalStack.length === 0 ? prevOverflow : 'hidden'
      // L'inerzia si toglie PRIMA di restituire il focus: un elemento `inert` non
      // può riceverlo, e il ripristino WCAG 2.4.3 fallirebbe in silenzio.
      ripristinaInerzia()
      // Ripristino del focus (WCAG 2.4.3). Caso normale: torna a `previouslyFocused`.
      // Caso degradato (dialog aperto da handler async col trigger `disabled`): al
      // capture activeElement era già `<body>`, quindi torna al `returnFocusRef` se dato.
      const prev = previouslyFocused.current
      const fallback = returnFocusRefLatest.current?.current ?? null
      const target = fallback && (!prev || prev === document.body) ? fallback : prev
      target?.focus()
    }
  }, [open])

  if (!open) return null

  return (
    <div
      ref={contenitoreRef}
      // z-[120]: sopra TUTTO il chrome del cockpit — topbar admin e sidebar sono
      // `z-[105]`, il foglio «Menu» `z-[110]`. A `z-[80]` la barra verde si mangiava
      // la fascia in cui la primitiva disegna intestazione e ✕: su iPhone il tap
      // sulla chiusura colpiva la campanella delle notifiche.
      className="fixed inset-0 z-[120] flex items-center justify-center p-4"
      // La chiusura al click fuori si decide sul DIALOGO, non sull'identità del
      // bersaglio: col velo diventato un fratello, `e.target` è il velo e non più
      // il contenitore. La regola «il gesto è cominciato fuori dal dialogo» resta
      // valida qualunque cosa si aggiunga accanto, e non chiude quando si seleziona
      // testo trascinando da dentro a fuori.
      onMouseDown={(e) => {
        if (closeOnBackdrop && !dialogRef.current?.contains(e.target as Node)) onClose()
      }}
    >
      {/* Il velo: fratello del dialogo e `aria-hidden`, così la sfocatura non
          cancella la modale dall'albero di accessibilità di Android. Colore dal
          token, non dall'hex cablato. */}
      <div
        aria-hidden="true"
        className="absolute inset-0"
        style={{
          background: 'color-mix(in srgb, var(--color-kidville-green) 30%, transparent)',
          backdropFilter: 'blur(8px)',
        }}
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={labelledBy ? undefined : title}
        aria-labelledby={labelledBy}
        className={className ? `relative ${className}` : 'relative'}
        style={style}
      >
        {children}
      </div>
    </div>
  )
}
