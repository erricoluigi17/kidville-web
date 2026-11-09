import { describe, it, expect } from 'vitest'
import { firmatoInAppIl, haUnaFirmaInApp, type AnnoDellaFirma } from '@/lib/prestampati/firma-per-anno'

/**
 * COMPITO 4.5.10 · «firmato in app il…» accanto alla spunta, per l'ANNO della frequenza.
 *
 * Una firma dell'anno scorso non è una firma di quest'anno, tranne per i moduli «fino a revoca». I due slug usati qui sono due
 * del registro vero: `delega_ritiro` (durata `anno`) e `scheda_sanitaria` (durata `fino_a_revoca`). Date fisse, mai `now()`.
 */

const ANNO_2027: AnnoDellaFirma = { inizio: '2027-09-01', fine: '2028-08-31', ultimoGiornoAnnoPrima: '2027-07-31' }
const firma = (document_type: string, created_at: string) => ({ document_type, created_at })

describe('firmatoInAppIl — modulo a durata annuale', () => {
  it('una firma dell’anno prima NON vale: l’anno scorso non firma per quest’anno', () => {
    expect(firmatoInAppIl('delega_ritiro', [firma('delega_ritiro', '2026-10-05T09:00:00Z')], ANNO_2027)).toBeNull()
  })

  it('una firma dell’anno della frequenza vale, e si riporta il GIORNO', () => {
    expect(firmatoInAppIl('delega_ritiro', [firma('delega_ritiro', '2027-10-05T09:00:00Z')], ANNO_2027)).toBe('2027-10-05')
  })

  it('la firma data fra l’ultimo giorno aperto dell’anno prima e l’inizio vale: è del nuovo anno (come in da-rifirmare)', () => {
    expect(firmatoInAppIl('delega_ritiro', [firma('delega_ritiro', '2027-08-20T09:00:00Z')], ANNO_2027)).toBe('2027-08-20')
  })

  it('il giorno stesso dell’ultimo giorno aperto dell’anno prima è ancora dell’anno prima', () => {
    expect(firmatoInAppIl('delega_ritiro', [firma('delega_ritiro', '2027-07-31T10:00:00Z')], ANNO_2027)).toBeNull()
  })

  it('senza anno prima nel calendario la soglia è l’inizio dell’anno', () => {
    const solo: AnnoDellaFirma = { ...ANNO_2027, ultimoGiornoAnnoPrima: null }
    expect(firmatoInAppIl('delega_ritiro', [firma('delega_ritiro', '2027-08-20T09:00:00Z')], solo)).toBeNull()
    expect(firmatoInAppIl('delega_ritiro', [firma('delega_ritiro', '2027-09-01T09:00:00Z')], solo)).toBe('2027-09-01')
  })

  it('una firma dopo la fine dell’anno non conta mai', () => {
    expect(firmatoInAppIl('delega_ritiro', [firma('delega_ritiro', '2028-09-02T09:00:00Z')], ANNO_2027)).toBeNull()
  })

  it('fra più firme valide si prende la più recente', () => {
    const firme = [firma('delega_ritiro', '2027-09-10T09:00:00Z'), firma('delega_ritiro', '2028-01-10T09:00:00Z'), firma('delega_ritiro', '2026-05-01T09:00:00Z')]
    expect(firmatoInAppIl('delega_ritiro', firme, ANNO_2027)).toBe('2028-01-10')
  })
})

describe('firmatoInAppIl — modulo fino a revoca', () => {
  it('vale anche una firma di un anno prima', () => {
    expect(firmatoInAppIl('scheda_sanitaria', [firma('scheda_sanitaria', '2026-10-05T09:00:00Z')], ANNO_2027)).toBe('2026-10-05')
  })

  it('vale anche una firma di tre anni prima', () => {
    expect(firmatoInAppIl('scheda_sanitaria', [firma('scheda_sanitaria', '2024-10-05T09:00:00Z')], ANNO_2027)).toBe('2024-10-05')
  })

  it('una firma dopo la fine dell’anno non conta nemmeno qui', () => {
    expect(firmatoInAppIl('scheda_sanitaria', [firma('scheda_sanitaria', '2028-09-02T09:00:00Z')], ANNO_2027)).toBeNull()
  })
})

describe('firmatoInAppIl — ciò che non è una firma di quel modulo', () => {
  it('un codice che non è del registro non ha mai una firma, anche se un documento ha lo stesso nome', () => {
    expect(haUnaFirmaInApp('foglio_cartaceo')).toBe(false)
    expect(firmatoInAppIl('foglio_cartaceo', [firma('foglio_cartaceo', '2027-10-05T09:00:00Z')], ANNO_2027)).toBeNull()
  })

  it('i codici del registro sono riconosciuti', () => {
    expect(haUnaFirmaInApp('delega_ritiro')).toBe(true)
    expect(haUnaFirmaInApp('scheda_sanitaria')).toBe(true)
  })

  it('un documento di un altro tipo non conta', () => {
    expect(firmatoInAppIl('delega_ritiro', [firma('scheda_sanitaria', '2027-10-05T09:00:00Z')], ANNO_2027)).toBeNull()
  })

  it('una data illeggibile o assente non è una firma', () => {
    expect(firmatoInAppIl('delega_ritiro', [firma('delega_ritiro', 'non-una-data'), { document_type: 'delega_ritiro', created_at: null }], ANNO_2027)).toBeNull()
  })

  it('nessuna firma, nessun risultato', () => {
    expect(firmatoInAppIl('delega_ritiro', [], ANNO_2027)).toBeNull()
  })
})
