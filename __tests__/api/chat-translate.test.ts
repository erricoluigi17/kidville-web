import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

// P4/DL-042 — POST /api/chat/translate: gated (requireUser), rate-limited,
// delega a translateText; 503 se il servizio è disabilitato (manca la chiave).

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  translateText: vi.fn(),
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireUser: h.requireUser }))
vi.mock('@/lib/translate/claude', () => ({ translateText: h.translateText }))

import { POST } from '@/app/api/chat/translate/route'

const req = (body: unknown) =>
  new Request('http://localhost/api/chat/translate', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })

beforeEach(() => {
  vi.clearAllMocks()
  h.requireUser.mockResolvedValue({ user: { id: 'u1', role: 'genitore' } })
  h.translateText.mockResolvedValue({ translated: 'hello' })
})

describe('POST /api/chat/translate', () => {
  it('401 senza identità', async () => {
    h.requireUser.mockResolvedValue({ response: NextResponse.json({}, { status: 401 }) })
    expect((await POST(req({ text: 'ciao', targetLang: 'en' }))).status).toBe(401)
  })

  it('400 senza text/targetLang', async () => {
    expect((await POST(req({ text: 'ciao' }))).status).toBe(400)
  })

  it('200 con traduzione', async () => {
    const res = await POST(req({ text: 'ciao', targetLang: 'en' }))
    expect(res.status).toBe(200)
    expect((await res.json()).translated).toBe('hello')
  })

  it('503 se il servizio è disabilitato (manca la chiave)', async () => {
    h.translateText.mockResolvedValue({ translated: null, disabled: true })
    const res = await POST(req({ text: 'ciao', targetLang: 'en' }))
    expect(res.status).toBe(503)
  })
})
