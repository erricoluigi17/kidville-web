// @vitest-environment node
import { describe, it, expect } from 'vitest'
import {
  classiDi,
  alunniBersaglio,
  parametriSelezione,
  selezioneVuota,
  nomeCompleto,
  SELEZIONE_TUTTI,
  type AlunnoSceglibile,
} from '@/lib/pagamenti/selezione-alunni'

const ALUNNI: AlunnoSceglibile[] = [
  { id: 'a1', nome: 'Anna', cognome: 'Bianchi', classe_sezione: '1A' },
  { id: 'a2', nome: 'Bruno', cognome: 'Rossi', classe_sezione: '1A' },
  { id: 'a3', nome: 'Carla', cognome: 'Verdi', classe_sezione: '2B' },
  { id: 'a4', nome: 'Dario', cognome: 'Neri', classe_sezione: null },
]

describe('classiDi', () => {
  it('le classi presenti, ordinate e senza doppioni', () => {
    expect(classiDi(ALUNNI)).toEqual(['1A', '2B'])
  })
  it('chi non ha classe non inventa una classe vuota', () => {
    expect(classiDi([{ id: 'x', classe_sezione: '  ' }])).toEqual([])
  })
})

describe('alunniBersaglio', () => {
  it('«tutti» è tutto l’elenco dei candidati', () => {
    expect(alunniBersaglio(ALUNNI, SELEZIONE_TUTTI).map((a) => a.id)).toEqual(['a1', 'a2', 'a3', 'a4'])
  })
  it('«classe» prende solo quella classe', () => {
    expect(alunniBersaglio(ALUNNI, { modo: 'classe', classe: '1A', ids: [] }).map((a) => a.id)).toEqual(['a1', 'a2'])
  })
  it('«classe» senza classe scelta non prende nessuno: non è «tutti»', () => {
    expect(alunniBersaglio(ALUNNI, { modo: 'classe', classe: '', ids: [] })).toEqual([])
  })
  it('«scelti» rispetta l’ordine dei candidati, non quello delle spunte', () => {
    expect(alunniBersaglio(ALUNNI, { modo: 'scelti', classe: '', ids: ['a3', 'a1'] }).map((a) => a.id))
      .toEqual(['a1', 'a3'])
  })
  it('un id che non è fra i candidati viene ignorato', () => {
    // È la difesa che tiene insieme anteprima e conferma: si genera solo ciò che
    // l'anteprima aveva mostrato.
    expect(alunniBersaglio(ALUNNI, { modo: 'scelti', classe: '', ids: ['ignoto'] })).toEqual([])
  })
})

describe('parametriSelezione — gli stessi per anteprima e conferma', () => {
  it('«tutti» non manda `alunno_ids` AFFATTO', () => {
    // ⚠️ Non un array vuoto: in SQL `= ANY('{}')` è falso per ogni riga, quindi
    // significherebbe «nessuno» proprio dove si intende «tutti».
    const p = parametriSelezione(ALUNNI, SELEZIONE_TUTTI)
    expect(p).toEqual({})
    expect('alunno_ids' in p).toBe(false)
  })
  it('«classe» manda gli id di quella classe', () => {
    expect(parametriSelezione(ALUNNI, { modo: 'classe', classe: '2B', ids: [] })).toEqual({ alunno_ids: ['a3'] })
  })
  it('«scelti» manda gli id spuntati', () => {
    expect(parametriSelezione(ALUNNI, { modo: 'scelti', classe: '', ids: ['a2'] })).toEqual({ alunno_ids: ['a2'] })
  })
  it('una selezione che non prende nessuno manda un array VUOTO, che il server rifiuta', () => {
    // Meglio un 400 rumoroso che una generazione su tutti: è il caso in cui il
    // significato di «vuoto» e quello di «tutti» si toccano.
    expect(parametriSelezione(ALUNNI, { modo: 'scelti', classe: '', ids: [] })).toEqual({ alunno_ids: [] })
  })
})

describe('selezioneVuota', () => {
  it('«tutti» non è mai vuota, nemmeno senza candidati', () => {
    expect(selezioneVuota([], SELEZIONE_TUTTI)).toBe(false)
  })
  it('«scelti» senza spunte è vuota', () => {
    expect(selezioneVuota(ALUNNI, { modo: 'scelti', classe: '', ids: [] })).toBe(true)
  })
  it('«classe» su una classe senza bambini è vuota', () => {
    expect(selezioneVuota(ALUNNI, { modo: 'classe', classe: '3C', ids: [] })).toBe(true)
  })
})

describe('nomeCompleto', () => {
  it('cognome e nome, in quest’ordine', () => {
    expect(nomeCompleto(ALUNNI[0]!)).toBe('Bianchi Anna')
  })
  it('se ne manca uno non resta uno spazio doppio', () => {
    expect(nomeCompleto({ id: 'x', cognome: 'Solo' })).toBe('Solo')
    expect(nomeCompleto({ id: 'x' })).toBe('')
  })
})
