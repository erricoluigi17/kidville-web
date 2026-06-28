import { describe, it, expect } from 'vitest'
import { buildCertificatoPdf, type CertificatoData } from '@/lib/competenze/certificato-pdf'

const fixture: CertificatoData = {
  scuolaNome: 'Kidville',
  classe: '5A',
  anno: '2025/2026',
  alunno: 'Rossi Marco',
  alunnoNato: '2015-03-01',
  codiceFiscale: 'RSSMRC15C01H501Z',
  competenze: [
    { etichetta: 'Competenza alfabetica funzionale', livello: 'A', note: null },
    { etichetta: 'Competenza multilinguistica', livello: 'B', note: null },
    { etichetta: 'Competenza digitale', livello: null, note: null },
  ],
  competenzeSignificative: 'Ha mostrato spiccate competenze musicali nel coro scolastico.',
  dirigente: 'Anna Bianchi',
  firmatoIl: '2026-06-10T10:00:00.000Z',
}

describe('buildCertificatoPdf', () => {
  it('produce un Buffer PDF non vuoto che inizia con %PDF', () => {
    const buf = buildCertificatoPdf(fixture)
    expect(Buffer.isBuffer(buf)).toBe(true)
    expect(buf.length).toBeGreaterThan(500)
    expect(buf.subarray(0, 4).toString('latin1')).toBe('%PDF')
  })

  it('non lancia se livelli e firma sono assenti', () => {
    const vuoto: CertificatoData = {
      ...fixture,
      competenze: fixture.competenze.map((c) => ({ ...c, livello: null })),
      competenzeSignificative: null,
      dirigente: null,
      firmatoIl: null,
    }
    expect(() => buildCertificatoPdf(vuoto)).not.toThrow()
  })
})
