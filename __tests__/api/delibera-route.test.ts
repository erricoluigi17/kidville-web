import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  subs: [] as { id: string; score: number }[],
  updates: [] as { id: unknown; row: Record<string, unknown> }[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    // Le domande sono TUTTE della sede dell'utente: qui si prova l'ALGORITMO
    // della delibera (soglia, posti, override), non l'isolamento fra sedi —
    // quello sta in `modulistica-mutazioni-scope-sede.test.ts`, dove il finto
    // client applica davvero `.in('scuola_id', plessi)`.
    from: () => {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = () => b
      b.in = () => b
      b.order = () => b
      b.maybeSingle = async () => ({ data: { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3', scuola_id: 'sc-1' }, error: null })
      b.then = (res: (v: unknown) => void) => res({ data: h.subs, error: null })
      b.update = (row: Record<string, unknown>) => ({
        // L'override ripete il filtro di sede anche sull'UPDATE
        // (`.eq('id', …).in('scuola_id', plessi)`), il bulk no: la catena deve
        // essere attendibile con e senza `.in()`.
        eq: (_col: string, val: unknown) => {
          h.updates.push({ id: val, row })
          const esito = { error: null }
          return {
            in: async () => esito,
            then: (ok: (v: unknown) => unknown) => Promise.resolve(esito).then(ok),
          }
        },
      })
      return b
    },
  }),
}))

import { POST } from '@/app/api/forms/delibera/route'

// `NextRequest` e non `Request`: la route legge le sedi attive dal cookie del
// SedeSelector, e quel canale esiste solo sulla richiesta di Next.
function post(body: unknown) {
  return new NextRequest('http://localhost/api/forms/delibera', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
}

describe('POST /api/forms/delibera', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.subs = []
    h.updates = []
    h.requireStaff.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: 'sc-1' } })
  })

  it('gated allo staff', async () => {
    h.requireStaff.mockResolvedValue({ response: NextResponse.json({}, { status: 403 }) })
    expect((await POST(post({ modelId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2', posti: 1, soglia: 0 }))).status).toBe(403)
  })

  it('400 senza modelId né submissionId', async () => {
    expect((await POST(post({}))).status).toBe(400)
  })

  it('delibera bulk: assegna ammesso/lista/non-ammesso secondo soglia+posti', async () => {
    h.subs = [{ id: 'a', score: 10 }, { id: 'b', score: 8 }, { id: 'c', score: 3 }]
    const res = await POST(post({ modelId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2', posti: 1, soglia: 5 }))
    expect(res.status).toBe(200)
    const esitoById = Object.fromEntries(h.updates.map((u) => [u.id, u.row.esito_ammissione]))
    expect(esitoById).toEqual({ a: 'ammesso', b: 'lista_attesa', c: 'non_ammesso' })
    const json = await res.json()
    expect(json.data.totale).toBe(3)
    expect(json.data.conteggi.ammesso).toBe(1)
  })

  it('override singolo: aggiorna l’esito del candidato + tracciamento', async () => {
    const res = await POST(post({ submissionId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3', esito: 'ammesso' }))
    expect(res.status).toBe(200)
    expect(h.updates).toHaveLength(1)
    expect(h.updates[0].id).toBe('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3')
    expect(h.updates[0].row.esito_ammissione).toBe('ammesso')
    expect(h.updates[0].row.esito_da).toBe('seg-1')
  })

  it('override con esito non valido → 400', async () => {
    expect((await POST(post({ submissionId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3', esito: 'boh' }))).status).toBe(400)
  })
})
