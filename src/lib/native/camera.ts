'use client'

import { isNativeApp } from '@/lib/push/native-register'
import { logClient } from '@/lib/logging/client'

// Fotocamera NATIVA (Capacitor Camera) per gli upload immagine, con degradazione
// pulita sul web:
//  - Web/SSR → `scegliFotoNativa` ritorna [] e il chiamante ricade sull'<input
//    type=file> di sempre (nessuna differenza per l'utente web).
//  - Nativo  → `Camera.getPhoto({ source: 'PROMPT' })` chiede all'utente se
//    scattare una foto o sceglierne una dalla libreria, poi converte il dataUrl
//    in un `File` uguale a quello che darebbe `e.target.files[0]`.
// L'annullamento da parte dell'utente è UX ATTESA, non un errore: nessun log
// (stesso principio di `@/lib/native/share`). Un permesso negato invece NO —
// vedi `classifica`.
//
// Questo modulo è una LIB, non un componente: non può usare `useTranslations`.
// Le etichette del foglio nativo arrivano come PARAMETRO dai chiamanti
// (`ScattaFotoButton` e l'hook `useImagePicker`, che il contesto i18n ce l'hanno).
// Se non arrivano non si passa alcun `promptLabel*` e restano i default del
// plugin: la lib resta pura e i chiamanti storici non si rompono.

/** Etichette del foglio di scelta nativo (`promptLabelCancel` è solo iOS). */
export interface EtichettePicker {
  intestazione: string
  scatta: string
  libreria: string
  annulla: string
}

export interface OpzioniScatto {
  /** Coerenza con `multiple` dell'input: la fotocamera resta comunque 1 scatto. */
  multiplo?: boolean
  etichette?: EtichettePicker
  /** Chiamato quando NON è un annullamento dell'utente ma un problema vero. */
  onErrore?: (codice: 'permesso_negato' | 'errore') => void
}

/**
 * Lato lungo massimo dello scatto, in pixel.
 *
 * Senza questo limite il plugin restituiva la foto a piena risoluzione: 4-6 MB
 * per un sensore da 12 MP, cioè oltre il limite di body della funzione
 * serverless — l'upload falliva e nel fascicolo lo spinner restava appeso per
 * sempre, senza messaggio. 1600 px su un A4 sono circa 190 dpi: un PEI, un
 * certificato o uno scontrino restano perfettamente leggibili e il JPEG sta su
 * 250-500 KB. Se un documento risultasse illeggibile, il passo successivo è
 * 2048 (≈1 MB), che è ancora sotto i limiti.
 */
const LATO_MAX = 1600

/** true se l'app gira nella shell nativa Capacitor (delega a isNativeApp). */
export function fotocameraNativaDisponibile(): boolean {
  return isNativeApp()
}

/**
 * Distingue l'annullamento dell'utente da un problema vero.
 *
 * È un'EURISTICA sui messaggi del plugin, non un contratto: il default sicuro è
 * `errore`, così un caso non previsto viene segnalato invece che inghiottito.
 * Serve perché prima un unico `catch {}` rendeva «ho cambiato idea» e «l'app non
 * ha il permesso» indistinguibili, e il sintomo per l'utente era identico —
 * «premo e non succede niente».
 */
function classifica(err: unknown): 'annullato' | 'permesso_negato' | 'errore' {
  const m = err instanceof Error ? err.message : String(err ?? '')
  if (/cancel|canceled|cancelled|no image picked/i.test(m)) return 'annullato'
  if (/denied|permission|not authorized/i.test(m)) return 'permesso_negato'
  return 'errore'
}

/**
 * Apre la fotocamera/galleria native e restituisce i File scelti (0 o 1).
 * Non lancia mai: l'annullamento restituisce un array vuoto.
 */
export async function scegliFotoNativa(opts?: OpzioniScatto): Promise<File[]> {
  if (!fotocameraNativaDisponibile()) return []
  const etichette = opts?.etichette
  try {
    const { Camera, CameraResultType, CameraSource } = await import('@capacitor/camera')
    const photo = await Camera.getPhoto({
      resultType: CameraResultType.DataUrl,
      source: CameraSource.Prompt,
      quality: 80,
      width: LATO_MAX,
      height: LATO_MAX,
      // Raddrizza il documento E ri-codifica l'immagine: la ricodifica lascia
      // indietro l'EXIF originale, GPS compreso. Su una foto scattata dentro una
      // scuola la posizione è un dato che non ha motivo di viaggiare.
      correctOrientation: true,
      // La foto di un certificato medico non deve finire nel rullino del
      // docente, e da lì nel backup automatico di Google Foto / iCloud.
      saveToGallery: false,
      allowEditing: false,
      ...(etichette
        ? {
            promptLabelHeader: etichette.intestazione,
            promptLabelPicture: etichette.scatta,
            promptLabelPhoto: etichette.libreria,
            promptLabelCancel: etichette.annulla,
          }
        : {}),
    })
    const dataUrl = photo?.dataUrl
    if (!dataUrl) return []
    const blob = await (await fetch(dataUrl)).blob()
    const file = new File([blob], `foto-${Date.now()}.jpg`, { type: blob.type || 'image/jpeg' })
    return [file]
  } catch (err) {
    const causa = classifica(err)
    if (causa === 'annullato') return [] // UX attesa: nessun log
    // Nessun dato nel messaggio, solo il codice della causa: `logClient`
    // persiste in `app_log` per 30 giorni, quindi ciò che finisce qui è
    // interrogabile in SQL — un errore del plugin stampato per intero sarebbe
    // un leak peggiore di quello nel logcat.
    logClient({
      livello: 'error',
      evento: 'js',
      messaggio: causa === 'permesso_negato' ? 'fotocamera-permesso-negato' : 'fotocamera-errore',
    })
    opts?.onErrore?.(causa)
    return []
  }
}
