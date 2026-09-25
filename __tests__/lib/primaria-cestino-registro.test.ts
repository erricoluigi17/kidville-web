import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  GIORNI_CESTINO_REGISTRO,
  cestinoScaduto,
  giorniResiduiCestino,
  scadenzaCestino,
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
