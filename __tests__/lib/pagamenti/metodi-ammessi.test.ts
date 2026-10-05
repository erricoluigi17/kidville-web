import { describe, it, expect } from 'vitest'
import {
  METODI_AMMESSI, normalizzaMetodiAmmessi, ammetteBonifico, ammetteContanti, soloUnMetodo, sonoTuttiIMetodi,
} from '@/lib/pagamenti/metodi-ammessi'
import { zMetodiAmmessi } from '@/lib/pagamenti/metodi-ammessi-zod'

describe('metodi ammessi', () => {
  it('assente, null, vuoto o tutto ignoto ⇒ entrambi (degradazione del DB non migrato)', () => {
    for (const raw of [undefined, null, [], ['pos'], 'contanti', 42]) {
      expect(normalizzaMetodiAmmessi(raw)).toEqual(['contanti', 'bonifico'])
    }
  })
  it('ordine canonico, duplicati e ignoti scartati', () => {
    expect(normalizzaMetodiAmmessi(['bonifico', 'contanti', 'bonifico', 'pos'])).toEqual(['contanti', 'bonifico'])
    expect(normalizzaMetodiAmmessi(['contanti'])).toEqual(['contanti'])
  })
  it('predicati', () => {
    expect(ammetteBonifico(['contanti'])).toBe(false)
    expect(ammetteBonifico(null)).toBe(true)
    expect(ammetteContanti(['bonifico'])).toBe(false)
    expect(soloUnMetodo(['contanti'])).toBe('contanti')
    expect(soloUnMetodo(['bonifico'])).toBe('bonifico')
    expect(soloUnMetodo(['contanti', 'bonifico'])).toBeNull()
    expect(sonoTuttiIMetodi(undefined)).toBe(true)
    expect(sonoTuttiIMetodi(['contanti'])).toBe(false)
    expect(METODI_AMMESSI).toEqual(['contanti', 'bonifico'])
  })
  it('zod: almeno uno, solo valori noti', () => {
    expect(zMetodiAmmessi.safeParse(['contanti']).success).toBe(true)
    expect(zMetodiAmmessi.safeParse([]).success).toBe(false)
    expect(zMetodiAmmessi.safeParse(['pos']).success).toBe(false)
    expect(zMetodiAmmessi.safeParse(['contanti', 'bonifico', 'contanti']).success).toBe(false)
  })
})
