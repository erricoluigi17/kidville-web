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

// I TOKEN SONO UUID — `form_models.public_token` è di tipo `uuid`. Qui c'erano `'tok'` e
// `'nope'`: un doppio che risponde `{ data: null }` a qualunque valore li accettava, mentre
// in produzione una stringa non-uuid fa rispondere a Postgres `22P02`. Il ramo malformato
// sta in `public-forms-token-malformato.test.ts`, con un doppio che mente come mente Postgres.
const TOKEN = 'c0000000-0000-4000-8000-00000000c0de'
const TOKEN_SCONOSCIUTO = 'd0000000-0000-4000-8000-00000000dead'
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
    expect((await POST(uploadReq(pdf()), ctx(TOKEN_SCONOSCIUTO))).status).toBe(404)
  })

  it('400 senza file', async () => {
    expect((await POST(uploadReq(), ctx(TOKEN))).status).toBe(400)
  })

  it('415 tipo non ammesso', async () => {
    // 415 e non più 400 (2026-08-02): il gate sui tipi è ora quello condiviso con
    // `iscrizione/upload` — stesso bucket, stessa regola, un modulo solo
    // (`@/lib/upload/allegati-pubblici`) — e usa il codice che dice «questo FILE non va
    // bene», non «questa RICHIESTA è malformata». È lo stesso status che avvisi e incarichi
    // restituiscono dal 2026-07-31.
    const exe = new File([Buffer.from('MZ')], 'v.exe', { type: 'application/octet-stream' })
    const res = await POST(uploadReq(exe), ctx(TOKEN))
    expect(res.status).toBe(415)
    expect(((await res.json()) as { codice?: string }).codice).toBe('ALLEGATO_PDF_O_IMMAGINE')
    expect(h.uploads, 'Il file rifiutato non deve toccare lo Storage.').toHaveLength(0)
  })

  it('200 carica sotto public/{token} e ritorna path', async () => {
    const res = await POST(uploadReq(pdf()), ctx(TOKEN))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.path).toMatch(new RegExp(`^public/${TOKEN}/`))
    expect(h.uploads[0].bucket).toBe('form_attachments')
  })
})
