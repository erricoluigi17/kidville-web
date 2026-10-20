/**
 * IL TIPO DI UN CERTIFICATO MEDICO CARICATO DAL GENITORE — fase 12 della robustezza (2026-10-19).
 *
 * Il bucket `certificati-medici` ammette solo PDF e immagini (`TIPI_BUCKET_CERTIFICATI`, gli
 * stessi della migrazione `*_registri_worm_permessi_vincoli_bucket.sql`). Fino al 19/10 non
 * ammetteva una lista, e la route spediva `file.type || 'application/octet-stream'`: con la lista
 * accesa, un file senza tipo (certi selettori di Android, «Tutti i file», qualche app di
 * scansione) sarebbe stato respinto dallo Storage con un 500. Qui quel file prende il tipo della
 * sua estensione; un tipo che il bucket non ammette si ferma prima, con un 415 che lo dice.
 *
 * L'HEIC dell'iPhone è un'immagine: passa (`image/*`), come fa già il selettore della pagina
 * (`accept=".pdf,image/*"`).
 */

/** I tipi che il bucket ammette, nella forma che lo Storage confronta (con il jolly). */
export const TIPI_BUCKET_CERTIFICATI = ['application/pdf', 'image/*'] as const

const DA_ESTENSIONE: Readonly<Record<string, string>> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  heic: 'image/heic',
  heif: 'image/heif',
}

/**
 * Il `contentType` da dare allo Storage, o `null` se il file non è un PDF né un'immagine.
 * `tipo` è `File.type` (può essere vuoto), `estensione` è già minuscola e senza il punto.
 */
export function tipoCertificato(tipo: string, estensione: string): string | null {
  const t = tipo.trim().toLowerCase().split(';')[0]
  if (t === 'application/pdf' || /^image\/[a-z0-9.+-]+$/.test(t)) return t
  if (t === '' || t === 'application/octet-stream') return DA_ESTENSIONE[estensione] ?? null
  return null
}
