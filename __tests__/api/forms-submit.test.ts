// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

const h = vi.hoisted(() => ({
  model: null as Record<string, unknown> | null,
  inserts: [] as Record<string, unknown>[],
  insertError: null as unknown,
  sospensione: null as unknown, // NextResponse se sospeso, null altrimenti
}))

vi.mock('@/lib/security/rate-limit', () => ({
  rateLimit: vi.fn().mockReturnValue({ ok: true, remaining: 9, retryAfterMs: 0 }),
  clientIp: vi.fn().mockReturnValue('test-ip'),
}))
vi.mock('@/lib/pagamenti/sospensione', () => ({
  assertGenitoreNonSospeso: vi.fn(async () => h.sospensione),
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = () => b
      b.maybeSingle = async () => ({ data: table === 'form_models' ? h.model : null, error: null })
      b.single = async () => ({ data: { id: 'sub-new' }, error: h.insertError })
      b.insert = (row: Record<string, unknown>) => { h.inserts.push(row); return b }
      return b
    },
  }),
}))

import { POST } from '@/app/api/forms/submit/route'

function req(body: unknown) {
  return new Request('http://localhost/api/forms/submit', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
}

const modelloConConsenso = {
  schema: {
    version: '1.0',
    pages: [{
      id: 'p1', title: 'P',
      fields: [
        { id: 'nome', type: 'text', label: 'Nome' },
        { id: 'privacy', type: 'consent', label: 'Trattamento dati', text: 'Acconsento', required: true },
      ],
    }],
  },
}

beforeEach(() => {
  vi.clearAllMocks()
  h.model = modelloConConsenso
  h.inserts = []
  h.insertError = null
  h.sospensione = null
})

describe('POST /api/forms/submit (path senza firma)', () => {
  it('400 se mancano modelId o data', async () => {
    expect((await POST(req({ userId: 'u-1' }))).status).toBe(400)
  })

  it('400 se un consenso obbligatorio non è spuntato', async () => {
    const res = await POST(req({ modelId: 'm-1', userId: 'u-1', data: { nome: 'Marco', privacy: false } }))
    expect(res.status).toBe(400)
    expect(h.inserts).toHaveLength(0)
  })

  it('403 se il genitore è sospeso (moroso)', async () => {
    h.sospensione = NextResponse.json({ error: 'sospeso' }, { status: 403 })
    const res = await POST(req({ modelId: 'm-1', userId: 'u-1', data: { nome: 'Marco', privacy: true } }))
    expect(res.status).toBe(403)
  })

  it('201 inserisce completed con consents_log snapshot', async () => {
    const res = await POST(req({ modelId: 'm-1', userId: 'u-1', data: { nome: 'Marco', privacy: true } }))
    expect(res.status).toBe(201)
    const json = await res.json()
    expect(json.id).toBe('sub-new')
    const row = h.inserts[0]
    expect(row.status).toBe('completed')
    expect(row.model_id).toBe('m-1')
    const log = row.consents_log as Array<Record<string, unknown>>
    expect(log[0]).toMatchObject({ field_id: 'privacy', label: 'Trattamento dati', accepted: true })
    expect(typeof log[0].accepted_at).toBe('string')
  })
})
