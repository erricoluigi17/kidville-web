import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

// P4/DL-045 — POST /api/parent/onboarding: consensi GDPR obbligatori + (opzionale)
// set password Supabase Auth; marca onboarded_at sul genitore.

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  parent: { id: 'p1', auth_user_id: 'auth-1' } as Record<string, unknown> | null,
  updates: [] as Array<Record<string, unknown>>,
  pwUpdates: [] as Array<{ uid: string; attrs: unknown }>,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireUser: h.requireUser }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    auth: { admin: { updateUserById: async (uid: string, attrs: unknown) => { h.pwUpdates.push({ uid, attrs }); return { data: {}, error: null } } } },
    from: () => {
      const b: Record<string, unknown> = {}
      b.update = (row: Record<string, unknown>) => { h.updates.push(row); return b }
      b.eq = () => b
      b.select = () => b
      b.maybeSingle = async () => ({ data: h.parent, error: null })
      return b
    },
  }),
}))

import { POST } from '@/app/api/parent/onboarding/route'

const req = (body: unknown) =>
  new Request('http://localhost/api/parent/onboarding', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

beforeEach(() => {
  vi.clearAllMocks()
  h.requireUser.mockResolvedValue({ user: { id: 'p1', role: 'genitore' } })
  h.parent = { id: 'p1', auth_user_id: 'auth-1' }
  h.updates = []; h.pwUpdates = []
})

describe('POST /api/parent/onboarding', () => {
  it('401 senza identità', async () => {
    h.requireUser.mockResolvedValue({ response: NextResponse.json({}, { status: 401 }) })
    expect((await POST(req({ consensi: { privacy: true } }))).status).toBe(401)
  })

  it('422 se manca il consenso privacy', async () => {
    const res = await POST(req({ consensi: { privacy: false } }))
    expect(res.status).toBe(422)
    expect((await res.json()).mancanti).toContain('privacy')
  })

  it('400 se la password è troppo corta', async () => {
    expect((await POST(req({ consensi: { privacy: true }, password: 'abc' }))).status).toBe(400)
  })

  it('200 con consensi: marca onboarded_at + salva consensi_gdpr', async () => {
    const res = await POST(req({ consensi: { privacy: true } }))
    expect(res.status).toBe(200)
    expect(h.updates[0]).toHaveProperty('onboarded_at')
    expect(h.updates[0]).toMatchObject({ consensi_gdpr: { privacy: true } })
    expect(h.pwUpdates).toHaveLength(0)
  })

  it('aggiorna la password Supabase Auth se fornita e il genitore è bindato', async () => {
    const res = await POST(req({ consensi: { privacy: true }, password: 'unaPasswordLunga' }))
    expect(res.status).toBe(200)
    expect(h.pwUpdates[0]).toMatchObject({ uid: 'auth-1' })
  })
})
