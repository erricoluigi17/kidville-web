import { describe, it, expect, beforeEach } from 'vitest'
import {
  MARGINE_FINESTRA_MS,
  apriFinestraDispatch,
  azzeraFinestreDispatch,
  chiudiFinestraDispatch,
  finestreDispatchAperte,
} from '@/lib/chat/finestra-dispatch'

const A = 'dddddddd-0000-4000-8000-0000000000a1'
const B = 'dddddddd-0000-4000-8000-0000000000b2'
const ATTESA = 30_000
const T0 = 1_000_000

beforeEach(() => azzeraFinestreDispatch())

describe('la finestra del dispatch anticipato, per conversazione', () => {
  it('il primo messaggio la apre e riceve un gettone', () => {
    expect(apriFinestraDispatch(A, ATTESA, T0)).toEqual(expect.any(Number))
  })

  it('un altro messaggio della stessa conversazione dentro la finestra non ne apre un’altra', () => {
    apriFinestraDispatch(A, ATTESA, T0)
    expect(apriFinestraDispatch(A, ATTESA, T0 + 29_000)).toBeNull()
  })

  it('un’altra conversazione ha la sua finestra', () => {
    apriFinestraDispatch(A, ATTESA, T0)
    expect(apriFinestraDispatch(B, ATTESA, T0 + 1)).not.toBeNull()
  })

  it('chiusa col suo gettone si riapre; un gettone sbagliato non la chiude', () => {
    const gettone = apriFinestraDispatch(A, ATTESA, T0)!
    chiudiFinestraDispatch(A, gettone + 1)
    expect(apriFinestraDispatch(A, ATTESA, T0 + 1)).toBeNull()
    chiudiFinestraDispatch(A, gettone)
    expect(apriFinestraDispatch(A, ATTESA, T0 + 2)).not.toBeNull()
  })

  it('scade da sola dopo attesa + margine: un giro che non arriva in fondo non la blocca per sempre', () => {
    apriFinestraDispatch(A, ATTESA, T0)
    expect(apriFinestraDispatch(A, ATTESA, T0 + ATTESA + MARGINE_FINESTRA_MS - 1)).toBeNull()
    expect(apriFinestraDispatch(A, ATTESA, T0 + ATTESA + MARGINE_FINESTRA_MS)).not.toBeNull()
  })

  // I numeri scritti per esteso: un test che legge solo la costante si adatta a una costante
  // cambiata (margine a zero compreso) e resta verde.
  it('con l’attesa di 30 s la finestra dura 45 s: il margine è 15 s', () => {
    expect(MARGINE_FINESTRA_MS).toBe(15_000)
    apriFinestraDispatch(A, ATTESA, T0)
    expect(apriFinestraDispatch(A, ATTESA, T0 + 44_999)).toBeNull()
    expect(apriFinestraDispatch(A, ATTESA, T0 + 45_000)).not.toBeNull()
  })

  it('la mappa non cresce senza limite: le finestre scadute di TUTTE le conversazioni si tolgono', () => {
    // Cento conversazioni i cui giri non sono mai arrivati in fondo (nessuna chiusura col gettone).
    for (let i = 0; i < 100; i++) apriFinestraDispatch(`thread-${i}`, ATTESA, T0)
    expect(finestreDispatchAperte()).toBe(100)
    // Il primo messaggio dopo la scadenza, di un'ALTRA conversazione, le porta via tutte.
    apriFinestraDispatch(B, ATTESA, T0 + 45_000)
    expect(finestreDispatchAperte()).toBe(1)
  })

  it('azzera le chiude tutte (serve ai test, come se fossero istanze nuove)', () => {
    apriFinestraDispatch(A, ATTESA, T0)
    azzeraFinestreDispatch()
    expect(apriFinestraDispatch(A, ATTESA, T0 + 1)).not.toBeNull()
  })
})
