import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  pagamenti: [] as Record<string, unknown>[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/auth/scope', () => ({ resolveScuoleAttive: vi.fn(async () => ['sc-1']) }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: () => {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.order = () => b
      b.eq = () => b
      b.in = () => b
      b.then = (resolve: (v: unknown) => unknown) => resolve({ data: h.pagamenti, error: null })
      return b
    },
  }),
}))

import { GET } from '@/app/api/pagamenti/export/route'

const url = (qs: string) => new Request(`http://localhost/api/pagamenti/export?${qs}`) as unknown as import('next/server').NextRequest

describe('GET /api/pagamenti/export', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.requireStaff.mockResolvedValue({ user: { id: 'staff-1', role: 'segreteria' } })
    h.pagamenti = [{
      id: 'p1', descrizione: 'Retta Settembre', importo: 150, importo_pagato: 150, stato: 'pagato',
      tipo: 'singolo', scadenza: '2026-09-05', periodo_competenza: '2026-09-01', fattura_stato: 'non_richiesta',
      alunni: { nome: 'Mario', cognome: 'Rossi', classe_sezione: 'Girasoli' },
      payment_categories: { nome: 'Retta' },
    }]
  })

  it('403 per i non-staff', async () => {
    h.requireStaff.mockResolvedValue({ response: NextResponse.json({}, { status: 403 }) })
    expect((await GET(url('tipo=scadenzario'))).status).toBe(403)
  })

  it('400 con tipo non previsto', async () => {
    expect((await GET(url('tipo=boh'))).status).toBe(400)
  })

  it('200 con XLSX in attachment', async () => {
    const res = await GET(url('tipo=scadenzario'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('spreadsheetml')
    expect(res.headers.get('content-disposition')).toContain('scadenzario')
    const buf = await res.arrayBuffer()
    expect(buf.byteLength).toBeGreaterThan(0)
  })
})
