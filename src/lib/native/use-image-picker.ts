'use client'

import { useCallback } from 'react'
import { useTranslations } from 'next-intl'
import { fotocameraNativaDisponibile, scegliFotoNativa } from '@/lib/native/camera'
import type { CodiceFotocamera, SorgenteFoto } from '@/lib/native/camera'

// Hook condiviso per gli upload immagine: incapsula «se nativo apri la
// fotocamera Capacitor, altrimenti clicca l'<input type=file>». I file scelti
// (dalla fotocamera O, sul web, dall'input) confluiscono nello STESSO handler,
// così il flusso di upload resta identico.
//
// L'hook — a differenza della lib `camera.ts` — può usare `useTranslations`:
// così le etichette del foglio nativo si traducono per tutti i suoi consumatori
// (MediaUploader, NewsMediaUploader…) senza doverli toccare uno per uno.

export interface UseImagePickerOptions {
  /** Ref all'<input type=file> nascosto usato sul web. */
  inputRef: React.RefObject<HTMLInputElement | null>
  /** Riceve i File scelti sul NATIVO (dalla fotocamera). Sul web li riceve l'input. */
  onFiles: (files: File[]) => void
  /** Coerenza con `multiple` dell'input (la fotocamera resta comunque 1 scatto). */
  multiplo?: boolean
  /** Problema vero (permesso negato o errore), NON l'annullamento dell'utente. */
  onErrore?: (codice: 'permesso_negato' | 'errore', dettaglio?: CodiceFotocamera) => void
  /**
   * Il foglio nativo si è chiuso SENZA foto e SENZA errore: l'utente ha cambiato idea (o il plugin
   * non ha restituito l'immagine). Non è un guasto e `scegliFotoNativa` non lo logga, ma la galleria
   * vuole saperlo (spec video PR 2 §11.1: `annullato-fotocamera`) per non confondere «ho chiuso io»
   * con «non è mai arrivato niente». Sul web non scatta mai: lì `apri()` clicca l'`<input>`.
   */
  onAnnullato?: () => void
  /**
   * Da dove prende la foto il NATIVO: il foglio «scatta o scegli» di sempre (`'prompt'`, il
   * predefinito di `camera.ts`, e quello che vogliono la chat e i documenti) o la fotocamera diretta
   * (`'fotocamera'`). Non passarlo lascia tutto com'era: l'hook lo inoltra solo se c'è.
   */
  sorgente?: SorgenteFoto
  /** Lato lungo massimo dello scatto, in pixel. Non passarlo lascia il predefinito di `camera.ts`. */
  latoMassimo?: number
}

export function useImagePicker({
  inputRef,
  onFiles,
  multiplo = false,
  onErrore,
  onAnnullato,
  sorgente,
  latoMassimo,
}: UseImagePickerOptions) {
  const t = useTranslations('shared')

  const apri = useCallback(async () => {
    if (fotocameraNativaDisponibile()) {
      // `scegliFotoNativa` risponde `[]` sia all'annullamento sia all'errore: li separa solo
      // `onErrore`, che scatta (sincrono, prima del `return []`) per il guasto vero e MAI per
      // l'annullamento. Si intercetta senza toglierlo al chiamante.
      let conErrore = false
      const files = await scegliFotoNativa({
        multiplo,
        // Solo se richiesti: chi non li chiede (la chat, i documenti) chiama `scegliFotoNativa`
        // esattamente come prima, e il suo predefinito resta il foglio a 1600 px.
        ...(sorgente !== undefined ? { sorgente } : {}),
        ...(latoMassimo !== undefined ? { latoMassimo } : {}),
        onErrore: (codice, dettaglio) => {
          conErrore = true
          onErrore?.(codice, dettaglio)
        },
        etichette: {
          intestazione: t('cameraTitolo'),
          scatta: t('cameraScatta'),
          libreria: t('cameraLibreria'),
          annulla: t('cameraAnnulla'),
        },
      })
      if (files.length > 0) onFiles(files)
      else if (!conErrore) onAnnullato?.()
      return
    }
    inputRef.current?.click()
  }, [inputRef, onFiles, multiplo, onErrore, onAnnullato, sorgente, latoMassimo, t])

  return { apri }
}
