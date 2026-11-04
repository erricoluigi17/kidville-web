import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AppUser } from '@/lib/auth/predicati-ruolo'

// `applicaRettificaStorica` ha un solo comportamento nuovo, ed è a richiesta: `ripiegoSchema`. Questi casi
// fissano che chi non lo chiede (tutti gli altri chiamanti) resta identico a prima, e che chi lo chiede riceve
// il segnale di schema SENZA il log `error` della rettifica.

const log = vi.hoisted(() => ({ logEvento: vi.fn() }))
vi.mock('@/lib/logging/logger', async (originale) => ({
  ...(await originale<typeof import('@/lib/logging/logger')>()),
  logEvento: (...a: unknown[]) => log.logEvento(...a),
}))

import { applicaRettificaStorica } from '@/lib/primaria/rettifica-storica'

const attore: AppUser = { id: 'd1919e00-0000-4000-8000-000000000001', role: 'segreteria' }

function db(error: { code: string; message?: string } | null): SupabaseClient {
  return { rpc: async () => ({ data: error ? null : [{ righe: [{ id: 'x' }] }], error }) } as unknown as SupabaseClient
}

const input = (extra: { ripiegoSchema?: boolean } = {}) => ({
  attore,
  scuolaId: 'aaaaaaaa-0000-4000-8000-00000000000a',
  modulo: 'valutazioni',
  giorno: '2026-10-05',
  attese: [],
  azioni: [],
  ...extra,
})
const logErrore = () => log.logEvento.mock.calls.filter(([, livello, campi]) => livello === 'error' && campi?.esito === 'rettifica-non-applicata')

beforeEach(() => vi.clearAllMocks())

describe('applicaRettificaStorica — ripiego di schema a richiesta', () => {
  it('con il flag e 42703: 503 con schemaIndietro, e NESSUN log error', async () => {
    const r = await applicaRettificaStorica(db({ code: '42703', message: 'x' }), input({ ripiegoSchema: true }))

    expect('response' in r && r.response.status).toBe(503)
    expect('response' in r && r.schemaIndietro).toMatchObject({ code: '42703' })
    expect(logErrore()).toHaveLength(0)
  })

  it('con il flag e PGRST204: stesso ripiego', async () => {
    const r = await applicaRettificaStorica(db({ code: 'PGRST204' }), input({ ripiegoSchema: true }))

    expect('response' in r && r.schemaIndietro).toMatchObject({ code: 'PGRST204' })
    expect(logErrore()).toHaveLength(0)
  })

  it('senza il flag, 42703 è quello di sempre: 503, log error, niente schemaIndietro', async () => {
    const r = await applicaRettificaStorica(db({ code: '42703', message: 'x' }), input())

    expect('response' in r && r.response.status).toBe(503)
    expect(r).not.toHaveProperty('schemaIndietro')
    expect(logErrore()).toHaveLength(1)
  })

  it('con il flag, un errore che non è di schema resta un guasto: 409 per 40001, log error, niente schemaIndietro', async () => {
    const r = await applicaRettificaStorica(db({ code: '40001', message: 'fonte cambiata' }), input({ ripiegoSchema: true }))

    expect('response' in r && r.response.status).toBe(409)
    expect(r).not.toHaveProperty('schemaIndietro')
    expect(logErrore()).toHaveLength(1)
  })

  it('con il flag e nessun errore: le righe, come sempre', async () => {
    const r = await applicaRettificaStorica(db(null), input({ ripiegoSchema: true }))

    expect(r).toEqual({ righe: [[{ id: 'x' }]] })
    expect(log.logEvento).toHaveBeenCalledWith('registro', 'info', expect.objectContaining({ esito: 'rettifica-applicata' }))
  })
})
