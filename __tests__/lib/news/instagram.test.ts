import { describe, it, expect } from 'vitest'
import { parseInstagramUrl, buildEmbedUrl, esitoHealthCheck } from '@/lib/news/instagram'

// =============================================================================
// Parsing degli URL Instagram (estrazione shortcode) e valutazione PURA
// dell'health-check su fixture di corpi/status. Regola cardine: un 429/403
// generalizzato NON è un fallimento del post (rate limit / blocco lato IG) →
// 'indeterminato', mai 'fallito' (che a 2 consecutivi nasconde il post).
// =============================================================================

describe('parseInstagramUrl', () => {
  it('estrae lo shortcode da un /p/ con www', () => {
    expect(parseInstagramUrl('https://www.instagram.com/p/CabcdEfghij/')).toBe('CabcdEfghij')
  })

  it('estrae lo shortcode da un /reel/ senza www e con trattini/underscore', () => {
    expect(parseInstagramUrl('https://instagram.com/reel/Xy12_ab-cd/')).toBe('Xy12_ab-cd')
  })

  it('estrae lo shortcode da un /tv/', () => {
    expect(parseInstagramUrl('https://www.instagram.com/tv/ABCDE/')).toBe('ABCDE')
  })

  it('estrae lo shortcode con username nel path e query string', () => {
    expect(parseInstagramUrl('https://www.instagram.com/kidville/p/CabcdEfghij/?utm_source=x')).toBe('CabcdEfghij')
  })

  it('rifiuta un dominio diverso', () => {
    expect(parseInstagramUrl('https://example.com/p/CabcdEfghij/')).toBeNull()
  })

  it('rifiuta uno shortcode troppo corto', () => {
    expect(parseInstagramUrl('https://www.instagram.com/p/abc/')).toBeNull()
  })

  it('rifiuta un URL javascript:', () => {
    expect(parseInstagramUrl('javascript:alert(1)')).toBeNull()
  })

  it('rifiuta un profilo senza /p|reel|tv/', () => {
    expect(parseInstagramUrl('https://www.instagram.com/kidville/')).toBeNull()
  })
})

describe('buildEmbedUrl', () => {
  it('compone l\'URL embed captioned dallo shortcode', () => {
    expect(buildEmbedUrl('CabcdEfghij')).toBe('https://www.instagram.com/p/CabcdEfghij/embed/captioned/')
  })
})

describe('esitoHealthCheck', () => {
  const bodyVivo = '<html><head><meta property="og:image" content="https://scontent.cdninstagram.com/x.jpg"></head><body><div class="EmbeddedMediaImage"></div></body></html>'
  const bodyRimosso = '<html><body><div class="EmbedIsBroken"><p>Sorry, this page isn\'t available.</p></div></body></html>'

  it('pagina viva (200) → ok', () => {
    expect(esitoHealthCheck(bodyVivo, 200)).toBe('ok')
  })

  it('pagina rimossa/privata (200) → fallito', () => {
    expect(esitoHealthCheck(bodyRimosso, 200)).toBe('fallito')
  })

  it('status 429 → indeterminato (non incrementa i falliti)', () => {
    expect(esitoHealthCheck(bodyVivo, 429)).toBe('indeterminato')
    expect(esitoHealthCheck('', 429)).toBe('indeterminato')
  })

  it('status 403 → indeterminato', () => {
    expect(esitoHealthCheck('', 403)).toBe('indeterminato')
  })

  it('status 404 → fallito', () => {
    expect(esitoHealthCheck('', 404)).toBe('fallito')
  })

  it('status 5xx → indeterminato', () => {
    expect(esitoHealthCheck('', 503)).toBe('indeterminato')
  })
})
