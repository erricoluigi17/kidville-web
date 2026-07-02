// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  model: null as Record<string, unknown> | null,
  uploads: [] as Array<{ bucket: string; path: string }>,
}))

vi.mock('@/lib/security/rate-limit', () => ({
  rateLimit: vi.fn().mockReturnValue({ ok: true, remaining: 9, retryAfterMs: 0 }),
  clientIp: vi.fn().mockReturnValue('ip'),
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: () => {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = () => b
      b.maybeSingle = async () => ({ data: h.model, error: null })
      return b
    },
    storage: {
      from: (bucket: string) => ({
        upload: async (path: string) => { h.uploads.push({ bucket, path }); return { error: null } },
      }),
    },
  }),
}))

import { POST } from '@/app/api/public/forms/[token]/upload/route'

const ctx = (token: string) => ({ params: Promise.resolve({ token }) })
const pdf = (name = 'doc.pdf', type = 'application/pdf', bytes = 10) =>
  new File([Buffer.from('x'.repeat(bytes))], name, { type })
function uploadReq(file?: File) {
  const fd = new FormData()
  if (file) fd.append('file', file)
  return new Request('http://localhost/api/public/forms/tok/upload', { method: 'POST', body: fd })
}

beforeEach(() => {
  vi.clearAllMocks()
  h.model = { id: 'm-1', published_at: '2026-06-26T00:00:00Z', access_mode: 'public' }
  h.uploads = []
})

describe('POST /api/public/forms/[token]/upload', () => {
  it('404 se non pubblicato', async () => {
    h.model = null
    expect((await POST(uploadReq(pdf()), ctx('nope'))).status).toBe(404)
  })

  it('400 senza file', async () => {
    expect((await POST(uploadReq(), ctx('tok'))).status).toBe(400)
  })

  it('400 tipo non ammesso', async () => {
    const exe = new File([Buffer.from('MZ')], 'v.exe', { type: 'application/octet-stream' })
    expect((await POST(uploadReq(exe), ctx('tok'))).status).toBe(400)
  })

  it('200 carica sotto public/{token} e ritorna path', async () => {
    const res = await POST(uploadReq(pdf()), ctx('tok'))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.path).toMatch(/^public\/tok\//)
    expect(h.uploads[0].bucket).toBe('form_attachments')
  })
})
