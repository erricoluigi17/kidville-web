// =============================================================================
// Utility Instagram (PURE): parsing dello shortcode dall'URL, costruzione
// dell'URL di embed, e valutazione dell'esito dell'health-check su corpo+status.
// Il fetch vero (via externalFetch('instagram', …)) sta nelle route, non qui:
// così queste funzioni restano testabili senza rete.
// =============================================================================

/**
 * Estrae lo shortcode da un URL Instagram di post/reel/tv. Accetta www o meno,
 * un eventuale username nel path, e query string. Ritorna null se l'URL non è un
 * permalink Instagram valido (shortcode 5-32 caratteri [A-Za-z0-9_-]).
 */
export function parseInstagramUrl(url: string): string | null {
  if (typeof url !== 'string') return null
  const m = /^https?:\/\/(?:www\.)?instagram\.com\/(?:[^/]+\/)?(?:p|reel|tv)\/([A-Za-z0-9_-]{5,32})/.exec(url.trim())
  return m ? m[1] : null
}

/** URL di embed «captioned» ufficiale per lo shortcode dato. */
export function buildEmbedUrl(shortcode: string): string {
  return `https://www.instagram.com/p/${shortcode}/embed/captioned/`
}

export type EsitoCheck = 'ok' | 'fallito' | 'indeterminato'

/**
 * Valuta l'esito di un health-check dell'embed Instagram — PURA, su corpo+status.
 *
 * REGOLA CARDINE: un 429/403 (rate limit / blocco lato IG) o un 5xx NON sono
 * colpa del post → 'indeterminato', mai 'fallito' (che a 2 consecutivi nasconde
 * il post: si nasconderebbe un contenuto vivo). Solo un 404 o un corpo che
 * dichiara la pagina rimossa/privata valgono 'fallito'.
 */
export function esitoHealthCheck(body: string, status: number): EsitoCheck {
  if (status === 429 || status === 403) return 'indeterminato'
  if (status >= 500) return 'indeterminato'
  if (status === 404) return 'fallito'
  if (status < 200 || status >= 300) return 'indeterminato'

  const b = body ?? ''
  // Marker canonici di una pagina embed non più disponibile (rimossa/privata).
  if (/isn['’]?t available|non è disponibile|content unavailable|page unavailable|EmbedIsBroken|removedContent/i.test(b)) {
    return 'fallito'
  }
  // Marker di una pagina viva: l'embed porta un'immagine dal CDN o il contenitore media.
  if (/EmbeddedMedia|og:image|cdninstagram|data-instgrm|class="Embed/i.test(b)) {
    return 'ok'
  }
  // 2xx senza marker riconoscibili: non si conclude (evita falsi positivi).
  return 'indeterminato'
}
