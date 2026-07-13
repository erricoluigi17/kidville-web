import { describe, it, expect } from 'vitest'

// POST /api/auth/logout — azzera i cookie server-side dell'identità applicativa
// (kv-active-role, sedi_attive). Nessun gate: uscita sempre sicura.

import { POST } from '@/app/api/auth/logout/route'

describe('POST /api/auth/logout', () => {
  it('200 e azzera kv-active-role e sedi_attive (Max-Age=0)', async () => {
    // La Request ora è obbligatoria: `withRoute` la vuole per aprire il contesto della
    // richiesta (requestId + path). L'handler non la usa — il logout non ha input.
    const res = await POST(new Request('http://localhost/api/auth/logout', { method: 'POST' }))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j).toMatchObject({ ok: true })

    const cookie = (res.headers.get('set-cookie') ?? '').toLowerCase()
    expect(cookie).toContain('kv-active-role=')
    expect(cookie).toContain('sedi_attive=')
    // Scadenza immediata: Max-Age=0 su entrambi.
    expect(cookie).toContain('max-age=0')
    expect(cookie).toContain('path=/')
  })
})
