'use client'

import { useCallback } from 'react'
import { fotocameraNativaDisponibile, scegliFotoNativa } from '@/lib/native/camera'

// Hook condiviso per gli upload immagine: incapsula «se nativo apri la
// fotocamera Capacitor, altrimenti clicca l'<input type=file>». I file scelti
// (dalla fotocamera O, sul web, dall'input) confluiscono nello STESSO handler,
// così il flusso di upload resta identico.

export interface UseImagePickerOptions {
  /** Ref all'<input type=file> nascosto usato sul web. */
  inputRef: React.RefObject<HTMLInputElement | null>
  /** Riceve i File scelti sul NATIVO (dalla fotocamera). Sul web li riceve l'input. */
  onFiles: (files: File[]) => void
  /** Coerenza con `multiple` dell'input (la fotocamera resta comunque 1 scatto). */
  multiplo?: boolean
}

export function useImagePicker({ inputRef, onFiles, multiplo = false }: UseImagePickerOptions) {
  const apri = useCallback(async () => {
    if (fotocameraNativaDisponibile()) {
      const files = await scegliFotoNativa({ multiplo })
      if (files.length > 0) onFiles(files)
      return
    }
    inputRef.current?.click()
  }, [inputRef, onFiles, multiplo])

  return { apri }
}
