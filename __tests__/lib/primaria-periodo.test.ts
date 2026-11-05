import { describe, it, expect } from 'vitest'
import {
  COLONNE_PERIODO,
  annoScolasticoDiData,
  dataDiCompetenza,
  dateMancantiPerAnno,
  giornoDiRoma,
  ordinaPerCompetenza,
  periodoPerData,
  sovrapposto,
  type PeriodoScrutinio,
} from '@/lib/primaria/periodo'
import { SEDE_A } from '../fixtures/sedi'

// =============================================================================
// A QUALE QUADRIMESTRE APPARTIENE UNA DATA. Modulo PURO: nessun database, nessun
// orologio. La regola di copertura è la stessa, riga per riga, della funzione SQL
// `primaria_ricalcola_periodi` (migrazione 20261104173158): contano i periodi con
// ENTRAMBE le date, `attivo` o no, estremi inclusi; a parità vince `ordine`, poi
// `data_inizio`, poi `id`. Se una delle due cambia, cambia anche l'altra.
// =============================================================================

const ID_Q1 = '9e710001-0000-4000-8000-000000000001'
const ID_Q2 = '9e710002-0000-4000-8000-000000000002'
const ID_Q1BIS = '9e710003-0000-4000-8000-000000000003'
const ID_QA = '9e710004-0000-4000-8000-000000000004'
const ID_QB = '9e710005-0000-4000-8000-000000000005'

function periodo(extra: Partial<PeriodoScrutinio>): PeriodoScrutinio {
  return {
    id: ID_Q1,
    scuola_id: SEDE_A,
    anno_scolastico: '2026/2027',
    nome: 'Primo quadrimestre',
    ordine: 1,
    data_inizio: null,
    data_fine: null,
    attivo: true,
    ...extra,
  }
}

const Q1 = periodo({ id: ID_Q1, ordine: 1, data_inizio: '2026-09-01', data_fine: '2027-01-31' })
const Q2 = periodo({ id: ID_Q2, nome: 'Secondo quadrimestre', ordine: 2, data_inizio: '2027-02-01', data_fine: '2027-06-30' })
// L'anno prima: serve a provare il fuso (il 31/01/2026 a mezzanotte).
const QA = periodo({ id: ID_QA, anno_scolastico: '2025/2026', ordine: 1, data_inizio: '2025-09-01', data_fine: '2026-01-31' })
const QB = periodo({ id: ID_QB, anno_scolastico: '2025/2026', ordine: 2, data_inizio: '2026-02-01', data_fine: '2026-06-30' })

describe('COLONNE_PERIODO', () => {
  it('sono le colonne dell’interfaccia, nell’ordine dell’interfaccia', () => {
    expect(COLONNE_PERIODO).toBe('id, scuola_id, anno_scolastico, nome, ordine, data_inizio, data_fine, attivo')
  })
})

describe('annoScolasticoDiData', () => {
  it('agosto apre il nuovo anno, luglio chiude il vecchio', () => {
    expect(annoScolasticoDiData('2026-11-04')).toBe('2026/2027')
    expect(annoScolasticoDiData('2027-07-31')).toBe('2026/2027')
    expect(annoScolasticoDiData('2027-08-01')).toBe('2027/2028')
  })
})

describe('periodoPerData', () => {
  it('estremi inclusi', () => {
    expect(periodoPerData([Q1, Q2], '2027-01-31').periodoId).toBe(Q1.id)
    expect(periodoPerData([Q1, Q2], '2027-02-01').periodoId).toBe(Q2.id)
    expect(periodoPerData([Q1, Q2], '2026-09-01').periodoId).toBe(Q1.id)
    expect(periodoPerData([Q1, Q2], '2027-06-30').periodoId).toBe(Q2.id)
  })

  it('fuori da ogni periodo, con le date tutte impostate: null e nessuna configurazione mancante', () => {
    expect(periodoPerData([Q1, Q2], '2027-07-15')).toEqual({ periodoId: null, coprenti: [], dateMancanti: false })
  })

  it('sovrapposti: vince l’ordine più basso, e coprenti li elenca tutti', () => {
    const Q1bis = { ...Q1, id: ID_Q1BIS, ordine: 0, data_inizio: '2027-01-15', data_fine: '2027-03-01' }
    expect(periodoPerData([Q1, Q1bis, Q2], '2027-01-20')).toEqual({
      periodoId: ID_Q1BIS,
      coprenti: [ID_Q1BIS, Q1.id],
      dateMancanti: false,
    })
  })

  it('a parità di ordine vince data_inizio, poi id: il risultato non dipende dall’ordine di lettura', () => {
    const tardi = periodo({ id: ID_Q2, ordine: 1, data_inizio: '2027-01-10', data_fine: '2027-03-01' })
    const presto = periodo({ id: ID_Q1BIS, ordine: 1, data_inizio: '2026-12-01', data_fine: '2027-03-01' })
    const stessoGiornoA = periodo({ id: ID_QA, ordine: 1, data_inizio: '2026-12-01', data_fine: '2027-03-01' })
    expect(periodoPerData([tardi, presto], '2027-01-20').coprenti).toEqual([ID_Q1BIS, ID_Q2])
    expect(periodoPerData([presto, tardi], '2027-01-20').coprenti).toEqual([ID_Q1BIS, ID_Q2])
    // Stessa data_inizio e stesso ordine: decide l'id (ID_Q1BIS < ID_QA).
    expect(periodoPerData([stessoGiornoA, presto], '2027-01-20').coprenti).toEqual([ID_Q1BIS, ID_QA])
    expect(periodoPerData([presto, stessoGiornoA], '2027-01-20').coprenti).toEqual([ID_Q1BIS, ID_QA])
  })

  it('un periodo con una sola data non copre e segna le date mancanti', () => {
    expect(periodoPerData([Q1, { ...Q2, data_fine: null }], '2027-03-10')).toEqual({
      periodoId: null,
      coprenti: [],
      dateMancanti: true,
    })
    expect(periodoPerData([Q1, { ...Q2, data_inizio: null }], '2027-03-10').coprenti).toEqual([])
  })

  it('nessun periodo per l’anno della data: date mancanti', () => {
    expect(periodoPerData([], '2026-11-04').dateMancanti).toBe(true)
    expect(periodoPerData([QA, QB], '2026-11-04').dateMancanti).toBe(true)
  })

  it('un periodo non attivo con le date copre lo stesso', () => {
    expect(periodoPerData([{ ...Q1, attivo: false }], '2026-10-01').periodoId).toBe(Q1.id)
  })

  it('una data che non è una data: nessun periodo e nessuna configurazione mancante', () => {
    expect(periodoPerData([Q1, Q2], '')).toEqual({ periodoId: null, coprenti: [], dateMancanti: false })
    expect(periodoPerData([], '')).toEqual({ periodoId: null, coprenti: [], dateMancanti: false })
  })
})

describe('dateMancantiPerAnno', () => {
  it('conta i soli periodi ATTIVI dell’anno: nessuno, o uno senza una data, segna la mancanza', () => {
    expect(dateMancantiPerAnno([], '2026/2027')).toBe(true)
    expect(dateMancantiPerAnno([Q1, Q2], '2026/2027')).toBe(false)
    expect(dateMancantiPerAnno([Q1, { ...Q2, data_fine: null }], '2026/2027')).toBe(true)
    // Un periodo disattivato senza date non sporca la configurazione dell'anno.
    expect(dateMancantiPerAnno([Q1, Q2, { ...Q1, id: ID_Q1BIS, attivo: false, data_inizio: null }], '2026/2027')).toBe(false)
    // Se gli unici periodi dell'anno sono disattivati, per l'anno non c'è configurazione.
    expect(dateMancantiPerAnno([{ ...Q1, attivo: false }], '2026/2027')).toBe(true)
    // Un altro anno non conta.
    expect(dateMancantiPerAnno([QA, QB], '2026/2027')).toBe(true)
  })
})

describe('sovrapposto', () => {
  it('restituisce l’id del periodo che si sovrappone, e null altrimenti', () => {
    expect(sovrapposto({ data_inizio: '2027-01-10', data_fine: '2027-02-10' }, [Q1, Q2])).toBe(Q1.id)
    expect(sovrapposto({ data_inizio: '2026-06-01', data_fine: '2026-08-31' }, [Q1, Q2])).toBeNull() // a ridosso, senza sovrapporsi
    expect(sovrapposto({ id: Q1.id, data_inizio: '2026-09-01', data_fine: '2027-01-20' }, [Q1, Q2])).toBeNull() // sé stesso non conta
    expect(sovrapposto({ data_inizio: '2027-03-01', data_fine: '2027-03-02' }, [{ ...Q2, data_fine: null }])).toBeNull()
  })

  it('un giorno in comune è già una sovrapposizione (estremi inclusi)', () => {
    expect(sovrapposto({ data_inizio: '2027-01-31', data_fine: '2027-02-15' }, [Q1])).toBe(Q1.id)
    expect(sovrapposto({ data_inizio: '2026-08-01', data_fine: '2026-09-01' }, [Q1])).toBe(Q1.id)
  })

  it('un periodo non attivo si sovrappone lo stesso, perché copre lo stesso', () => {
    expect(sovrapposto({ data_inizio: '2027-01-10', data_fine: '2027-02-10' }, [{ ...Q1, attivo: false }])).toBe(Q1.id)
  })

  it('con più sovrapposti risponde in modo deterministico: ordine, data_inizio, id', () => {
    const Q1bis = { ...Q1, id: ID_Q1BIS, ordine: 0, data_inizio: '2027-01-15', data_fine: '2027-03-01' }
    const candidato = { data_inizio: '2027-01-20', data_fine: '2027-01-25' }
    expect(sovrapposto(candidato, [Q1, Q1bis])).toBe(ID_Q1BIS)
    expect(sovrapposto(candidato, [Q1bis, Q1])).toBe(ID_Q1BIS)
  })
})

describe('il giorno si conta a Roma', () => {
  it('mezzanotte a Roma: il 31/01 alle 23:30 UTC è già il 1° febbraio, secondo quadrimestre', () => {
    expect(giornoDiRoma('2026-01-31T23:30:00Z')).toBe('2026-02-01')
    expect(dataDiCompetenza({ data_evento: null, creato_il: '2026-01-31T23:30:00Z' })).toBe('2026-02-01')
    expect(periodoPerData([QA, QB], dataDiCompetenza({ creato_il: '2026-01-31T23:30:00Z' })).periodoId).toBe(QB.id)
    expect(dataDiCompetenza({ data_evento: '2026-10-20', creato_il: '2026-11-03T08:00:00Z' })).toBe('2026-10-20')
    expect(dataDiCompetenza({})).toBe('')
  })

  it('giornoDiRoma: assente o non valido dà la stringa vuota', () => {
    expect(giornoDiRoma(null)).toBe('')
    expect(giornoDiRoma(undefined)).toBe('')
    expect(giornoDiRoma('')).toBe('')
    expect(giornoDiRoma('non è una data')).toBe('')
  })

  it('d’estate l’ora legale sposta il confine di due ore, non di una', () => {
    expect(giornoDiRoma('2026-06-30T21:59:00Z')).toBe('2026-06-30')
    expect(giornoDiRoma('2026-06-30T22:00:00Z')).toBe('2026-07-01')
  })
})

describe('ordinaPerCompetenza', () => {
  it('data_evento decrescente, poi creato_il decrescente, senza mutare', () => {
    const A = { id: 'a', data_evento: '2026-10-01', creato_il: '2026-11-03T10:00:00Z' }
    const B = { id: 'b', data_evento: '2026-10-20', creato_il: '2026-10-20T08:00:00Z' }
    const C = { id: 'c', data_evento: '2026-10-20', creato_il: '2026-10-21T08:00:00Z' }
    const input = [A, B, C]
    expect(ordinaPerCompetenza(input).map((r) => r.id)).toEqual(['c', 'b', 'a'])
    expect(input.map((r) => r.id)).toEqual(['a', 'b', 'c'])
  })

  it('una riga senza data_evento si ordina per il suo giorno di Roma', () => {
    const SENZA = { id: 'senza', data_evento: null, creato_il: '2026-10-25T08:00:00Z' }
    const CON = { id: 'con', data_evento: '2026-10-20', creato_il: '2026-11-03T08:00:00Z' }
    expect(ordinaPerCompetenza([CON, SENZA]).map((r) => r.id)).toEqual(['senza', 'con'])
  })
})
