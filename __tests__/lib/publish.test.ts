import { describe, it, expect } from 'vitest'
import { publicFormUrl, modelloPubblicato, accessoConsentito } from '@/lib/forms/publish'

describe('publicFormUrl', () => {
  it('costruisce il path pubblico /m/{token}', () => {
    expect(publicFormUrl('abc-123')).toBe('/m/abc-123')
  })
})

describe('modelloPubblicato', () => {
  it('true solo se published_at valorizzato', () => {
    expect(modelloPubblicato({ published_at: '2026-06-26T00:00:00Z' })).toBe(true)
    expect(modelloPubblicato({ published_at: null })).toBe(false)
    expect(modelloPubblicato({})).toBe(false)
  })
})

describe('accessoConsentito', () => {
  it('public: sempre consentito', () => {
    expect(accessoConsentito({ access_mode: 'public' }, false)).toBe(true)
    expect(accessoConsentito({ access_mode: 'public' }, true)).toBe(true)
  })
  it('authenticated: solo con sessione', () => {
    expect(accessoConsentito({ access_mode: 'authenticated' }, false)).toBe(false)
    expect(accessoConsentito({ access_mode: 'authenticated' }, true)).toBe(true)
  })
  it('default (assente) trattato come public', () => {
    expect(accessoConsentito({}, false)).toBe(true)
  })
})
