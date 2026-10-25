import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const h = vi.hoisted(() => ({ logClient: vi.fn() }))
vi.mock('@/lib/logging/client', () => ({
  logClient: h.logClient,
  nomeErrore: (e: unknown) => (e instanceof Error ? e.name : 'errore'),
}))

import { URL_CONSEGNA, fotografiaNonLetti, inviaConsegna, serveConsegna } from '@/lib/chat/consegna-conversazioni'

const riga = (id: string, nonLetti: number, ultimo = '2026-10-20T08:00:00.000Z') => ({
  id,
  unread_count: nonLetti,
  last_message_at: ultimo,
})

beforeEach(() => h.logClient.mockClear())
afterEach(() => vi.unstubAllGlobals())

describe('serveConsegna — solo quando la lista mostra non letti NUOVI', () => {
  it('prima lista con non letti: sì; senza: no', () => {
    expect(serveConsegna(null, [riga('a', 1), riga('b', 0)])).toBe(true)
    expect(serveConsegna(null, [riga('a', 0)])).toBe(false)
  })

  it('la stessa lista di prima: no', () => {
    const lista = [riga('a', 2), riga('b', 0)]
    expect(serveConsegna(fotografiaNonLetti(lista), lista)).toBe(false)
  })

  it('un thread con non letti cambia impronta (più non letti, o un messaggio più recente): sì', () => {
    const prima = fotografiaNonLetti([riga('a', 2)])
    expect(serveConsegna(prima, [riga('a', 3)])).toBe(true)
    expect(serveConsegna(prima, [riga('a', 2, '2026-10-20T08:05:00.000Z')])).toBe(true)
  })

  it('un thread passa a zero: no (non c’è niente da consegnare)', () => {
    expect(serveConsegna(fotografiaNonLetti([riga('a', 2)]), [riga('a', 0, '2026-10-20T08:05:00.000Z')])).toBe(false)
  })

  it('un thread nuovo con non letti: sì', () => {
    expect(serveConsegna(fotografiaNonLetti([riga('a', 0)]), [riga('a', 0), riga('n', 1)])).toBe(true)
  })
})

describe('inviaConsegna — una POST con corpo vuoto, che non rifiuta mai', () => {
  it('va all’URL della consegna, con `{}`; una risposta ok non logga', async () => {
    const f = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => ({ ok: true, status: 200 }) as Response)
    vi.stubGlobal('fetch', f)
    await inviaConsegna('/parent/chat')
    const [url, init] = f.mock.calls[0]
    expect(url).toBe(URL_CONSEGNA)
    expect(URL_CONSEGNA).toBe('/api/chat/threads/consegnati')
    const verbo = init?.method
    expect(verbo).toBe('POST')
    expect(init?.body).toBe('{}')
    expect(h.logClient).not.toHaveBeenCalled()
  })

  it('una risposta non ok: warn con lo stato (il livello finale lo decide `livelloEvento`)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 }) as Response))
    await inviaConsegna('/teacher/chat')
    expect(h.logClient).toHaveBeenCalledWith({
      livello: 'warn',
      evento: 'fetch',
      messaggio: 'chat-consegna-non-riuscita: http-500',
      route: '/teacher/chat',
      stato: 500,
    })
  })

  it('rete giù: warn con la classe dell’errore, e la promessa si risolve', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    await expect(inviaConsegna('/parent/chat')).resolves.toBeUndefined()
    expect(h.logClient).toHaveBeenCalledWith({
      livello: 'warn',
      evento: 'fetch',
      messaggio: 'chat-consegna-non-riuscita: TypeError',
      route: '/parent/chat',
    })
  })
})
