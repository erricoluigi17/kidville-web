import { describe, expect, it } from 'vitest'
import { affluenza, contaVoti } from '@/lib/votazioni/conteggio'

/**
 * IL CONTEGGIO: vince chi ha più voti, la parità la decide la segreteria.
 *
 * La funzione non sceglie mai fra due pari merito: li restituisce TUTTI in `eletti`, ed è la schermata a
 * dire «Parità fra X e Y: decide la segreteria». Se qui ne uscisse uno solo per ordine di arrivo, la
 * segreteria vedrebbe un «Eletto» che nessuno ha eletto.
 */

const A = '00000000-0000-4000-8000-00000000000a'
const B = '00000000-0000-4000-8000-00000000000b'
const C = '00000000-0000-4000-8000-00000000000c'

const voti = (...ids: string[]) => ids.map((candidatoId) => ({ candidatoId }))

describe('contaVoti', () => {
  it('un vincitore: un solo eletto, conteggi in ordine decrescente', () => {
    const r = contaVoti(voti(A, B, A, C, A, B))
    expect(r.eletti).toEqual([A])
    expect(r.conteggi).toEqual([
      { utenteId: A, voti: 3 },
      { utenteId: B, voti: 2 },
      { utenteId: C, voti: 1 },
    ])
  })

  it('una parità a due: eletti.length === 2, e li contiene entrambi', () => {
    const r = contaVoti(voti(A, B, A, B, C))
    expect(r.eletti).toHaveLength(2)
    expect([...r.eletti].sort()).toEqual([A, B])
    expect(r.conteggi.map((c) => c.voti)).toEqual([2, 2, 1])
  })

  it('una parità a tre', () => {
    const r = contaVoti(voti(A, B, C))
    expect([...r.eletti].sort()).toEqual([A, B, C])
  })

  it('senza voti: nessun eletto, e i candidati a zero ci sono tutti', () => {
    const r = contaVoti([], [A, B, C])
    expect(r.eletti).toEqual([])
    expect(r.conteggi).toHaveLength(3)
    expect(r.conteggi.every((c) => c.voti === 0)).toBe(true)
    expect(r.conteggi.map((c) => c.utenteId).sort()).toEqual([A, B, C])
  })

  it('senza voti e senza candidati: tutto vuoto, nessuna eccezione', () => {
    expect(contaVoti([])).toEqual({ conteggi: [], eletti: [] })
  })

  it('i candidati a zero si aggiungono a chi ha voti, senza raddoppiare chi li ha già', () => {
    const r = contaVoti(voti(A, A), [A, B, C])
    expect(r.conteggi).toEqual([
      { utenteId: A, voti: 2 },
      { utenteId: B, voti: 0 },
      { utenteId: C, voti: 0 },
    ])
    expect(r.eletti).toEqual([A])
  })

  it('un candidato a zero NON è mai eletto, nemmeno se è l’unico', () => {
    expect(contaVoti([], [A]).eletti).toEqual([])
  })

  it('un candidato che compare solo nei voti (non in `candidatiAZero`) viene contato', () => {
    const r = contaVoti(voti(C), [A, B])
    expect(r.conteggi[0]).toEqual({ utenteId: C, voti: 1 })
    expect(r.eletti).toEqual([C])
  })

  it('l’ordine non dipende da quello di arrivo dei voti (a parità di voti, ordine stabile per id)', () => {
    const uno = contaVoti(voti(B, A, C))
    const due = contaVoti(voti(C, A, B))
    expect(uno.conteggi).toEqual(due.conteggi)
    expect(uno.eletti).toEqual(due.eletti)
  })

  it('non muta gli argomenti', () => {
    const v = voti(A, B)
    const z = [C]
    contaVoti(v, z)
    expect(v).toEqual(voti(A, B))
    expect(z).toEqual([C])
  })
})

describe('affluenza', () => {
  it('0 aventi diritto: 0 e non NaN né Infinity (Review Focus 4: classe senza genitori con account)', () => {
    expect(affluenza(0, 0)).toBe(0)
    expect(Number.isNaN(affluenza(0, 0))).toBe(false)
  })

  it('anche con votanti > 0 e aventi diritto 0 non divide per zero', () => {
    // Può succedere davvero: un voto già dato resta, e il bambino che cambia classe porta via l’avente
    // diritto. Meglio 0 che Infinity a schermo.
    expect(affluenza(3, 0)).toBe(0)
  })

  it('è una frazione fra 0 e 1', () => {
    expect(affluenza(12, 30)).toBeCloseTo(0.4, 10)
    expect(affluenza(0, 30)).toBe(0)
    expect(affluenza(30, 30)).toBe(1)
  })

  it('non taglia a 1: i voti già dati restano anche se l’avente diritto è uscito dalla classe', () => {
    expect(affluenza(5, 4)).toBeCloseTo(1.25, 10)
  })

  it('valori non finiti o negativi danno 0, mai NaN', () => {
    expect(affluenza(NaN, 10)).toBe(0)
    expect(affluenza(5, NaN)).toBe(0)
    expect(affluenza(5, -3)).toBe(0)
    expect(affluenza(5, Infinity)).toBe(0)
  })
})
