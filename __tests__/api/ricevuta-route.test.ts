import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  pagamento: null as Record<string, unknown> | null,
  legame: null as Record<string, unknown> | null,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireUser: h.requireUser }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = () => b
      b.single = async () => ({ data: table === 'pagamenti' ? h.pagamento : null, error: null })
      b.maybeSingle = async () => ({
        data: table === 'pagamenti' ? h.pagamento : table === 'legame_genitori_alunni' ? h.legame : null,
        error: null,
      })
      return b
    },
  }),
}))

import { GET } from '@/app/api/pagamenti/ricevuta/route'

const PAG_SALDATO = {
  id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2', descrizione: 'Retta Marzo', importo: 150, importo_pagato: 150, stato: 'pagato',
  scadenza: '2026-03-31', alunno_id: 'al-1', alunni: { nome: 'Mario', cognome: 'Rossi' },
}
function req(pid?: string) {
  const url = pid ? `http://localhost/api/pagamenti/ricevuta?pagamento_id=${pid}` : 'http://localhost/api/pagamenti/ricevuta'
  return new Request(url)
}

describe('GET /api/pagamenti/ricevuta', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.pagamento = PAG_SALDATO
    h.legame = { alunno_id: 'al-1' }
    h.requireUser.mockResolvedValue({ user: { id: 'staff-1', role: 'segreteria' } })
  })

  it('401 se non autenticato', async () => {
    h.requireUser.mockResolvedValue({ response: NextResponse.json({}, { status: 401 }) })
    expect((await GET(req('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2'))).status).toBe(401)
  })

  it('400 senza pagamento_id', async () => {
    expect((await GET(req())).status).toBe(400)
  })

  it('409 se il pagamento non è saldato', async () => {
    h.pagamento = { ...PAG_SALDATO, stato: 'da_pagare' }
    expect((await GET(req('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2'))).status).toBe(409)
  })

  it('staff: 200 PDF per pagamento saldato', async () => {
    const res = await GET(req('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2'))
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/pdf')
  })

  it('genitore senza legame col bambino: 403', async () => {
    h.requireUser.mockResolvedValue({ user: { id: 'gen-1', role: 'genitore' } })
    h.legame = null
    expect((await GET(req('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2'))).status).toBe(403)
  })

  it('genitore collegato: 200 PDF', async () => {
    h.requireUser.mockResolvedValue({ user: { id: 'gen-1', role: 'genitore' } })
    h.legame = { alunno_id: 'al-1' }
    const res = await GET(req('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2'))
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/pdf')
  })
})
