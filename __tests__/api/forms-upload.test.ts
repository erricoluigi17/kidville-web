// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  uploadCalls: [] as Array<{ bucket: string; path: string }>,
  uploadError: null as unknown,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireUser: h.requireUser }))
vi.mock('@/lib/security/rate-limit', () => ({
  rateLimit: vi.fn().mockReturnValue({ ok: true, remaining: 9, retryAfterMs: 0 }),
  clientIp: vi.fn().mockReturnValue('test-ip'),
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    storage: {
      from: (bucket: string) => ({
        upload: async (path: string) => {
          h.uploadCalls.push({ bucket, path })
          return { error: h.uploadError }
        },
      }),
    },
  }),
}))

import { POST } from '@/app/api/forms/upload/route'

function uploadReq(opts: { file?: File; folder?: string } = {}) {
  const fd = new FormData()
  if (opts.file !== undefined) fd.append('file', opts.file)
  if (opts.folder) fd.append('folder', opts.folder)
  return new Request('http://localhost/api/forms/upload', { method: 'POST', body: fd })
}

const pdf = (name = 'doc.pdf', type = 'application/pdf', bytes = 10) =>
  new File([Buffer.from('x'.repeat(bytes))], name, { type })

beforeEach(() => {
  vi.clearAllMocks()
  h.uploadCalls = []
  h.uploadError = null
  h.requireUser.mockResolvedValue({ user: { id: 'u-1', role: 'genitore' } })
})

describe('POST /api/forms/upload', () => {
  it('401 se non autenticato', async () => {
    h.requireUser.mockResolvedValue({ response: NextResponse.json({}, { status: 401 }) })
    expect((await POST(uploadReq({ file: pdf(), folder: 'm-1' }))).status).toBe(401)
  })

  it('400 senza file', async () => {
    expect((await POST(uploadReq({ folder: 'm-1' }))).status).toBe(400)
  })

  it('400 file troppo grande (>8MB)', async () => {
    const big = pdf('big.pdf', 'application/pdf', 9 * 1024 * 1024)
    expect((await POST(uploadReq({ file: big, folder: 'm-1' }))).status).toBe(400)
  })

  it('400 tipo non ammesso (.exe)', async () => {
    const exe = new File([Buffer.from('MZ')], 'virus.exe', { type: 'application/octet-stream' })
    expect((await POST(uploadReq({ file: exe, folder: 'm-1' }))).status).toBe(400)
  })

  it('200 carica nel bucket form_attachments sotto models/{folder} e ritorna path', async () => {
    const res = await POST(uploadReq({ file: pdf(), folder: 'm-1' }))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.path).toMatch(/^models\/m-1\//)
    expect(h.uploadCalls[0].bucket).toBe('form_attachments')
    expect(h.uploadCalls[0].path).toBe(json.path)
  })
})
