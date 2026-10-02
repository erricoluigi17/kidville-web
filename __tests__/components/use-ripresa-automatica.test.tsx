import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * LA RIPRESA AUTOMATICA — senza che nessuno prema niente.
 *
 * Il criterio, prima dei test: un caricamento che la rete interrompe deve ripartire **da solo**, e
 * senza diventare una tempesta di richieste. Quindi: subito al ritorno in primo piano e quando torna
 * la rete (sono notizie), e altrimenti con un'attesa che CRESCE — 5, 15, 30, 60 secondi — contata
 * dalla FINE di ogni tentativo, mai a pagina nascosta, mai senza rete, mai quando non c'è più niente
 * di interrotto.
 *
 * Gli orologi sono finti, e ogni test di ASSENZA («non è ripartito») è preceduto da una presenza che
 * prova che l'orologio girava: un'assenza vera anche quando l'hook non fa niente non prova niente.
 */

const h = vi.hoisted(() => ({ logClient: vi.fn() }))
vi.mock('@/lib/logging/client', () => ({
  logClient: h.logClient,
  nomeErrore: (e: unknown) => (e instanceof Error ? e.constructor.name : 'Sconosciuto'),
}))

import { RITARDI_RIPRESA_MS, useRipresaAutomatica, type MotivoRipresa } from '@/components/features/gallery/use-ripresa-automatica'

let nascosta = false
let senzaRete = false

function impostaVisibilita(valore: boolean) {
  nascosta = valore
  document.dispatchEvent(new Event('visibilitychange'))
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  nascosta = false
  senzaRete = false
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => nascosta })
  vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => !senzaRete)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  Reflect.deleteProperty(document, 'hidden')
})

/** Fa passare `ms` di tempo finto, lasciando girare le promesse che ne dipendono. */
async function passa(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

function monta(riprendi: (m: MotivoRipresa) => void | Promise<void>, attiva = true) {
  return renderHook((p: { attiva: boolean }) => useRipresaAutomatica({ attiva: p.attiva, riprendi }), {
    initialProps: { attiva },
  })
}

describe('l’attesa cresce: 5, 15, 30, 60 secondi, e poi resta a 60', () => {
  it('il primo tentativo dopo 5 s, poi 15 s dopo la fine del primo, poi 30, poi 60, poi ancora 60', async () => {
    const riprendi = vi.fn(async () => undefined)
    monta(riprendi)

    expect(RITARDI_RIPRESA_MS).toEqual([5_000, 15_000, 30_000, 60_000])
    await passa(4_999)
    expect(riprendi).not.toHaveBeenCalled()
    await passa(1)
    expect(riprendi).toHaveBeenCalledTimes(1)
    expect(riprendi).toHaveBeenLastCalledWith('backoff')

    await passa(14_999)
    expect(riprendi).toHaveBeenCalledTimes(1)
    await passa(1)
    expect(riprendi).toHaveBeenCalledTimes(2)

    await passa(29_999)
    expect(riprendi).toHaveBeenCalledTimes(2)
    await passa(1)
    expect(riprendi).toHaveBeenCalledTimes(3)

    await passa(59_999)
    expect(riprendi).toHaveBeenCalledTimes(3)
    await passa(1)
    expect(riprendi).toHaveBeenCalledTimes(4)

    // Dopo l'ultima attesa si resta lì: ogni 60 secondi, non più spesso e non più di rado.
    await passa(60_000)
    expect(riprendi).toHaveBeenCalledTimes(5)
    await passa(60_000)
    expect(riprendi).toHaveBeenCalledTimes(6)
  })

  it('l’attesa conta dalla FINE del tentativo: un trasferimento lungo non si accavalla col successivo', async () => {
    let finisci!: () => void
    const riprendi = vi.fn(() => new Promise<void>((risolvi) => { finisci = risolvi }))
    monta(riprendi)

    await passa(5_000)
    expect(riprendi).toHaveBeenCalledTimes(1)
    // Il tentativo dura venti secondi: nemmeno dopo 15 s (l'attesa successiva) ne parte un altro.
    await passa(20_000)
    expect(riprendi).toHaveBeenCalledTimes(1)
    await act(async () => finisci())
    await passa(14_999)
    expect(riprendi).toHaveBeenCalledTimes(1)
    await passa(1)
    expect(riprendi).toHaveBeenCalledTimes(2)
  })

  it('quando non c’è più niente di interrotto l’orologio si ferma; se ricompare, l’attesa continua dal gradino dov’era', async () => {
    const riprendi = vi.fn(async () => undefined)
    const { rerender } = monta(riprendi)
    await passa(5_000)
    expect(riprendi).toHaveBeenCalledTimes(1)

    rerender({ attiva: false })
    await passa(10 * 60_000)
    expect(riprendi).toHaveBeenCalledTimes(1)

    // Il gradino da 5 secondi è già stato scontato dal tentativo di prima: il prossimo è quello da 15.
    // Il conto dei tentativi si azzera con una NOTIZIA (rete tornata, ritorno in primo piano,
    // `azzera()`), non perché la ripresa si è spenta e riaccesa.
    rerender({ attiva: true })
    await passa(14_999)
    expect(riprendi).toHaveBeenCalledTimes(1)
    await passa(1)
    expect(riprendi).toHaveBeenCalledTimes(2)
  })

  it('il conto dei tentativi SOPRAVVIVE a ogni spegnimento: 5, 15, 30, 60 anche se `attiva` si spegne a ogni giro', async () => {
    // È ciò che succede nell'hook della galleria: ogni tentativo porta la riga a «in caricamento»
    // (`attiva = false`) e, quando la rete lo interrompe, di nuovo a «interrotto» (`attiva = true`).
    // Con il conto dentro l'effetto l'attesa ripartiva da 5 secondi a ogni giro: misurato, un
    // tentativo ogni 7 secondi per ore.
    const riprendi = vi.fn(async () => undefined)
    const { rerender } = monta(riprendi)
    const gradini = [5_000, 15_000, 30_000, 60_000, 60_000]
    for (const [i, attesa] of gradini.entries()) {
      await passa(attesa - 1)
      expect(riprendi, `il tentativo ${i + 1} è partito prima di ${attesa / 1000} secondi`).toHaveBeenCalledTimes(i)
      await passa(1)
      expect(riprendi).toHaveBeenCalledTimes(i + 1)
      // Il tentativo gira due secondi (la riga è «in caricamento») e poi la rete lo interrompe.
      rerender({ attiva: false })
      await passa(2_000)
      rerender({ attiva: true })
    }
  })

  it('senza righe interrotte (`attiva: false`) non si arma niente, nemmeno col tempo', async () => {
    const riprendi = vi.fn(async () => undefined)
    monta(riprendi, false)
    await passa(10 * 60_000)
    expect(riprendi).not.toHaveBeenCalled()
  })

  it('smontato, l’orologio non gira più', async () => {
    const riprendi = vi.fn(async () => undefined)
    const { unmount } = monta(riprendi)
    await passa(5_000)
    expect(riprendi).toHaveBeenCalledTimes(1)
    unmount()
    await passa(10 * 60_000)
    expect(riprendi).toHaveBeenCalledTimes(1)
  })

  it('un giro che lancia non ferma l’orologio e lascia una riga che lo dice', async () => {
    const riprendi = vi.fn(async () => {
      throw new TypeError('rete')
    })
    monta(riprendi)
    await passa(5_000)
    expect(h.logClient).toHaveBeenCalledWith(
      expect.objectContaining({ livello: 'error', messaggio: 'video-ripresa-automatica-interrotta' }),
    )
    // L'attesa successiva c'è comunque.
    await passa(15_000)
    expect(riprendi).toHaveBeenCalledTimes(2)
  })
})

describe('`azzera()`: un trasferimento arrivato in fondo è una buona notizia', () => {
  it('con l’orologio armato il tentativo seguente arriva dopo 5 secondi, non dopo il gradino che aspettava', async () => {
    const riprendi = vi.fn(async () => undefined)
    const { result } = monta(riprendi)
    await passa(5_000)
    await passa(15_000)
    expect(riprendi).toHaveBeenCalledTimes(2) // ora l'attesa davanti è di 30 secondi

    act(() => result.current.azzera())
    await passa(4_999)
    expect(riprendi).toHaveBeenCalledTimes(2)
    await passa(1)
    expect(riprendi).toHaveBeenCalledTimes(3)
    expect(riprendi).toHaveBeenLastCalledWith('backoff')
  })

  it('senza righe interrotte azzera il conto: alla prossima interruzione si riparte da 5 secondi', async () => {
    const riprendi = vi.fn(async () => undefined)
    const { result, rerender } = monta(riprendi)
    await passa(5_000)
    await passa(15_000)
    expect(riprendi).toHaveBeenCalledTimes(2)

    rerender({ attiva: false })
    act(() => result.current.azzera())
    // Nessun orologio armato: azzerare non fa partire niente.
    await passa(10 * 60_000)
    expect(riprendi).toHaveBeenCalledTimes(2)

    rerender({ attiva: true })
    await passa(4_999)
    expect(riprendi).toHaveBeenCalledTimes(2)
    await passa(1)
    expect(riprendi).toHaveBeenCalledTimes(3)
  })

  it('è la stessa funzione a ogni render: chi la tiene in un ref non la perde', async () => {
    const riprendi = vi.fn(async () => undefined)
    const { result, rerender } = monta(riprendi)
    const prima = result.current.azzera
    rerender({ attiva: false })
    rerender({ attiva: true })
    expect(result.current.azzera).toBe(prima)
  })
})

describe('le notizie azzerano l’attesa: la rete torna, la pagina torna in primo piano', () => {
  it('l’evento `online` riprende SUBITO e l’attesa riparte da 5 secondi', async () => {
    const riprendi = vi.fn(async () => undefined)
    monta(riprendi)
    // Porta l'attesa a 15 s (un tentativo fatto)…
    await passa(5_000)
    expect(riprendi).toHaveBeenCalledTimes(1)

    await act(async () => {
      window.dispatchEvent(new Event('online'))
    })
    expect(riprendi).toHaveBeenCalledTimes(2)
    expect(riprendi).toHaveBeenLastCalledWith('online')
    // …e dopo la notizia si ricomincia da 5, non da 15.
    await passa(4_999)
    expect(riprendi).toHaveBeenCalledTimes(2)
    await passa(1)
    expect(riprendi).toHaveBeenCalledTimes(3)
    expect(riprendi).toHaveBeenLastCalledWith('backoff')
  })

  it('il ritorno in primo piano riprende SUBITO, con il suo motivo', async () => {
    const riprendi = vi.fn(async () => undefined)
    monta(riprendi)
    await passa(2_000)

    // Lo schermo si spegne… e si riaccende.
    await act(async () => impostaVisibilita(true))
    await passa(2_000)
    await act(async () => impostaVisibilita(false))
    expect(riprendi).toHaveBeenCalledWith('visibilita')
  })

  it('a pagina NASCOSTA l’orologio tace; al ritorno si riprende e l’attesa riparte da 5 s', async () => {
    const riprendi = vi.fn(async () => undefined)
    monta(riprendi)
    await passa(5_000)
    expect(riprendi).toHaveBeenCalledTimes(1) // l'orologio girava

    await act(async () => impostaVisibilita(true))
    await passa(10 * 60_000)
    expect(riprendi).toHaveBeenCalledTimes(1) // nascosta: nessun tentativo

    await act(async () => impostaVisibilita(false))
    expect(riprendi).toHaveBeenCalledTimes(2)
    expect(riprendi).toHaveBeenLastCalledWith('visibilita')
    await passa(5_000)
    expect(riprendi).toHaveBeenCalledTimes(3)
    expect(riprendi).toHaveBeenLastCalledWith('backoff')
  })
})

describe('a pagina nascosta non si tenta, nemmeno se è nascosta fin dall’inizio', () => {
  it('montata con la pagina nascosta, l’orologio non parte; al ritorno si riprende subito e l’attesa riparte da 5 s', async () => {
    const riprendi = vi.fn(async () => undefined)
    nascosta = true
    monta(riprendi)
    await passa(10 * 60_000)
    expect(riprendi).not.toHaveBeenCalled()

    await act(async () => impostaVisibilita(false))
    expect(riprendi).toHaveBeenCalledTimes(1)
    expect(riprendi).toHaveBeenLastCalledWith('visibilita')
    await passa(5_000)
    expect(riprendi).toHaveBeenCalledTimes(2)
    expect(riprendi).toHaveBeenLastCalledWith('backoff')
  })
})

describe('senza rete non si tenta', () => {
  it('l’orologio salta il giro (nessun tentativo, nessuna riga) e `online` riprende', async () => {
    const riprendi = vi.fn(async () => undefined)
    monta(riprendi)
    await passa(5_000)
    expect(riprendi).toHaveBeenCalledTimes(1) // la rete c'era: l'orologio girava

    senzaRete = true
    await passa(10 * 60_000)
    expect(riprendi).toHaveBeenCalledTimes(1)
    expect(h.logClient).not.toHaveBeenCalled()

    senzaRete = false
    await act(async () => {
      window.dispatchEvent(new Event('online'))
    })
    expect(riprendi).toHaveBeenCalledTimes(2)
    expect(riprendi).toHaveBeenLastCalledWith('online')
  })

  it('tornata la rete SENZA un evento, l’orologio riprende da solo al giro dopo', async () => {
    const riprendi = vi.fn(async () => undefined)
    senzaRete = true
    monta(riprendi)
    await passa(5_000)
    expect(riprendi).not.toHaveBeenCalled()
    senzaRete = false
    await passa(5_000)
    expect(riprendi).toHaveBeenCalledTimes(1)
    expect(riprendi).toHaveBeenLastCalledWith('backoff')
  })
})
