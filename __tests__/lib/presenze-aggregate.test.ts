import { describe, it, expect } from 'vitest'
import { aggregaPresenze, TOTALE_VUOTO } from '@/lib/presenze/aggregate'

// M7.4 — aggregazione pura presenze multi-sede: presenti/assenti/iscritti per
// scuola e classe, appelli_mancanti = classi con 0 righe di presenza.

const SCHOOLS = [
  { id: 'sc-1', nome: 'Kidville Centro' },
  { id: 'sc-2', nome: 'Kidville Nord' },
]
const SECTIONS = [
  { id: 'sez-a', name: 'Girasoli', scuola_id: 'sc-1' },
  { id: 'sez-b', name: 'Tulipani', scuola_id: 'sc-1' },
  { id: 'sez-c', name: 'Margherite', scuola_id: 'sc-2' },
]
const ALUNNI = [
  { id: 'al-1', section_id: 'sez-a', scuola_id: 'sc-1' },
  { id: 'al-2', section_id: 'sez-a', scuola_id: 'sc-1' },
  { id: 'al-3', section_id: 'sez-b', scuola_id: 'sc-1' },
  { id: 'al-4', section_id: 'sez-c', scuola_id: 'sc-2' },
]

describe('aggregaPresenze', () => {
  it('input vuoto → totale a zero e nessuna sede', () => {
    const r = aggregaPresenze([], [], [], [])
    expect(r.totale).toEqual(TOTALE_VUOTO)
    expect(r.sedi).toEqual([])
  })

  it('aggrega presenti/assenti per sede e classe', () => {
    const r = aggregaPresenze(
      ALUNNI,
      [
        { alunno_id: 'al-1', stato: 'presente' },
        { alunno_id: 'al-2', stato: 'assente' },
        { alunno_id: 'al-4', stato: 'ritardo' },
      ],
      SECTIONS,
      SCHOOLS
    )
    expect(r.totale).toEqual({ presenti: 2, iscritti: 4, assenti: 1, appelli_mancanti: 1 })
    const centro = r.sedi.find((s) => s.scuola_id === 'sc-1')
    expect(centro).toMatchObject({ scuola: 'Kidville Centro', presenti: 1, assenti: 1, iscritti: 3 })
    const girasoli = centro?.classi.find((c) => c.classe === 'Girasoli')
    expect(girasoli).toMatchObject({ presenti: 1, assenti: 1, iscritti: 2, appello_fatto: true })
  })

  it('ritardo e uscita_anticipata contano come presenti', () => {
    const r = aggregaPresenze(
      ALUNNI,
      [
        { alunno_id: 'al-1', stato: 'ritardo' },
        { alunno_id: 'al-2', stato: 'uscita_anticipata' },
      ],
      SECTIONS,
      SCHOOLS
    )
    expect(r.totale.presenti).toBe(2)
    expect(r.totale.assenti).toBe(0)
  })

  it('appelli_mancanti = classi con iscritti > 0 e zero righe', () => {
    const r = aggregaPresenze(ALUNNI, [{ alunno_id: 'al-1', stato: 'presente' }], SECTIONS, SCHOOLS)
    // sez-a ha una riga; sez-b e sez-c nessuna → 2 appelli mancanti
    expect(r.totale.appelli_mancanti).toBe(2)
    const nord = r.sedi.find((s) => s.scuola_id === 'sc-2')
    expect(nord?.appelli_mancanti).toBe(1)
    expect(nord?.classi[0]).toMatchObject({ classe: 'Margherite', appello_fatto: false })
  })

  it('ignora presenze di alunni fuori elenco (fuori scope)', () => {
    const r = aggregaPresenze(ALUNNI, [{ alunno_id: 'estraneo', stato: 'presente' }], SECTIONS, SCHOOLS)
    expect(r.totale.presenti).toBe(0)
  })

  it('alunni senza sezione contano su sede/totale ma non creano classi', () => {
    const r = aggregaPresenze(
      [{ id: 'al-9', section_id: null, scuola_id: 'sc-1' }],
      [{ alunno_id: 'al-9', stato: 'presente' }],
      SECTIONS,
      SCHOOLS
    )
    expect(r.totale).toEqual({ presenti: 1, iscritti: 1, assenti: 0, appelli_mancanti: 0 })
    expect(r.sedi[0].classi).toEqual([])
  })

  it('ordina le sedi e le classi per nome', () => {
    const r = aggregaPresenze(ALUNNI, [], SECTIONS, SCHOOLS)
    expect(r.sedi.map((s) => s.scuola)).toEqual(['Kidville Centro', 'Kidville Nord'])
    expect(r.sedi[0].classi.map((c) => c.classe)).toEqual(['Girasoli', 'Tulipani'])
  })
})
