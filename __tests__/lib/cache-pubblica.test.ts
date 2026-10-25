// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { intestazioniCachePubblica } from '@/lib/security/cache-pubblica'

/**
 * Le intestazioni di cache delle tre letture pubbliche: `/api/iscrizione/sedi`, `/api/iscrizione/model`,
 * `/api/anagrafiche/comuni`. Sessione 13: la CDN di Vercel non conservava le risposte (il 20/10 MISS 23 su 23),
 * e la correzione cambia SOLO questa funzione.
 */
const richiesta = (cookie?: string) =>
  new Request('http://localhost/api/iscrizione/sedi', cookie ? { headers: { cookie } } : undefined)

describe('intestazioniCachePubblica', () => {
  it('senza sessione: public con s-maxage, e la stessa durata dichiarata alla CDN di Vercel', () => {
    expect(intestazioniCachePubblica(richiesta(), 600, 3600)).toEqual({
      'Cache-Control': 'public, max-age=600, s-maxage=600, stale-while-revalidate=3600',
      'Vercel-CDN-Cache-Control': 'max-age=600, stale-while-revalidate=3600',
      Vary: 'Cookie',
    })
  })

  it('con il cookie di sessione Supabase: private, nessuna istruzione per una cache condivisa', () => {
    expect(intestazioniCachePubblica(richiesta('sb-progetto-auth-token=valore-finto'), 600, 3600)).toEqual({
      'Cache-Control': 'private, max-age=600, stale-while-revalidate=3600',
      Vary: 'Cookie',
    })
  })

  it('il cookie della protezione delle anteprime (`_vercel_jwt`) non è una sessione: resta public', () => {
    const intestazioni = intestazioniCachePubblica(richiesta('_vercel_jwt=finto'), 600, 3600)
    expect(intestazioni['Cache-Control']).toMatch(/^public, /)
  })

  // La rete della privacy, qualunque prova della diagnosi del MISS entri o esca (Compiti 13-14): con una
  // sessione in corso il middleware può attaccare un `Set-Cookie` alla risposta, e una cache condivisa che la
  // conservasse lo riservirebbe a chiunque. Quindi su questa strada niente `public`, niente `s-maxage`, e
  // nessuna intestazione che parli a una CDN (`CDN-Cache-Control`, `Vercel-CDN-Cache-Control`, `Surrogate-Control`).
  it.each([
    'sb-progetto-auth-token=valore-finto',
    'sb-progetto-auth-token.0=pezzo-finto; sb-progetto-auth-token.1=pezzo-finto',
    '_vercel_jwt=finto; sb-progetto-auth-token=valore-finto; tema=scuro',
  ])('con sessione (%s): nessuna istruzione alla CDN, mai public', (cookie) => {
    const intestazioni = intestazioniCachePubblica(richiesta(cookie), 600, 3600)
    const perLaCdn = Object.keys(intestazioni).filter((nome) => /cdn-cache-control|surrogate-control/i.test(nome))
    expect(perLaCdn, 'la strada con sessione parla a una cache condivisa').toEqual([])
    const tutte = Object.values(intestazioni).join(' | ')
    expect(tutte).not.toMatch(/\bpublic\b/)
    expect(tutte).not.toMatch(/s-maxage/)
    expect(intestazioni['Cache-Control']).toMatch(/^private, /)
  })
})
