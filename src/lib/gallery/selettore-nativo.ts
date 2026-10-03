import { logClient } from '@/lib/logging/client'
import { codiceDelPonte, leggiFoto, scartaScelti } from '@/lib/native/caricamenti-nativi'
import type { ElementoFotoScelta, ElementoVideoScelto } from '@/lib/native/caricamenti-nativi-tipi'
import { nomeFotoJpeg, type ElementoCaricabile } from './selettore-media'

/**
 * IL CONFINE FRA LA GALLERIA E IL PLUGIN, per il passo «scelta» (app 1.2, spec «caricamenti nativi»
 * §7.2-§7.3): le tre cose che `MediaUploader` e la pagina devono chiedere al ponte quando un elemento
 * scelto dal selettore nativo cambia di mano.
 *
 *  · `elementoCaricabileDaVideo` — un video preparato dal plugin diventa un elemento della schermata;
 *  · `leggiFotoComeFile` — una foto preparata (già ridotta, senza EXIF né GPS) diventa un `File`
 *    JPEG, che da lì in poi segue il percorso foto di sempre (`addFiles`, coda offline, watermark);
 *  · `scartaPreparatiNativi` — gli elementi che nessuno porterà più avanti (tolti con la X, «Annulla»,
 *    smontaggio, oltre il tetto) si cancellano dal telefono: un video preparato è una COPIA da fino a
 *    2 GB, e lasciarla lì «tanto la pulizia la toglie» vuol dire tenere un gigabyte di un bambino
 *    fino al prossimo avvio del motore.
 *
 * ─── PERCHÉ IL PLUGIN SI USA SOLO ATTRAVERSO `caricamenti-nativi.ts` ──────────────────────────────
 * Il plugin è un `Proxy`: una promise che si risolve con lui resta appesa (guasto di #166 → #168).
 * Qui si chiamano le sole funzioni tipizzate dell'involucro, che rileggono ogni risposta con zod e
 * traducono ogni rifiuto in un CODICE dell'elenco chiuso. Il rifiuto non porta mai il suo messaggio:
 * il messaggio di un errore di sistema può contenere il nome di un file, cioè di un bambino.
 *
 * ─── LOG ─────────────────────────────────────────────────────────────────────────────────────────
 * Evento `caricamento-nativo` (la stessa colonna del nativo), solo slug costanti e un codice
 * dell'elenco chiuso. Mai un nome di file, un percorso, un id di elemento: a un log serve sapere COSA
 * è andato storto, non QUALE foto di QUALE bambino. Nessuna funzione di qui lancia: un guasto del
 * ponte non deve far cadere la schermata che sta mostrando le anteprime.
 */

/** Un video preparato dal plugin come elemento della schermata. La miniatura fa da anteprima (vuota se manca). */
export function elementoCaricabileDaVideo(video: ElementoVideoScelto): ElementoCaricabile {
  return { file: null, preview: video.miniatura ?? '', nativo: video }
}

/**
 * Cancella dal telefono i preparati con questi identificativi. Mai lancia. Senza identificativi non
 * chiama il ponte (non c'è niente da fare); gli identificativi ripetuti contano una volta. Un rifiuto
 * si scrive come `selettore-nativo-scarto-fallito: <codice>` (warn): le copie restano finché la
 * pulizia del nativo non le toglie, che è un ritardo e non una perdita.
 *
 * Idempotente per costruzione: il nativo ignora un identificativo che non c'è più, e un video già
 * preso in carico da `accodaVideo` non sta più fra i preparati (il file è stato spostato).
 */
export async function scartaPreparatiNativi(ids: readonly string[]): Promise<void> {
  const unici = [...new Set(ids)]
  if (unici.length === 0) return
  try {
    await scartaScelti({ ids: unici })
  } catch (e) {
    logClient({
      livello: 'warn',
      evento: 'caricamento-nativo',
      messaggio: `selettore-nativo-scarto-fallito: ${codiceDelPonte(e)}`,
      campi: { n: unici.length },
    })
  }
}

/** I byte di un base64 standard. `atob` lancia su un carattere che non è base64: chi chiama lo traduce in un codice. */
function byteDaBase64(base64: string): Uint8Array<ArrayBuffer> {
  const binario = atob(base64)
  const byte = new Uint8Array(binario.length)
  for (let i = 0; i < binario.length; i++) byte[i] = binario.charCodeAt(i)
  return byte
}

/**
 * Legge una foto preparata e la rende un `File` JPEG (`<nome>.jpg`). UNA lettura sola: il nativo
 * cancella la foto appena la consegna, quindi una foto che qui non si legge è perduta — e si dice
 * (`foto-nativa-non-letta: <codice>`, error), con un `null` che chi chiama conta come «non leggibile».
 *
 * Il ponte rilegge la risposta con zod (il `byte` dichiarato deve essere esattamente ciò che il base64
 * rappresenta); un base64 che nonostante questo non si decodifica vale `RISPOSTA_NON_VALIDA`, lo stesso
 * codice di una risposta fuori forma.
 */
export async function leggiFotoComeFile(foto: ElementoFotoScelta): Promise<File | null> {
  let base64: string
  try {
    base64 = (await leggiFoto({ id: foto.id })).base64
  } catch (e) {
    scriviFotoNonLetta(codiceDelPonte(e))
    return null
  }
  try {
    return new File([byteDaBase64(base64)], nomeFotoJpeg(foto.nome), { type: 'image/jpeg' })
  } catch {
    scriviFotoNonLetta('RISPOSTA_NON_VALIDA')
    return null
  }
}

function scriviFotoNonLetta(codice: string): void {
  logClient({ livello: 'error', evento: 'caricamento-nativo', messaggio: `foto-nativa-non-letta: ${codice}` })
}
