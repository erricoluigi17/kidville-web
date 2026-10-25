import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * IL TOTALE DEI NON LETTI, IL TITOLO DELLA PAGINA E LA NOTIFICA DEL BROWSER (S7, sessione 12).
 *
 * Era `useUnreadNotifications`, con un suo orologio e una sua GET della lista. Ora è una funzione che
 * lavora sulla lista già scaricata da `useConversazioneChat`. Le decisioni di prima restano, e
 * restano provate qui:
 *  · RISERVATEZZA (spec 2026-09-24, W1): il titolo è SEMPRE «Nuovo messaggio in chat», senza testo,
 *    senza nome, senza conteggio, e senza `body`;
 *  · CLIC (2026-09-15): porta davanti la finestra e apre la conversazione più recente con non letti;
 *  · nessuna notifica a pagina a fuoco, a permesso negato, o se il totale non è salito;
 *  · il costruttore che lancia (Chrome Android) si registra col solo nome dell'errore.
 */

const h = vi.hoisted(() => ({ logClient: vi.fn() }))
vi.mock('@/lib/logging/client', () => ({
  logClient: h.logClient,
  nomeErrore: (e: unknown) => (e instanceof Error ? e.name : 'errore'),
}))

import { TITOLO_NOTIFICA_CHAT, annunciaNonLetti, totaleNonLetti } from '@/lib/chat/annuncio-non-letti'
import { ascoltaAperturaThread } from '@/lib/chat/apertura-thread'

const A = 'dddddddd-0000-4000-8000-0000000000a1'
const B = 'dddddddd-0000-4000-8000-0000000000b2'
const C = 'dddddddd-0000-4000-8000-0000000000c3'

/** Segnaposti riconoscibili: se compaiono in una notifica, il dato è trapelato. */
const NOME = 'NomeSegnaposto'
const COGNOME = 'CognomeSegnaposto'
const TESTO = 'testo segnaposto del messaggio riservato'

class NotificaFinta {
  static permission: NotificationPermission = 'granted'
  static create: NotificaFinta[] = []
  static lancia: Error | null = null
  onclick: (() => void) | null = null
  close = vi.fn()
  constructor(
    public titolo: string,
    public opzioni?: NotificationOptions,
  ) {
    if (NotificaFinta.lancia) throw NotificaFinta.lancia
    NotificaFinta.create.push(this)
  }
}

const riga = (id: string, nonLetti: number) => ({
  id,
  unread_count: nonLetti,
  other_user: { first_name: NOME, last_name: COGNOME },
  last_message: { content: TESTO },
})

const aSchermo = (n: NotificaFinta) => JSON.stringify({ titolo: n.titolo, opzioni: n.opzioni ?? null })

const pagineMontate: Array<() => void> = []
let focus: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  NotificaFinta.create = []
  NotificaFinta.lancia = null
  NotificaFinta.permission = 'granted'
  vi.stubGlobal('Notification', NotificaFinta)
  vi.spyOn(document, 'hasFocus').mockReturnValue(false)
  focus = vi.spyOn(window, 'focus').mockImplementation(() => {})
  document.title = 'prima del giro'
  h.logClient.mockClear()
})

afterEach(() => {
  while (pagineMontate.length) pagineMontate.pop()!()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('totaleNonLetti', () => {
  it('somma solo i numeri finiti e positivi', () => {
    expect(totaleNonLetti([riga(A, 2), riga(B, 3)])).toBe(5)
    expect(totaleNonLetti([{ id: A, unread_count: -1 }, { id: B, unread_count: Number.NaN }, { id: C, unread_count: null }, { id: 'x' }])).toBe(0)
  })
})

describe('annunciaNonLetti — riservatezza', () => {
  it('un messaggio nuovo: «Nuovo messaggio in chat», nessun corpo, né nome né testo, tag di prima', () => {
    expect(annunciaNonLetti([riga(A, 1)], 0)).toBe(1)
    expect(NotificaFinta.create).toHaveLength(1)
    const n = NotificaFinta.create[0]
    expect(n.titolo).toBe(TITOLO_NOTIFICA_CHAT)
    expect(n.titolo).toBe('Nuovo messaggio in chat')
    expect(n.opzioni?.body).toBeUndefined()
    expect(aSchermo(n)).not.toContain(NOME)
    expect(aSchermo(n)).not.toContain(COGNOME)
    expect(aSchermo(n)).not.toContain('segnaposto')
    expect(n.opzioni?.tag).toBe('kidville-chat')
  })

  it('più conversazioni: lo stesso titolo, senza conteggio', () => {
    annunciaNonLetti([riga(A, 2), riga(B, 3)], 0)
    expect(NotificaFinta.create).toHaveLength(1)
    const n = NotificaFinta.create[0]
    expect(n.titolo).toBe('Nuovo messaggio in chat')
    expect(n.opzioni?.body).toBeUndefined()
    expect(aSchermo(n)).not.toMatch(/\d+ nuovi messaggi/)
    expect(aSchermo(n)).not.toContain(NOME)
  })
})

describe('annunciaNonLetti — quando NON parte', () => {
  it('il totale non è salito: nessuna notifica, ma il titolo sì', () => {
    expect(annunciaNonLetti([riga(A, 3)], 3)).toBe(3)
    expect(NotificaFinta.create).toHaveLength(0)
    expect(document.title).toBe('(3) Kidville')
  })

  it('il totale è sceso: nessuna notifica, e il titolo segue il totale nuovo', () => {
    expect(annunciaNonLetti([riga(A, 1)], 4)).toBe(1)
    expect(NotificaFinta.create).toHaveLength(0)
    expect(document.title).toBe('(1) Kidville')
  })

  it('nessun non letto: titolo «Kidville», nessuna notifica', () => {
    expect(annunciaNonLetti([riga(A, 0)], 0)).toBe(0)
    expect(document.title).toBe('Kidville')
    expect(NotificaFinta.create).toHaveLength(0)
  })

  it('pagina a fuoco: nessuna notifica', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    annunciaNonLetti([riga(A, 1)], 0)
    expect(NotificaFinta.create).toHaveLength(0)
    expect(document.title).toBe('(1) Kidville')
  })

  it('permesso negato: nessuna notifica', () => {
    NotificaFinta.permission = 'denied'
    annunciaNonLetti([riga(A, 1)], 0)
    expect(NotificaFinta.create).toHaveLength(0)
  })

  it('il costruttore lancia: warn «push» col solo nome dell’errore', () => {
    NotificaFinta.lancia = new TypeError(`Illegal constructor ${TESTO}`)
    annunciaNonLetti([riga(A, 1)], 0)
    expect(h.logClient).toHaveBeenCalledWith({
      livello: 'warn',
      evento: 'push',
      messaggio: 'chat-notifica-browser-non-mostrata: TypeError',
    })
    expect(JSON.stringify(h.logClient.mock.calls)).not.toContain('segnaposto')
  })
})

describe('annunciaNonLetti — il clic e la chiusura', () => {
  it('una conversazione sola: il clic apre quella', () => {
    const pagina = vi.fn()
    pagineMontate.push(ascoltaAperturaThread(pagina))
    annunciaNonLetti([riga(A, 1)], 0)
    NotificaFinta.create[0].onclick!()
    expect(pagina.mock.calls).toEqual([[A]])
  })

  it('il clic porta davanti la finestra e apre la più recente con non letti', () => {
    const pagina = vi.fn()
    pagineMontate.push(ascoltaAperturaThread(pagina))
    annunciaNonLetti([riga(A, 0), riga(B, 2), riga(C, 1)], 0)
    const n = NotificaFinta.create[0]
    n.onclick!()
    expect(pagina.mock.calls).toEqual([[B]])
    expect(focus).toHaveBeenCalledTimes(1)
    expect(n.close).toHaveBeenCalled()
  })

  it('senza una pagina chat in ascolto il clic porta solo la finestra davanti, senza errori né log', () => {
    annunciaNonLetti([riga(A, 1)], 0)
    const n = NotificaFinta.create[0]
    expect(() => n.onclick!()).not.toThrow()
    expect(focus).toHaveBeenCalledTimes(1)
    expect(n.close).toHaveBeenCalled()
    expect(h.logClient).not.toHaveBeenCalled()
  })

  it('si chiude da sola dopo 5 s', () => {
    vi.useFakeTimers()
    annunciaNonLetti([riga(A, 1)], 0)
    const n = NotificaFinta.create[0]
    vi.advanceTimersByTime(4_999)
    expect(n.close).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(n.close).toHaveBeenCalledTimes(1)
  })
})
