import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('@/lib/logging/client', () => ({
  nomeErrore: (e: unknown) => (e instanceof Error ? e.name : 'errore'),
}))

import { scaricaListaConversazioni } from '@/lib/chat/lista-conversazioni'

const IO = 'aaaaaaaa-0000-4000-8000-0000000000e1'

function rispondi(risposta: Partial<Response> | Error) {
  const f = vi.fn<(url: string) => Promise<Response>>(async () => {
    if (risposta instanceof Error) throw risposta
    return risposta as Response
  })
  vi.stubGlobal('fetch', f)
  return f
}

afterEach(() => vi.unstubAllGlobals())

describe('scaricaListaConversazioni — un esito, mai un rifiuto', () => {
  it('una lista: { lista }, con l’URL di prima', async () => {
    const f = rispondi({ ok: true, status: 200, json: async () => [{ id: 'th-a' }] })
    expect(await scaricaListaConversazioni(IO)).toEqual({ lista: [{ id: 'th-a' }] })
    expect(f).toHaveBeenCalledWith(`/api/chat/threads?userId=${IO}`)
  })

  it.each([500, 401])('HTTP %i: { guasto: http-<stato>, http }', async (stato) => {
    rispondi({ ok: false, status: stato, json: async () => ({}) })
    expect(await scaricaListaConversazioni(IO)).toEqual({ guasto: `http-${stato}`, http: stato })
  })

  it('rete giù: la classe dell’errore, mai il messaggio (che porta l’URL con l’id)', async () => {
    rispondi(new TypeError(`Failed to fetch /api/chat/threads?userId=${IO}`))
    const esito = await scaricaListaConversazioni(IO)
    expect(esito).toEqual({ guasto: 'TypeError', http: null })
    expect(JSON.stringify(esito)).not.toContain(IO)
  })

  it('corpo che non è JSON: SyntaxError', async () => {
    rispondi({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <') } })
    expect(await scaricaListaConversazioni(IO)).toEqual({ guasto: 'SyntaxError', http: null })
  })

  it('JSON che non è una lista: forma-inattesa', async () => {
    rispondi({ ok: true, status: 200, json: async () => ({ error: 'x' }) })
    expect(await scaricaListaConversazioni(IO)).toEqual({ guasto: 'forma-inattesa', http: null })
  })
})
