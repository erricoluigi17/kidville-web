import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  requireParentOfStudent: vi.fn(),
  logScrittura: vi.fn(),
  generaCertificato: vi.fn(),
  seedCertificato: vi.fn(),
  owns: true,
  certs: [] as unknown[],
}))

vi.mock('@/lib/auth/require-staff', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>
  return { ...actual, requireStaff: h.requireStaff }
})
vi.mock('@/lib/auth/require-parent', () => ({ requireParentOfStudent: h.requireParentOfStudent }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@/lib/competenze/certificato-store', () => ({
  generaCertificato: h.generaCertificato,
  seedCertificato: h.seedCertificato,
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    storage: { from: () => ({ createSignedUrl: async () => ({ data: { signedUrl: 'https://signed/url' }, error: null }) }) },
    from(table: string) {
      const q: Record<string, unknown> = {}
      q.select = () => q
      q.eq = () => q
      q.in = () => q
      q.order = () => q
      q.maybeSingle = async () => ({ data: h.owns ? { alunno_id: 'al1' } : null, error: null })
      q.then = (r: (v: { data: unknown; error: null }) => unknown) => {
        if (table === 'legame_genitori_alunni' || table === 'student_parents') return r({ data: h.owns ? [{ alunno_id: 'al1', student_id: 'al1' }] : [], error: null })
        if (table === 'certificati_competenze') return r({ data: h.certs, error: null })
        return r({ data: [], error: null })
      }
      return q
    },
  }),
}))

import { POST as GENERA } from '@/app/api/admin/competenze/genera/route'
import { GET as PARENT_GET } from '@/app/api/parent/competenze/route'

const denied = () => ({ response: NextResponse.json({ error: 'denied' }, { status: 403 }) }) as never
const unauth = () => ({ response: NextResponse.json({ error: 'no user' }, { status: 401 }) }) as never
const jreq = (body: unknown) =>
  new Request('http://localhost/api/admin/competenze/genera', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

beforeEach(() => {
  vi.clearAllMocks()
  h.owns = true
  h.certs = []
  h.requireStaff.mockResolvedValue({ user: { id: 'dir1', role: 'admin', scuola_id: 'sc1' } })
  h.requireParentOfStudent.mockResolvedValue({ user: { id: 'par1', role: 'genitore' } })
  h.generaCertificato.mockResolvedValue({ pdf: Buffer.from('%PDF-1') })
})

describe('POST /api/admin/competenze/genera — gate dirigenza', () => {
  it('403 quando il gate nega (es. segreteria)', async () => {
    h.requireStaff.mockResolvedValue(denied())
    const res = await GENERA(jreq({ certificatoId: 'c1' }) as never)
    expect(res.status).toBe(403)
  })

  it('401 senza utente', async () => {
    h.requireStaff.mockResolvedValue(unauth())
    const res = await GENERA(jreq({ certificatoId: 'c1' }) as never)
    expect(res.status).toBe(401)
  })

  it('200 per dirigente con certificatoId', async () => {
    const res = await GENERA(jreq({ certificatoId: 'c1' }) as never)
    expect(res.status).toBe(200)
    expect(h.generaCertificato).toHaveBeenCalledWith(expect.anything(), 'c1', 'dir1', true)
  })

  it('propaga lo status di errore dello store (es. 404)', async () => {
    h.generaCertificato.mockResolvedValue({ error: 'Certificato non trovato', status: 404 })
    const res = await GENERA(jreq({ certificatoId: 'cX' }) as never)
    expect(res.status).toBe(404)
  })
})

describe('GET /api/parent/competenze — scope figlio', () => {
  it('figlio non collegato → 403 (nessun leak)', async () => {
    h.requireParentOfStudent.mockResolvedValue({ response: NextResponse.json({ error: 'Accesso negato' }, { status: 403 }) })
    h.certs = [{ id: 'cert-altro', stato: 'firmato' }]
    const res = await PARENT_GET(new Request('http://localhost/api/parent/competenze?studentId=al1&userId=par1') as never)
    expect(res.status).toBe(403)
  })

  it('figlio collegato → ritorna i certificati firmati/generati', async () => {
    h.owns = true
    h.certs = [{ id: 'cert1', stato: 'firmato', anno_scolastico: '2025/2026' }]
    const res = await PARENT_GET(new Request('http://localhost/api/parent/competenze?studentId=al1&userId=par1') as never)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toHaveLength(1)
    expect(body.data[0].id).toBe('cert1')
  })
})
