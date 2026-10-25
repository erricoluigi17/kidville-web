import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ logEvento: vi.fn() }))
vi.mock('@/lib/logging/logger', () => ({ logEvento: h.logEvento }))

import { RPC_RIEPILOGO_ASSENTE, esitoRiepilogo } from '@/lib/chat/riepilogo-conversazioni'

const OP = 'chat/threads:GET'
const TA = 'dddddddd-0000-4000-8000-0000000000a1'

beforeEach(() => h.logEvento.mockClear())

describe('esitoRiepilogo — la risposta della RPC diventa ok, assente o guasto', () => {
  it('una lista di righe con id: ok, nessun log', () => {
    const righe = [{ id: TA, unread_count: 2 }]
    expect(esitoRiepilogo({ data: righe, error: null }, OP)).toEqual({ esito: 'ok', threads: righe })
    expect(h.logEvento).not.toHaveBeenCalled()
  })

  it('una lista vuota è ok (nessuna conversazione)', () => {
    expect(esitoRiepilogo({ data: [], error: null }, OP)).toEqual({ esito: 'ok', threads: [] })
  })

  it.each(['PGRST202', '42883'])('%s: la funzione non c’è → assente, riga `info` col codice', (codice) => {
    expect(RPC_RIEPILOGO_ASSENTE.has(codice)).toBe(true)
    expect(esitoRiepilogo({ data: null, error: { code: codice, message: 'x' } }, OP)).toEqual({ esito: 'assente' })
    expect(h.logEvento).toHaveBeenCalledWith('chat', 'info', {
      operazione: OP,
      esito: 'riepilogo-non-installato',
      error_code: codice,
      ripiego: true,
    })
  })

  it.each(['57014', '42P01', '42703', 'PGRST203'])('%s: un guasto vero → guasto, riga `error` con l’errore intero', (codice) => {
    const errore = { code: codice, message: 'x' }
    expect(esitoRiepilogo({ data: null, error: errore }, OP)).toEqual({ esito: 'guasto' })
    expect(h.logEvento).toHaveBeenCalledWith(
      'chat',
      'error',
      { operazione: OP, esito: 'riepilogo-rpc-fallito', error_code: codice, ripiego: true },
      errore,
    )
  })

  it('un errore senza codice si dice «sconosciuto»', () => {
    esitoRiepilogo({ data: null, error: { message: 'x' } }, OP)
    expect(h.logEvento.mock.calls[0][2]).toMatchObject({ error_code: 'sconosciuto' })
  })

  it.each([
    ['un oggetto', { non: 'una lista' }],
    ['una riga senza id', [{ unread_count: 1 }]],
    ['niente del tutto', null],
  ])('forma inattesa (%s) → guasto, riga `error`', (_nome, data) => {
    expect(esitoRiepilogo({ data, error: null }, OP)).toEqual({ esito: 'guasto' })
    expect(h.logEvento).toHaveBeenCalledWith('chat', 'error', { operazione: OP, esito: 'riepilogo-forma-inattesa', ripiego: true })
  })
})
