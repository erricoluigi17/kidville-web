import { describe, it, expect } from 'vitest'
import { suggerisciCampi, parseDataItaliana } from '@/lib/protocolli/estrai'

const LETTERA_TIPO = `COMUNE DI GIUGLIANO IN CAMPANIA
Settore Istruzione e Politiche Sociali

Prot. n. 12345/2026 del 03/07/2026

Spett.le Kidville Giugliano
Via Aniello Palumbo 1

OGGETTO: Richiesta documentazione iscrizioni a.s. 2026/2027

Con la presente si richiede l'invio della documentazione in oggetto.`

describe('suggerisciCampi (euristiche lettera amministrativa italiana)', () => {
  it('estrae l\'oggetto dalla riga "OGGETTO:"', () => {
    expect(suggerisciCampi(LETTERA_TIPO).oggetto).toBe(
      'Richiesta documentazione iscrizioni a.s. 2026/2027'
    )
  })
  it('estrae numero e data di protocollo del mittente ("Prot. n. … del …")', () => {
    const campi = suggerisciCampi(LETTERA_TIPO)
    expect(campi.rifProtMittente).toBe('12345/2026')
    expect(campi.rifDataMittente).toBe('2026-07-03')
  })
  it('propone come mittente la prima riga significativa (intestazione)', () => {
    expect(suggerisciCampi(LETTERA_TIPO).mittente).toBe('COMUNE DI GIUGLIANO IN CAMPANIA')
  })
  it('testo vuoto → nessun suggerimento (scansioni senza testo)', () => {
    expect(suggerisciCampi('')).toEqual({})
    expect(suggerisciCampi('   \n  ')).toEqual({})
  })
  it('senza riga OGGETTO → oggetto assente', () => {
    const campi = suggerisciCampi('ASL NAPOLI 2 NORD\nComunicazione varia senza oggetto')
    expect(campi.oggetto).toBeUndefined()
    expect(campi.mittente).toBe('ASL NAPOLI 2 NORD')
  })
  it('non scambia "Spett.le …" (destinatario) per il mittente', () => {
    const campi = suggerisciCampi('Spett.le Kidville Giugliano\n\nOGGETTO: Saluti')
    expect(campi.mittente).toBeUndefined()
    expect(campi.oggetto).toBe('Saluti')
  })
  it('oggetto minuscolo e con trattino', () => {
    expect(suggerisciCampi('Oggetto - convocazione riunione').oggetto).toBe(
      'convocazione riunione'
    )
  })
})

describe('parseDataItaliana', () => {
  it('gg/mm/aaaa → ISO', () => {
    expect(parseDataItaliana('03/07/2026')).toBe('2026-07-03')
  })
  it('g-m-aa → ISO con secolo 2000', () => {
    expect(parseDataItaliana('3-7-26')).toBe('2026-07-03')
  })
  it('separatore punto', () => {
    expect(parseDataItaliana('03.07.2026')).toBe('2026-07-03')
  })
  it('data implausibile → undefined', () => {
    expect(parseDataItaliana('99/99/2026')).toBeUndefined()
    expect(parseDataItaliana('non-una-data')).toBeUndefined()
  })
})
