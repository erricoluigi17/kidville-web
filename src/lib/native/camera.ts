'use client'

import { isNativeApp } from '@/lib/push/native-register'

// Fotocamera NATIVA (Capacitor Camera) per gli upload immagine, con degradazione
// pulita sul web:
//  - Web/SSR → `scegliFotoNativa` ritorna [] e il chiamante ricade sull'<input
//    type=file> di sempre (nessuna differenza per l'utente web).
//  - Nativo  → `Camera.getPhoto({ source: 'PROMPT' })` chiede all'utente se
//    scattare una foto o sceglierne una dalla libreria, poi converte il dataUrl
//    in un `File` uguale a quello che darebbe `e.target.files[0]`.
// L'annullamento da parte dell'utente è UX ATTESA, non un errore: try/catch
// silenzioso, nessun log (stesso principio di `@/lib/native/share`).

/** true se l'app gira nella shell nativa Capacitor (delega a isNativeApp). */
export function fotocameraNativaDisponibile(): boolean {
  return isNativeApp()
}

/**
 * Apre la fotocamera/libreria nativa e ritorna i file scelti come `File[]`.
 * Su web (o su annullamento/errore) ritorna `[]`: il chiamante userà l'input.
 * `@capacitor/camera` produce UNA immagine per chiamata, quindi l'array ha al
 * più un elemento (il parametro `multiplo` è previsto per il futuro / coerenza
 * con l'input, ma la libreria non seleziona più foto in un colpo).
 */
export async function scegliFotoNativa(_opts?: { multiplo?: boolean }): Promise<File[]> {
  void _opts
  if (!fotocameraNativaDisponibile()) return []
  try {
    const { Camera, CameraResultType, CameraSource } = await import('@capacitor/camera')
    const photo = await Camera.getPhoto({
      resultType: CameraResultType.DataUrl,
      source: CameraSource.Prompt,
      quality: 80,
    })
    const dataUrl = photo?.dataUrl
    if (!dataUrl) return []
    const blob = await (await fetch(dataUrl)).blob()
    const file = new File([blob], `foto-${Date.now()}.jpg`, { type: blob.type || 'image/jpeg' })
    return [file]
  } catch {
    // Annullamento utente o plugin assente: silenzioso, è UX attesa.
    return []
  }
}
