'use client'

import { isNativeApp } from '@/lib/push/native-register'

// Condivisione nativa (Capacitor Share) con degradazione pulita sul web:
//  1. Nativo  → foglio di condivisione di sistema (@capacitor/share)
//  2. Web con Web Share API → navigator.share (sheet di sistema mobile/desktop)
//  3. Web senza Web Share → copia negli appunti (clipboard.writeText)
// L'annullamento da parte dell'utente (AbortError) è normale, non un errore:
// try/catch silenzioso (UX attesa), mai un log.

export interface CondivisioneInput {
  title?: string
  text?: string
  url?: string
}

export async function condividi(input: CondivisioneInput): Promise<void> {
  // 1. Nativo: plugin Capacitor.
  if (isNativeApp()) {
    try {
      const { Share } = await import('@capacitor/share')
      await Share.share(input)
    } catch {
      // annullamento utente o plugin assente: silenzioso
    }
    return
  }

  // 2. Web con Web Share API.
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
      await navigator.share(input)
      return
    }
    // 3. Fallback: copia negli appunti l'URL (o, in mancanza, il testo).
    const testo = input.url || input.text || ''
    if (
      testo &&
      typeof navigator !== 'undefined' &&
      typeof navigator.clipboard?.writeText === 'function'
    ) {
      await navigator.clipboard.writeText(testo)
    }
  } catch {
    // annullamento (AbortError) o clipboard non concessa: silenzioso
  }
}
