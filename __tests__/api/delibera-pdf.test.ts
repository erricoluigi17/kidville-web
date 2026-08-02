import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  model: { title: 'Iscrizione Nido 2026' } as Record<string, unknown> | null,
  subs: [] as Record<string, unknown>[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = () => b
      // `.in('scuola_id', plessi)`: il PDF di graduatoria è filtrato per sede.
      // Qui le domande sono tutte della sede dell'utente — l'isolamento si prova
      // in `modulistica-mutazioni-scope-sede.test.ts`, col finto client che filtra.
      b.in = () => b
      b.order = () => b
      b.single = async () => ({ data: h.model, error: null })
      b.maybeSingle = async () => ({ data: h.model, error: null })
      b.then = (res: (v: unknown) => void) => res({ data: table === 'form_submissions' ? h.subs : null, error: null })
      return b
    },
  }),
}))

import { GET } from '@/app/api/forms/export/delibera/route'

function req(modelId?: string) {
  const url = modelId
    ? `http://localhost/api/forms/export/delibera?modelId=${modelId}`
    : 'http://localhost/api/forms/export/delibera'
  // `NextRequest`: la route legge le sedi attive dal cookie del SedeSelector.
  return new NextRequest(url)
}

describe('GET /api/forms/export/delibera', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.model = { title: 'Iscrizione Nido 2026' }
    h.subs = [
      { id: 'a', score: 10, esito_ammissione: 'ammesso', data: { nome: 'Mario', cognome: 'Rossi' } },
      { id: 'b', score: 4, esito_ammissione: 'non_ammesso', data: { nome: 'Lia', cognome: 'Bianchi' } },
    ]
    h.requireStaff.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: 'sc-1' } })
  })

  it('gated allo staff', async () => {
    h.requireStaff.mockResolvedValue({ response: NextResponse.json({}, { status: 403 }) })
    expect((await GET(req('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2'))).status).toBe(403)
  })

  it('400 senza modelId', async () => {
    expect((await GET(req())).status).toBe(400)
  })

  it('200 PDF della delibera', async () => {
    const res = await GET(req('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2'))
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/pdf')
  })
})
