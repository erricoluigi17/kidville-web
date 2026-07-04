'use client'

import { useEffect, useRef } from 'react'

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

interface ModalProps {
  open: boolean
  onClose: () => void
  /** Etichetta accessibile del dialog (usata come aria-label se non c'è labelledBy). */
  title: string
  labelledBy?: string
  closeOnBackdrop?: boolean
  className?: string
  children: React.ReactNode
}

/**
 * Primitive modale accessibile (WCAG): role="dialog" + aria-modal, focus-trap
 * (Tab/Shift+Tab ciclici), chiusura con Escape, scroll-lock del body e ripristino
 * del focus al trigger alla chiusura. Nessuna nuova dipendenza. I modali esistenti
 * vi migrano incrementalmente.
 */
export function Modal({ open, onClose, title, labelledBy, closeOnBackdrop = true, className, children }: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const previouslyFocused = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return
    previouslyFocused.current = (document.activeElement as HTMLElement) ?? null

    const focusables = () => Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])
    focusables()[0]?.focus()

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
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
      document.body.style.overflow = prevOverflow
      previouslyFocused.current?.focus()
    }
  }, [open, onClose])

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
      >
        {children}
      </div>
    </div>
  )
}
