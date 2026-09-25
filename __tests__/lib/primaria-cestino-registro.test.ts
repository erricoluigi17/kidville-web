import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  GIORNI_CESTINO_REGISTRO,
  GIORNI_CONSERVAZIONE_ALLEGATI_REGISTRO,
  cestinoScaduto,
  conservazioneAllegatoScaduta,
  filtroEntroConservazioneAllegati,
  giorniResiduiAllegatoNelCestino,
  giorniResiduiCestino,
  ripristinabileFinoAlAllegato,
  scadenzaCestino,
  scadenzaConservazioneAllegato,
  sogliaConservazioneAllegatiRegistro,
  sogliaPurgaCestinoRegistro,
} from '@/lib/primaria/cestino-registro'

// =============================================================================
// Il cestino di allegati del registro e documenti del fascicolo: 7 giorni
// (spec 2026-09-24). Istanti fissi, mai «adesso»: il test non scade da solo.
// =============================================================================

const MESSO_NEL_CESTINO = '2026-09-10T08:00:00.000Z'

describe('cestino del registro — i giorni di custodia', () => {
  it('sono 7', () => {
    expect(GIORNI_CESTINO_REGISTRO).toBe(7)
  })

  it('il modulo è PURO: nessun import, così lo legge anche il client', () => {
    const sorgente = readFileSync(join(process.cwd(), 'src/lib/primaria/cestino-registro.ts'), 'utf8')
    expect(sorgente).not.toMatch(/^\s*import\s/m)
  })

  it('la scadenza è 7 × 24 ore dopo l’eliminazione, anche a cavallo del cambio d’ora', () => {
    expect(scadenzaCestino(MESSO_NEL_CESTINO)?.toISOString()).toBe('2026-09-17T08:00:00.000Z')
    // 25/10/2026: torna l'ora solare. Sull'istante non cambia niente.
    expect(scadenzaCestino(new Date('2026-10-22T08:00:00Z'))?.toISOString()).toBe('2026-10-29T08:00:00.000Z')
    expect(scadenzaCestino('non-una-data')).toBeNull()
  })

  it('i giorni residui si arrotondano PER DIFETTO (mai più tempo del vero) e non scendono sotto zero', () => {
    expect(giorniResiduiCestino(MESSO_NEL_CESTINO, new Date('2026-09-10T08:00:00Z'))).toBe(7)
    // 6 giorni e 23 ore → 6: «7» prometterebbe un’ora che non c’è.
    expect(giorniResiduiCestino(MESSO_NEL_CESTINO, new Date('2026-09-10T09:00:00Z'))).toBe(6)
    // 30 ore alla scadenza → 1 giorno, non 2.
    expect(giorniResiduiCestino(MESSO_NEL_CESTINO, new Date('2026-09-16T02:00:00Z'))).toBe(1)
    // Esattamente 24 ore → 1.
    expect(giorniResiduiCestino(MESSO_NEL_CESTINO, new Date('2026-09-16T08:00:00Z'))).toBe(1)
    // Un minuto alla scadenza → 0 giorni interi, ma ANCORA ripristinabile: è il caso
    // «meno di un giorno» che la UI distingue con `cestinoScaduto`.
    expect(giorniResiduiCestino(MESSO_NEL_CESTINO, new Date('2026-09-17T07:59:00Z'))).toBe(0)
    expect(cestinoScaduto(MESSO_NEL_CESTINO, new Date('2026-09-17T07:59:00Z'))).toBe(false)
    expect(giorniResiduiCestino(MESSO_NEL_CESTINO, new Date('2026-09-17T08:00:00Z'))).toBe(0)
    expect(giorniResiduiCestino(MESSO_NEL_CESTINO, new Date('2026-10-01T00:00:00Z'))).toBe(0)
    expect(giorniResiduiCestino('non-una-data', new Date('2026-09-10T08:00:00Z'))).toBe(0)
  })

  it('scaduto dal settimo giorno esatto; un istante illeggibile non si dichiara scaduto', () => {
    expect(cestinoScaduto(MESSO_NEL_CESTINO, new Date('2026-09-17T07:59:59Z'))).toBe(false)
    expect(cestinoScaduto(MESSO_NEL_CESTINO, new Date('2026-09-17T08:00:00Z'))).toBe(true)
    expect(cestinoScaduto('non-una-data', new Date('2030-01-01T00:00:00Z'))).toBe(false)
  })

  it('la soglia della purga è «adesso − 7 giorni»: coerente con la scadenza', () => {
    const adesso = new Date('2026-09-17T08:00:00Z')
    expect(sogliaPurgaCestinoRegistro(adesso)).toBe('2026-09-10T08:00:00.000Z')
    // Ciò che la purga prende (`eliminato_il` < soglia) è sempre già scaduto per la UI:
    // la schermata non promette mai un ripristino di una riga che la purga ha tolto.
    expect(cestinoScaduto('2026-09-10T07:59:59.999Z', adesso)).toBe(true)
  })
})

// =============================================================================
// La conservazione degli allegati del registro: 365 giorni dal CARICAMENTO
// (decisione del titolare del 2026-09-25). Istanti fissi.
// =============================================================================

describe('conservazione degli allegati del registro — i giorni dal caricamento', () => {
  it('sono 365', () => {
    expect(GIORNI_CONSERVAZIONE_ALLEGATI_REGISTRO).toBe(365)
  })

  it('la soglia è «adesso − 365 × 24 ore», sull’istante', () => {
    // 2026-09-25 − 365 giorni = 2025-09-25 (il 2026 non è bisestile).
    expect(sogliaConservazioneAllegatiRegistro(new Date('2026-09-25T03:29:00Z'))).toBe('2025-09-25T03:29:00.000Z')
    // A cavallo di un 29 febbraio i giorni restano 365 da 24 ore: non «un anno».
    expect(sogliaConservazioneAllegatiRegistro(new Date('2028-03-01T00:00:00Z'))).toBe('2027-03-02T00:00:00.000Z')
  })

  it('la scadenza di un allegato è 365 × 24 ore dopo il caricamento, e torna con la soglia', () => {
    const caricato = '2025-09-25T08:00:00.000Z'
    const scade = scadenzaConservazioneAllegato(caricato)
    expect(scade?.toISOString()).toBe('2026-09-25T08:00:00.000Z')
    // Un allegato che scade proprio adesso è sul confine: la purga prende `creato_il < soglia`.
    expect(sogliaConservazioneAllegatiRegistro(scade!)).toBe(caricato)
    expect(scadenzaConservazioneAllegato('non-una-data')).toBeNull()
  })
})

describe('allegati del registro — vince il PRIMO termine che scade', () => {
  const ADESSO = new Date('2026-09-25T08:00:00Z')

  it('caricato 360 giorni fa e cestinato adesso: scade per conservazione fra 5 giorni, non fra 7', () => {
    const creato = '2025-09-30T08:00:00.000Z' // 360 giorni prima di ADESSO
    const eliminato = ADESSO.toISOString()
    expect(ripristinabileFinoAlAllegato(eliminato, creato)?.toISOString()).toBe('2026-09-30T08:00:00.000Z')
    expect(giorniResiduiAllegatoNelCestino(eliminato, creato, ADESSO)).toBe(5)
    // Il solo cestino avrebbe promesso 7.
    expect(giorniResiduiCestino(eliminato, ADESSO)).toBe(7)
  })

  it('un allegato giovane: vince la custodia del cestino, come prima', () => {
    const creato = '2026-09-01T08:00:00.000Z'
    const eliminato = '2026-09-24T08:00:00.000Z'
    expect(ripristinabileFinoAlAllegato(eliminato, creato)?.toISOString()).toBe(scadenzaCestino(eliminato)?.toISOString())
    expect(giorniResiduiAllegatoNelCestino(eliminato, creato, ADESSO)).toBe(6)
  })

  it('senza `creato_il` leggibile vale la sola custodia; senza eliminazione leggibile niente', () => {
    const eliminato = '2026-09-24T08:00:00.000Z'
    expect(ripristinabileFinoAlAllegato(eliminato, null)?.toISOString()).toBe('2026-10-01T08:00:00.000Z')
    expect(ripristinabileFinoAlAllegato(eliminato, 'non-una-data')?.toISOString()).toBe('2026-10-01T08:00:00.000Z')
    expect(ripristinabileFinoAlAllegato('non-una-data', '2025-09-30T08:00:00.000Z')).toBeNull()
    expect(giorniResiduiAllegatoNelCestino('non-una-data', null, ADESSO)).toBe(0)
  })

  it('conservazione scaduta dal 365° giorno esatto; `creato_il` NULL non scade (come la purga)', () => {
    expect(conservazioneAllegatoScaduta('2025-09-25T08:00:00.001Z', ADESSO)).toBe(false)
    expect(conservazioneAllegatoScaduta('2025-09-25T08:00:00.000Z', ADESSO)).toBe(true)
    expect(conservazioneAllegatoScaduta(null, ADESSO)).toBe(false)
    expect(conservazioneAllegatoScaduta(undefined, ADESSO)).toBe(false)
    expect(conservazioneAllegatoScaduta('non-una-data', ADESSO)).toBe(false)
  })

  it('il filtro del cestino è il complemento della soglia della purga (NULL compreso, valore fra virgolette)', () => {
    expect(filtroEntroConservazioneAllegati(ADESSO)).toBe(
      `creato_il.is.null,creato_il.gte."${sogliaConservazioneAllegatiRegistro(ADESSO)}"`,
    )
  })
})
