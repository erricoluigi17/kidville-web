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
 *
 * Lo SCHEME è tollerato case-insensitive: la tastiera soft Android capitalizza la
 * prima lettera del campo URL nel cockpit (`Https://…`), e un permalink altrimenti
 * valido non deve essere rifiutato per una «H» maiuscola (collaudo ciclo 1, mobile).
 * Lo SHORTCODE, che è identità, resta case-sensitive: si normalizza SOLO lo scheme.
 */
export function parseInstagramUrl(url: string): string | null {
  if (typeof url !== 'string') return null
  const grezzo = url.trim()
  const normalizzato = grezzo.replace(/^https?:\/\//i, (m) => m.toLowerCase())
  const m = /^https?:\/\/(?:www\.)?instagram\.com\/(?:[^/]+\/)?(?:p|reel|tv)\/([A-Za-z0-9_-]{5,32})/.exec(normalizzato)
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
 * il post: si nasconderebbe un contenuto vivo).
 *
 * REALTÀ SERVER-SIDE (collaudo ciclo 1, categoria debug — vedi
 * __tests__/fixtures/instagram/README.md e le fixture reali):
 * da un IP datacenter senza sessione l'endpoint embed risponde SEMPRE `200` con
 * l'interstiziale consent/login di Meta, IDENTICO per un post vivo e per uno
 * inesistente. Perciò:
 *   · i marker `ok` NON possono essere quelli generici di Meta (immagini dal CDN,
 *     og:image, class Embed): erano presenti anche nella pagina consent → un post
 *     inesistente veniva giudicato `ok`, il contatore azzerato, la soglia `≥2` mai
 *     raggiunta → auto-nascondimento inerte. Ora `ok` richiede marker SPECIFICI
 *     dell'embed realmente renderizzato (immagine media dell'embed, blockquote
 *     captioned/permalink, caption), assenti dall'interstiziale consent;
 *   · l'interstiziale consent → `indeterminato` (cade nel default): MAI `ok`,
 *     MAI `fallito`. Non azzera né incrementa il contatore, aggiorna solo il
 *     timestamp di controllo. L'auto-nascondimento è quindi best-effort (certo solo
 *     su un vero `404`); la via primaria per un IG morto è il ritiro manuale.
 * Solo un 404 o un corpo che dichiara la pagina rimossa/privata valgono 'fallito'.
 */
export function esitoHealthCheck(body: string, status: number): EsitoCheck {
  if (status === 429 || status === 403) return 'indeterminato'
  if (status >= 500) return 'indeterminato'
  // 404: unico segnale di rimozione affidabile server-side (l'interstiziale consent
  // torna 200 anche per un post vivo, quindi il 200 non conclude mai da solo).
  if (status === 404) return 'fallito'
  if (status < 200 || status >= 300) return 'indeterminato'

  const b = body ?? ''
  // Marker REALI di una pagina embed rimossa/privata (se IG li servisse).
  if (/isn['’]?t available|non è disponibile|content unavailable|page unavailable|EmbedIsBroken|removedContent/i.test(b)) {
    return 'fallito'
  }
  // Marker SPECIFICI dell'embed REALMENTE renderizzato — assenti dall'interstiziale
  // consent che un fetch anonimo da datacenter riceve sempre. Niente marker generici
  // di Meta: erano soddisfatti anche dal consent (vedi il commento sopra).
  if (/EmbeddedMediaImage|data-instgrm-captioned|data-instgrm-permalink|class="Caption/i.test(b)) {
    return 'ok'
  }
  // 2xx senza marker riconoscibili (incluso l'interstiziale consent): non si conclude.
  return 'indeterminato'
}
