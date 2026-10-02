import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * GLI INTENTI TOLTI DALLA SCHEDA — ricordati sul dispositivo, e mai altro.
 *
 * L'elenco del server riporta per sette giorni anche gli intenti conclusi, e un intento del flusso
 * vecchio resta «da ricaricare» qualunque sia il suo stato: «Togli» non basta a farlo uscire. Qui si
 * tiene fermo che il ricordo regge fra due letture, non cresce per sempre, non si mescola fra utenti
 * e — se il deposito del browser manca o si rompe — non rompe niente e lo dice una volta sola.
 */

const h = vi.hoisted(() => ({ logClient: vi.fn() }))
vi.mock('@/lib/logging/client', () => ({
  logClient: h.logClient,
  nomeErrore: (e: unknown) => (e instanceof Error ? e.constructor.name : 'Sconosciuto'),
}))

import { leggiNascosti, nascondiIntento, type DepositoNascosti } from '@/components/features/gallery/video-galleria-nascosti'

const UTENTE = 'aaaa1111-0000-4000-8000-000000000001'
const ALTRO_UTENTE = 'aaaa1111-0000-4000-8000-000000000002'
const A = '11111111-0000-4000-8000-00000000000a'
const B = '11111111-0000-4000-8000-00000000000b'
const GIORNO = 24 * 60 * 60 * 1000
const ADESSO = Date.UTC(2026, 9, 2, 10, 0, 0)

function deposito(): DepositoNascosti & { dati: Map<string, string> } {
  const dati = new Map<string, string>()
  return {
    dati,
    getItem: (k) => dati.get(k) ?? null,
    setItem: (k, v) => void dati.set(k, v),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('nascondiIntento / leggiNascosti', () => {
  it('quello che si toglie resta tolto alla lettura successiva', () => {
    const d = deposito()
    expect(leggiNascosti(UTENTE, ADESSO, d).size).toBe(0)
    nascondiIntento(UTENTE, A, ADESSO, d)
    expect([...leggiNascosti(UTENTE, ADESSO + 60_000, d)]).toEqual([A])
    nascondiIntento(UTENTE, B, ADESSO + 1, d)
    expect([...leggiNascosti(UTENTE, ADESSO + 60_000, d)].sort()).toEqual([A, B].sort())
  })

  it('restituisce subito l’insieme aggiornato, senza una seconda lettura', () => {
    const d = deposito()
    nascondiIntento(UTENTE, A, ADESSO, d)
    expect([...nascondiIntento(UTENTE, B, ADESSO, d)].sort()).toEqual([A, B].sort())
  })

  it('ogni utente ha il suo: su un PC condiviso la scheda tolta da una persona non sparisce all’altra', () => {
    const d = deposito()
    nascondiIntento(UTENTE, A, ADESSO, d)
    expect(leggiNascosti(ALTRO_UTENTE, ADESSO, d).size).toBe(0)
  })

  it('dopo otto giorni la voce si butta: la lista non cresce per sempre', () => {
    const d = deposito()
    nascondiIntento(UTENTE, A, ADESSO, d)
    expect(leggiNascosti(UTENTE, ADESSO + 8 * GIORNO - 1, d).has(A)).toBe(true)
    expect(leggiNascosti(UTENTE, ADESSO + 8 * GIORNO, d).has(A)).toBe(false)
  })

  it('tiene al massimo cento voci, e butta le più vecchie', () => {
    const d = deposito()
    for (let i = 0; i < 105; i++) nascondiIntento(UTENTE, `id-${String(i).padStart(3, '0')}`, ADESSO + i, d)
    const tenuti = leggiNascosti(UTENTE, ADESSO + 200, d)
    expect(tenuti.size).toBe(100)
    expect(tenuti.has('id-000')).toBe(false)
    expect(tenuti.has('id-104')).toBe(true)
  })

  it('nel deposito finiscono solo uuid di intenti e istanti: niente che identifichi una persona', () => {
    const d = deposito()
    nascondiIntento(UTENTE, A, ADESSO, d)
    const scritto = [...d.dati.values()].join('')
    expect(JSON.parse(scritto)).toEqual({ [A]: ADESSO })
  })
})

describe('un deposito che manca o si rompe non rompe la schermata', () => {
  it('senza deposito (`null`) si legge vuoto e «Togli» funziona comunque in memoria', () => {
    expect(leggiNascosti(UTENTE, ADESSO, null).size).toBe(0)
    expect([...nascondiIntento(UTENTE, A, ADESSO, null)]).toEqual([A])
  })

  it('un contenuto illeggibile vale «nessuno», e lascia UNA riga per sessione (non una a ogni lettura)', async () => {
    // Il «una volta sola» è uno stato del modulo: si rilegge il modulo da zero, o il risultato
    // dipenderebbe da quale test è girato prima.
    vi.resetModules()
    const fresco = await import('@/components/features/gallery/video-galleria-nascosti')
    const d = deposito()
    d.dati.set(`kv:video-galleria-nascosti:${UTENTE}`, '{non json')
    expect(fresco.leggiNascosti(UTENTE, ADESSO, d).size).toBe(0)
    expect(fresco.leggiNascosti(UTENTE, ADESSO, d).size).toBe(0)
    const righe = h.logClient.mock.calls.filter(([e]) => (e as { messaggio: string }).messaggio === 'video-galleria-nascosti-non-disponibili')
    expect(righe).toHaveLength(1)
    expect(righe[0][0]).toMatchObject({ livello: 'warn', campi: { motivo: 'forma' } })
  })

  it('una forma sbagliata (un array, una voce con un valore strano) non produce intenti inventati', () => {
    const d = deposito()
    d.dati.set(`kv:video-galleria-nascosti:${UTENTE}`, JSON.stringify([A, B]))
    expect(leggiNascosti(UTENTE, ADESSO, d).size).toBe(0)
    d.dati.set(`kv:video-galleria-nascosti:${UTENTE}`, JSON.stringify({ [A]: 'ieri', [B]: ADESSO }))
    expect([...leggiNascosti(UTENTE, ADESSO, d)]).toEqual([B])
  })

  it('una scrittura che lancia (deposito pieno) non lancia: la scheda si toglie lo stesso, e lo dice', async () => {
    vi.resetModules()
    const fresco = await import('@/components/features/gallery/video-galleria-nascosti')
    const rotto: DepositoNascosti = {
      getItem: () => null,
      setItem: () => {
        throw new DOMException('quota', 'QuotaExceededError')
      },
    }
    expect([...fresco.nascondiIntento(UTENTE, A, ADESSO, rotto)]).toEqual([A])
    expect(h.logClient).toHaveBeenCalledWith(
      expect.objectContaining({ livello: 'warn', campi: expect.objectContaining({ motivo: 'scrittura' }) }),
    )
  })
})
