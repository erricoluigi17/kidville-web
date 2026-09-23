import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

/**
 * `POST /api/pagamenti/fattura/coda/sospensione` — «Sospendi coda / Riprendi», SOLO admin
 * (nucleo §3). Uuid finti: il repository è pubblico.
 */

const h = vi.hoisted(() => ({ requireStaff: vi.fn(), rpc: vi.fn() }))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/supabase/server-client', () => ({ createAdminClient: async () => ({ rpc: h.rpc }) }))

import { POST } from '@/app/api/pagamenti/fattura/coda/sospensione/route'
import { CODICI_ERRORE_CODA } from '@/lib/fatture-coda/api'

const ADMIN = '00000000-0000-4000-8000-000000007001'

function post(corpo: unknown): Request {
  return new Request('http://localhost/api/pagamenti/fattura/coda/sospensione', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(corpo),
  })
}

const chiamateA = (nome: string) => h.rpc.mock.calls.filter((c) => c[0] === nome)

beforeEach(() => {
  vi.clearAllMocks()
  h.requireStaff.mockResolvedValue({ user: { id: ADMIN, role: 'admin' } })
  h.rpc.mockResolvedValue({ data: null, error: null })
})

describe('solo admin', () => {
  it('il gate è chiesto con i soli admin ammessi', async () => {
    await POST(post({ sospesa: true }))
    expect(h.requireStaff).toHaveBeenCalledWith(expect.any(Request), ['admin'])
  })

  it('403 del gate (segreteria) e 401: nessuna RPC', async () => {
    h.requireStaff.mockResolvedValueOnce({ response: NextResponse.json({ error: 'no' }, { status: 403 }) })
    expect((await POST(post({ sospesa: true }))).status).toBe(403)
    h.requireStaff.mockResolvedValueOnce({ response: NextResponse.json({ error: 'no' }, { status: 401 }) })
    expect((await POST(post({ sospesa: true }))).status).toBe(401)
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('zod: sospesa assente o non booleana ⇒ 400', async () => {
    expect((await POST(post({}))).status).toBe(400)
    expect((await POST(post({ sospesa: 'sì' }))).status).toBe(400)
    expect(h.rpc).not.toHaveBeenCalled()
  })
})

describe('sospendi e riprendi', () => {
  it('sospendi: RPC con l’attore, nessuna sveglia', async () => {
    const res = await POST(post({ sospesa: true }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ sospesa: true })
    expect(chiamateA('fatture_coda_sospendi')).toEqual([['fatture_coda_sospendi', { p_attore: ADMIN, p_sospesa: true }]])
    expect(chiamateA('fatture_coda_tick_http')).toEqual([])
  })

  it('riprendi: RPC, poi la sveglia', async () => {
    const res = await POST(post({ sospesa: false }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ sospesa: false })
    expect(chiamateA('fatture_coda_sospendi')).toEqual([['fatture_coda_sospendi', { p_attore: ADMIN, p_sospesa: false }]])
    await vi.waitFor(() => expect(chiamateA('fatture_coda_tick_http')).toHaveLength(1))
  })
})

describe('DB non migrato e guasti', () => {
  it.each(['PGRST205', '42P01', 'PGRST202', '42883'])('%s ⇒ 503 CODA_FATTURE_NON_DISPONIBILE', async (code) => {
    h.rpc.mockResolvedValueOnce({ data: null, error: { code } })
    const res = await POST(post({ sospesa: false }))
    expect(res.status).toBe(503)
    expect((await res.json()).codice).toBe(CODICI_ERRORE_CODA.NON_DISPONIBILE)
    expect(chiamateA('fatture_coda_tick_http')).toEqual([])
  })

  it('altro errore ⇒ 500 con codice, niente sveglia', async () => {
    h.rpc.mockResolvedValueOnce({ data: null, error: { code: 'XX000' } })
    const res = await POST(post({ sospesa: false }))
    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe(CODICI_ERRORE_CODA.SCRITTURA_FALLITA)
    expect(chiamateA('fatture_coda_tick_http')).toEqual([])
  })
})
