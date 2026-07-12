import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

// Route registro protocolli: gate admin+segreteria, DELETE solo admin senza
// audit (decisioni #2/#6), degradazione su DB non migrato (E2E CI), zod.

const h = vi.hoisted(() => ({
  identity: { userId: 'u-1' as string | null },
  appUser: { id: 'u-1', role: 'segreteria', scuola_id: 's-1' } as {
    id: string
    role: string
    scuola_id?: string
  } | null,
  tabelle: {} as Record<string, { data: unknown; error: { code?: string; message: string } | null }>,
  rpc: { data: null as unknown, error: null as { message: string; code?: string } | null },
  rimossi: [] as string[][],
  logScrittura: vi.fn(async () => undefined),
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireStaff: vi.fn(
    async (_req: Request, allowed: string[] = ['admin', 'coordinator', 'segreteria']) => {
      if (!h.identity.userId) {
        return { response: NextResponse.json({ error: 'Non autenticato' }, { status: 401 }) }
      }
      if (!h.appUser || !allowed.includes(h.appUser.role)) {
        return { response: NextResponse.json({ error: 'Accesso negato' }, { status: 403 }) }
      }
      return { user: h.appUser }
    }
  ),
}))

vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@/lib/security/rate-limit', () => ({
  rateLimit: () => ({ ok: true, retryAfterMs: 0 }),
  clientIp: () => '127.0.0.1',
}))

function chain(tabella: string) {
  const esito = () => h.tabelle[tabella] ?? { data: null, error: null }
  // Builder PostgREST-like: ogni metodo ritorna se stesso, l'await risolve l'esito.
  const b: Record<string, unknown> = {}
  for (const m of ['select', 'insert', 'update', 'eq', 'neq', 'is', 'in', 'gte', 'lte', 'or', 'order', 'range', 'limit']) {
    b[m] = () => b
  }
  b.maybeSingle = async () => esito()
  b.single = async () => esito()
  b.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) =>
    Promise.resolve(esito()).then(ok, ko)
  return b
}

const storageStub = {
  remove: async (p: string[]) => {
    h.rimossi.push(p)
    return { data: null, error: null }
  },
  createSignedUrl: async () => ({ data: { signedUrl: 'https://firmato.test' }, error: null }),
  createSignedUploadUrl: async () => ({
    data: { signedUrl: 'https://upload.test', token: 'tok', path: 'staging/x' },
    error: null,
  }),
  download: async () => ({ data: null, error: { message: 'assente' } }),
  upload: async () => ({ data: null, error: null }),
}

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: vi.fn(async () => ({
    from: (t: string) => chain(t),
    rpc: async () => h.rpc,
    storage: { from: () => storageStub, listBuckets: async () => ({ data: [{ name: 'protocollo' }], error: null }), createBucket: async () => ({ data: null, error: null }) },
  })),
}))

import { GET, POST, PATCH, DELETE } from '@/app/api/admin/protocolli/route'
import { POST as POST_UPLOAD_URL } from '@/app/api/admin/protocolli/upload-url/route'

const URL_BASE = 'http://localhost/api/admin/protocolli'
const reqJson = (method: string, body: unknown, url = URL_BASE) =>
  new Request(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

beforeEach(() => {
  h.identity = { userId: 'u-1' }
  h.appUser = { id: 'u-1', role: 'segreteria', scuola_id: 's-1' }
  h.tabelle = {}
  h.rpc = { data: null, error: null }
  h.rimossi = []
  h.logScrittura.mockClear()
})

describe('GET /api/admin/protocolli', () => {
  it('401 senza identità', async () => {
    h.identity = { userId: null }
    expect((await GET(new Request(URL_BASE) as never)).status).toBe(401)
  })
  it('403 per un docente (educator)', async () => {
    h.appUser = { id: 'u-1', role: 'educator', scuola_id: 's-1' }
    expect((await GET(new Request(URL_BASE) as never)).status).toBe(403)
  })
  it('degrada su DB non migrato: 200 con lista vuota e nonMigrato', async () => {
    h.tabelle.protocolli = { data: null, error: { code: '42P01', message: 'missing table' } }
    const res = await GET(new Request(URL_BASE) as never)
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.success).toBe(true)
    expect(j.data).toEqual([])
    expect(j.nonMigrato).toBe(true)
  })
  it('200 con lista vuota su registro vuoto', async () => {
    h.tabelle.protocolli = { data: [], error: null }
    const res = await GET(new Request(URL_BASE) as never)
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual([])
  })
})

describe('POST /api/admin/protocolli (registrazione)', () => {
  it('400 zod senza oggetto', async () => {
    const res = await POST(
      reqJson('POST', {
        stagingPath: 'staging/abc-file.pdf',
        nomeFile: 'file.pdf',
        mime: 'application/pdf',
        tipo: 'ingresso',
        mittente: 'Comune',
      }) as never
    )
    expect(res.status).toBe(400)
  })
  it('400 zod: ingresso senza mittente', async () => {
    const res = await POST(
      reqJson('POST', {
        stagingPath: 'staging/abc-file.pdf',
        nomeFile: 'file.pdf',
        mime: 'application/pdf',
        tipo: 'ingresso',
        oggetto: 'Richiesta documenti',
      }) as never
    )
    expect(res.status).toBe(400)
  })
})

describe('PATCH /api/admin/protocolli', () => {
  it('400 zod: annullamento senza motivo (art. 54)', async () => {
    const res = await PATCH(
      reqJson('PATCH', { id: '11111111-2222-3333-4444-555555555555', azione: 'annulla' }) as never
    )
    expect(res.status).toBe(400)
  })
})

describe('DELETE /api/admin/protocolli (solo admin, senza audit)', () => {
  const urlDelete = `${URL_BASE}?id=11111111-2222-3333-4444-555555555555`
  it('403 per la segreteria', async () => {
    const res = await DELETE(new Request(urlDelete, { method: 'DELETE' }) as never)
    expect(res.status).toBe(403)
  })
  it('admin: elimina via rpc, rimuove i file, NESSUN logScrittura', async () => {
    h.appUser = { id: 'u-1', role: 'admin', scuola_id: 's-1' }
    h.tabelle.utenti_scuole = { data: [], error: null }
    h.tabelle.protocolli = {
      data: { id: '11111111-2222-3333-4444-555555555555', scuola_id: 's-1' },
      error: null,
    }
    h.rpc = { data: ['s-1/2026/0000001-originale.pdf', 's-1/2026/0000001-timbrato.pdf'], error: null }
    const res = await DELETE(new Request(urlDelete, { method: 'DELETE' }) as never)
    expect(res.status).toBe(200)
    expect(h.rimossi.flat()).toContain('s-1/2026/0000001-timbrato.pdf')
    expect(h.logScrittura).not.toHaveBeenCalled()
  })
  it('404 se la registrazione non esiste o è fuori sede', async () => {
    h.appUser = { id: 'u-1', role: 'admin', scuola_id: 's-1' }
    h.tabelle.utenti_scuole = { data: [], error: null }
    h.tabelle.protocolli = { data: null, error: null }
    const res = await DELETE(new Request(urlDelete, { method: 'DELETE' }) as never)
    expect(res.status).toBe(404)
  })
})

describe('POST /api/admin/protocolli/upload-url', () => {
  it('400 su MIME non ammesso', async () => {
    const res = await POST_UPLOAD_URL(
      reqJson('POST', { nome: 'virus.exe', mime: 'application/x-msdownload', size: 100 }) as never
    )
    expect(res.status).toBe(400)
  })
  it('200 con path/token per un PDF', async () => {
    const res = await POST_UPLOAD_URL(
      reqJson('POST', { nome: 'lettera.pdf', mime: 'application/pdf', size: 1024 }) as never
    )
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.success).toBe(true)
    expect(j.data.signedUrl).toBeTruthy()
    expect(j.data.path).toBeTruthy()
  })
})
