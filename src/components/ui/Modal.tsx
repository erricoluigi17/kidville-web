'use client'

import { useEffect, useRef } from 'react'

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

// Stack degli id dei Modal aperti: SOLO il Modal in cima gestisce Escape e il
// focus-trap. Senza questo, due dialoghi annidati (entrambi in ascolto su
// `document`) si chiuderebbero a vicenda con un solo Escape e si contenderebbero
// il focus. `stopPropagation()` non basta: i listener sono sullo stesso target.
const modalStack: symbol[] = []

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
 * (Tab/Shift+Tab ciclici), chiusura con Escape, scroll-lock del body e ripristino
 * del focus al trigger alla chiusura. Regge i dialoghi annidati (stack). Nessuna
 * nuova dipendenza. I modali esistenti vi migrano incrementalmente.
 */
export function Modal({ open, onClose, title, labelledBy, closeOnBackdrop = true, className, style, returnFocusRef, children }: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null)
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

  useEffect(() => {
    if (!open) return
    const myId = idRef.current as symbol
    modalStack.push(myId)
    previouslyFocused.current = (document.activeElement as HTMLElement) ?? null

    const isTop = () => modalStack[modalStack.length - 1] === myId
    const focusables = () => Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])
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

    return () => {
      document.removeEventListener('keydown', onKeyDown)
      const idx = modalStack.lastIndexOf(myId)
      if (idx !== -1) modalStack.splice(idx, 1)
      // Sblocca lo scroll solo quando non resta alcun modale aperto.
      document.body.style.overflow = modalStack.length === 0 ? prevOverflow : 'hidden'
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
      className="fixed inset-0 z-[80] flex items-center justify-center p-4"
      style={{ background: 'rgba(0,106,95,0.30)', backdropFilter: 'blur(8px)' }}
      onMouseDown={(e) => {
        if (closeOnBackdrop && e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={labelledBy ? undefined : title}
        aria-labelledby={labelledBy}
        className={className}
        style={style}
      >
        {children}
      </div>
    </div>
  )
}
