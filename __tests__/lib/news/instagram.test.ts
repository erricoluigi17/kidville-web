import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { parseInstagramUrl, buildEmbedUrl, esitoHealthCheck } from '@/lib/news/instagram'

// =============================================================================
// Parsing degli URL Instagram (estrazione shortcode) e valutazione PURA
// dell'health-check.
//
// Le fixture di `esitoHealthCheck` NON sono più inventate: sono i corpi REALI
// dell'endpoint embed, catturati col meccanismo di produzione (fetch nudo, IP
// datacenter, nessuna sessione) — vedi __tests__/fixtures/instagram/README.md.
// La realtà server-side è un 200 con l'interstiziale consent/login di Meta,
// IDENTICO per un post vivo e per uno inesistente: il collaudo del ciclo 1
// (debug) ha dimostrato che la vecchia catena «health-check → nascondi» era
// inerte perché i marker `ok` (cdninstagram/class="Embed") erano soddisfatti
// anche dalla pagina consent.
//
// Regole della valutazione:
//  - interstiziale consent (vivo o inesistente) → 'indeterminato', MAI 'ok';
//  - 'ok' SOLO con marker specifici dell'embed realmente renderizzato;
//  - 'fallito' SOLO su 404 o marker REALI di rimozione/pagina privata;
//  - 429/403/5xx → 'indeterminato' (non è colpa del post: a 2 'fallito'
//    consecutivi il post verrebbe nascosto).
// =============================================================================

function fixture(nome: string): string {
  return readFileSync(path.join(process.cwd(), '__tests__', 'fixtures', 'instagram', nome), 'utf8')
}

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

  it('accetta lo scheme case-insensitive (Https:// dalla tastiera soft Android che capitalizza)', () => {
    expect(parseInstagramUrl('Https://www.instagram.com/p/CabcdEfghij/')).toBe('CabcdEfghij')
    expect(parseInstagramUrl('HTTPS://www.instagram.com/reel/Xy12_ab-cd/')).toBe('Xy12_ab-cd')
  })

  it('lo shortcode resta case-sensitive (non si tocca la parte identificativa)', () => {
    // Uno shortcode è identità: nessuna normalizzazione di maiuscole/minuscole.
    expect(parseInstagramUrl('https://www.instagram.com/p/CabcdEfghij/')).toBe('CabcdEfghij')
    expect(parseInstagramUrl('https://www.instagram.com/p/CABCDEFGHIJ/')).toBe('CABCDEFGHIJ')
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

describe('esitoHealthCheck — su fixture REALI dell\'endpoint embed', () => {
  const consentInesistente = fixture('embed-inesistente-200-consent.html')
  const consentVivo = fixture('embed-vivo-200-consent.html')

  // Marker specifici dell'embed REALMENTE renderizzato: non ottenibili server-side
  // dietro il muro consent, quindi corpo di prova minimale (dichiarato sintetico).
  const bodyEmbedRenderizzato =
    '<html><body><div class="EmbeddedMediaImage" style="background-image:url(https://x.jpg)"></div>' +
    '<div class="Caption">didascalia del post</div></body></html>'
  // Marker REALI di pagina rimossa/privata (se Instagram li servisse).
  const bodyRimosso =
    '<html><body><div class="EmbedIsBroken"><p>Sorry, this page isn\'t available.</p></div></body></html>'

  it('CONSENT su shortcode INESISTENTE (200) → indeterminato, MAI ok', () => {
    // Il cuore del fix: il post inesistente NON deve mai risultare `ok`.
    expect(esitoHealthCheck(consentInesistente, 200)).toBe('indeterminato')
    expect(esitoHealthCheck(consentInesistente, 200)).not.toBe('ok')
  })

  it('CONSENT su shortcode VIVO (200) → indeterminato: indistinguibile dall\'inesistente', () => {
    expect(esitoHealthCheck(consentVivo, 200)).toBe('indeterminato')
    expect(esitoHealthCheck(consentVivo, 200)).not.toBe('ok')
  })

  it('vivo e inesistente danno lo STESSO esito (indistinguibili da datacenter)', () => {
    expect(esitoHealthCheck(consentVivo, 200)).toBe(esitoHealthCheck(consentInesistente, 200))
  })

  it('embed REALMENTE renderizzato (marker specifici) → ok', () => {
    expect(esitoHealthCheck(bodyEmbedRenderizzato, 200)).toBe('ok')
  })

  it('pagina rimossa/privata con marker reali (200) → fallito', () => {
    expect(esitoHealthCheck(bodyRimosso, 200)).toBe('fallito')
  })

  it('status 404 → fallito (unico segnale di rimozione affidabile server-side)', () => {
    expect(esitoHealthCheck('', 404)).toBe('fallito')
    // Anche col corpo consent, un 404 conclusivo è `fallito`.
    expect(esitoHealthCheck(consentInesistente, 404)).toBe('fallito')
  })

  it('status 429 (rate limit) → indeterminato: NON incrementa i falliti', () => {
    expect(esitoHealthCheck(consentVivo, 429)).toBe('indeterminato')
    expect(esitoHealthCheck('', 429)).toBe('indeterminato')
  })

  it('status 403 → indeterminato', () => {
    expect(esitoHealthCheck('', 403)).toBe('indeterminato')
    expect(esitoHealthCheck(consentInesistente, 403)).toBe('indeterminato')
  })

  it('status 5xx → indeterminato', () => {
    expect(esitoHealthCheck('', 503)).toBe('indeterminato')
  })

  it('corpo vuoto su 200 (stream già consumato) → indeterminato, mai ok/fallito', () => {
    expect(esitoHealthCheck('', 200)).toBe('indeterminato')
  })
})
