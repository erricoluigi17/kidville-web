import { describe, it, expect, vi, beforeEach } from 'vitest'

// Estende send-otp (DL-029): snapshot consensi + guard consensi obbligatori.

const h = vi.hoisted(() => ({
  model: null as Record<string, unknown> | null,
  inserts: [] as Record<string, unknown>[],
}))

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = () => b
      b.maybeSingle = async () => ({ data: table === 'form_models' ? h.model : { email: 'g@x.it' }, error: null })
      b.insert = (row: Record<string, unknown>) => { h.inserts.push(row); return b }
      b.single = async () => ({ data: { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa12' }, error: null })
      b.update = () => ({ eq: async () => ({ error: null }) })
      return b
    },
  }),
}))
vi.mock('@/lib/email/send', () => ({ sendEmail: vi.fn().mockResolvedValue(true) }))
vi.mock('@/lib/security/rate-limit', () => ({
  rateLimit: vi.fn().mockReturnValue({ ok: true, remaining: 7, retryAfterMs: 0 }),
  clientIp: vi.fn().mockReturnValue('ip'),
}))
vi.mock('@/lib/pagamenti/sospensione', () => ({
  assertGenitoreNonSospeso: vi.fn(async () => null),
}))

import { POST } from '@/app/api/forms/send-otp/route'

const req = (body: unknown) =>
  new Request('http://localhost/api/forms/send-otp', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })

const modelloConsenso = {
  schema: { version: '1.0', pages: [{ id: 'p', title: 'P', fields: [
    { id: 'privacy', type: 'consent', label: 'Privacy', required: true },
  ] }] },
}

beforeEach(() => {
  vi.clearAllMocks()
  h.model = modelloConsenso
  h.inserts = []
})

describe('POST send-otp — consensi (DL-029)', () => {
  it('400 se un consenso obbligatorio non è spuntato', async () => {
    const res = await POST(req({ modelId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa10', userId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa11', data: { privacy: false } }))
    expect(res.status).toBe(400)
    expect(h.inserts).toHaveLength(0)
  })

  it('200 e la submission salva consents_log snapshot', async () => {
    const res = await POST(req({ modelId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa10', userId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa11', data: { privacy: true } }))
    expect(res.status).toBe(200)
    const log = h.inserts[0]?.consents_log as Array<Record<string, unknown>>
    expect(log[0]).toMatchObject({ field_id: 'privacy', accepted: true })
  })
})
