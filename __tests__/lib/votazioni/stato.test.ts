import { describe, expect, it } from 'vitest'
import { statoVotazione } from '@/lib/votazioni/stato'

/**
 * LO STATO DI UNA VOTAZIONE: una funzione sola, due ingressi, nessun campo salvato.
 *
 * «Aperta» non è una colonna: si ricava dall'orologio e da `chiusa_il`. Se lo stato fosse scritto nel
 * database, una votazione scaduta alle 18:00 resterebbe «aperta» fino al primo job che la chiude — e fino
 * ad allora una pagina lasciata aperta continuerebbe ad accettare voti. Qui la scadenza chiude da sola,
 * all'istante esatto.
 *
 * Le date sono fisse e DICHIARATE, non relative a `new Date()`: il test non deve scadere col calendario.
 * L'unico caso che usa l'orologio vero (il default di `adesso`) lo fa con scarti di un'ora, in entrambi i
 * versi, e vale oggi come fra dieci anni.
 */

const SCADENZA = '2026-11-20T17:00:00.000Z'
const MS = new Date(SCADENZA).getTime()

describe('statoVotazione', () => {
  it('è aperta un istante (1 ms) prima della scadenza', () => {
    expect(statoVotazione({ scadenza: SCADENZA, chiusaIl: null }, new Date(MS - 1))).toBe('aperta')
  })

  it('è chiusa all’istante esatto della scadenza: la scadenza non è inclusa', () => {
    expect(statoVotazione({ scadenza: SCADENZA, chiusaIl: null }, new Date(MS))).toBe('chiusa')
  })

  it('è chiusa dopo la scadenza', () => {
    expect(statoVotazione({ scadenza: SCADENZA, chiusaIl: null }, new Date(MS + 1))).toBe('chiusa')
    expect(statoVotazione({ scadenza: SCADENZA, chiusaIl: null }, new Date(MS + 7 * 24 * 3600_000))).toBe('chiusa')
  })

  it('è chiusa se `chiusaIl` è valorizzato, anche con la scadenza ancora lontana (chiusura a mano)', () => {
    const chiusaIl = '2026-11-10T09:00:00.000Z'
    expect(statoVotazione({ scadenza: SCADENZA, chiusaIl }, new Date('2026-11-10T09:00:01.000Z'))).toBe('chiusa')
    // Anche guardandola PRIMA dell’ora di chiusura (orologio indietro, riga letta in ritardo): una riga
    // chiusa a mano non si riapre per un confronto di orologi.
    expect(statoVotazione({ scadenza: SCADENZA, chiusaIl }, new Date('2026-11-01T00:00:00.000Z'))).toBe('chiusa')
  })

  it('una proroga la riapre: stessa riga, scadenza nuova nel futuro, `chiusaIl` ancora nullo', () => {
    const scaduta = { scadenza: SCADENZA, chiusaIl: null }
    const adesso = new Date(MS + 3600_000)
    expect(statoVotazione(scaduta, adesso)).toBe('chiusa')
    const prorogata = { ...scaduta, scadenza: new Date(MS + 24 * 3600_000).toISOString() }
    expect(statoVotazione(prorogata, adesso)).toBe('aperta')
  })

  it('una scadenza illeggibile chiude: nel dubbio non si accettano voti', () => {
    expect(statoVotazione({ scadenza: 'non-una-data', chiusaIl: null }, new Date(MS - 1))).toBe('chiusa')
    expect(statoVotazione({ scadenza: '', chiusaIl: null }, new Date(MS - 1))).toBe('chiusa')
  })

  it('senza il secondo argomento guarda l’orologio vero', () => {
    const unOra = 3600_000
    expect(statoVotazione({ scadenza: new Date(Date.now() + unOra).toISOString(), chiusaIl: null })).toBe('aperta')
    expect(statoVotazione({ scadenza: new Date(Date.now() - unOra).toISOString(), chiusaIl: null })).toBe('chiusa')
  })
})
