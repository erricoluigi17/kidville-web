import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

// G2 — la ricevuta FEA usava getRequestUserId (header `x-user-id`/`?userId=`
// spoofabili) e, su firmatario null, SALTAVA il 403. Ora: identità da requireUser
// (sessione-first) e guardia scope in NEGA DI DEFAULT (signerId null O ≠ utente → 403).
const h = vi.hoisted(() => {
  const state = { rows: {} as Record<string, { data: unknown; error: unknown }> }
  function makeClient() {
    return {
      from(table: string) {
        const qb: Record<string, unknown> = {}
        for (const m of ['select', 'eq']) qb[m] = () => qb
        qb.maybeSingle = () => Promise.resolve(state.rows[table] ?? { data: null, error: null })
        qb.single = () => Promise.resolve(state.rows[table] ?? { data: null, error: null })
        return qb
      },
    }
  }
  return { state, makeClient, requireUser: vi.fn() }
})

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: vi.fn().mockResolvedValue(h.makeClient()),
}))
vi.mock('@/lib/auth/require-staff', () => ({ requireUser: h.requireUser }))

import { GET } from '@/app/api/fea/receipt/route'
import { NextRequest } from 'next/server'

function req(qs: string): NextRequest {
  return new NextRequest(`http://localhost/api/fea/receipt?${qs}`)
}

const firma = {
  method: 'OTP_EMAIL',
  provider: 'Firma OTP via email (FES)',
  email: 'maria@example.it',
  ip: '203.0.113.7',
  user_agent: 'Moz/5',
  signed_at: '2026-06-25T10:00:00.000Z',
  timestamp: '2026-06-25T10:00:00.000Z',
  hash: 'SHA256-ABC',
  compliance: 'CAD Art. 20 / DPR 445/2000',
}

beforeEach(() => {
  vi.clearAllMocks()
  h.state.rows = {}
  h.requireUser.mockResolvedValue({ user: { id: 'u-1', role: 'genitore' } })
})

describe('GET /api/fea/receipt', () => {
  it('401 senza sessione (niente identità spoofabile via header)', async () => {
    h.requireUser.mockResolvedValue({ response: NextResponse.json({ error: 'x' }, { status: 401 }) })
    const res = await GET(req('entita=pagella&id=e-1'))
    expect(res.status).toBe(401)
  })

  it('400 con entita non valida', async () => {
    const res = await GET(req('entita=sconosciuta&id=e-1'))
    expect(res.status).toBe(400)
  })

  it('400 senza id', async () => {
    const res = await GET(req('entita=pagella'))
    expect(res.status).toBe(400)
  })

  it('404 se la riga non esiste', async () => {
    h.state.rows = { pagella_ricezioni: { data: null, error: null } }
    const res = await GET(req('entita=pagella&id=missing'))
    expect(res.status).toBe(404)
  })

  it('403 se il chiamante non è il firmatario', async () => {
    h.state.rows = {
      pagella_ricezioni: { data: { id: 'e-1', scrutinio_id: 's', alunno_id: 'a', genitore_id: 'altro', firma }, error: null },
    }
    const res = await GET(req('entita=pagella&id=e-1'))
    expect(res.status).toBe(403)
  })

  it('403 se il firmatario è null (nega di default)', async () => {
    h.state.rows = {
      pagella_ricezioni: { data: { id: 'e-1', scrutinio_id: 's', alunno_id: 'a', genitore_id: null, firma }, error: null },
    }
    const res = await GET(req('entita=pagella&id=e-1'))
    expect(res.status).toBe(403)
  })

  it('200 application/pdf per il firmatario', async () => {
    h.state.rows = {
      pagella_ricezioni: { data: { id: 'e-1', scrutinio_id: 's', alunno_id: 'a', genitore_id: 'u-1', firma }, error: null },
    }
    const res = await GET(req('entita=pagella&id=e-1'))
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/pdf')
    const buf = Buffer.from(await res.arrayBuffer())
    expect(buf.subarray(0, 4).toString('latin1')).toBe('%PDF')
  })
})
