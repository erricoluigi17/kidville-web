import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

// P0 (DL-036/DL-037): l'import iscrizioni (bulk → alunni/parents/legame) deve
// essere gated (Segreteria+Direzione) e auditato per ogni entità creata.

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  logScrittura: vi.fn(),
  sub: null as Record<string, unknown> | null,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@/lib/email/send', () => ({ sendEmail: async () => true, credentialsEmailBody: () => 'x' }))

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    storage: { from: () => ({ createSignedUrl: async () => ({ data: { signedUrl: 'u' }, error: null }) }) },
    auth: { admin: { createUser: async () => ({ data: { user: { id: 'auth-new' } }, error: null }) } },
    from(table: string) {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = () => b
      b.order = async () => ({ data: [], error: null })
      b.maybeSingle = async () => ({ data: null, error: null }) // forza creazione (no dedup)
      b.single = async () => {
        if (table === 'enrollment_submissions') return { data: h.sub, error: null }
        return { data: null, error: null }
      }
      b.insert = (row: unknown) => ({
        select: () => ({ single: async () => ({ data: { id: `${table}-new`, nome: (row as any)?.nome ?? 'X' }, error: null }) }),
      })
      b.update = () => ({ eq: () => ({ select: () => ({ single: async () => ({ data: { id: 'x' }, error: null }) }) }) })
      b.upsert = async () => ({ data: null, error: null })
      return b
    },
  }),
}))

import { PATCH, GET } from '@/app/api/admin/iscrizioni/route'

const req = (body: unknown) =>
  new Request('http://localhost/api/admin/iscrizioni', {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })

const denied = () => ({ response: NextResponse.json({ error: 'denied' }, { status: 403 }) }) as never

beforeEach(() => {
  vi.clearAllMocks()
  h.requireStaff.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: 'sc-1' } })
  h.sub = {
    id: 'sub-1',
    scuola_id: 'sc-1',
    data: {
      children: [{ nome: 'Bimbo', codice_fiscale: 'CFC1' }],
      adults: [{ first_name: 'Anna', fiscal_code: 'CF1' }], // niente email → nessun account auth
    },
  }
})

describe('P0 iscrizioni import — gate + audit', () => {
  it('PATCH: 403 quando il gate nega', async () => {
    h.requireStaff.mockResolvedValue(denied())
    const res = await PATCH(req({ id: 'sub-1', action: 'import', assignments: { '0': 'Girasoli' }, referenteIndex: 99 }) as never)
    expect(res.status).toBe(403)
    expect(h.requireStaff).toHaveBeenCalled()
  })

  it('GET: 403 quando il gate nega', async () => {
    h.requireStaff.mockResolvedValue(denied())
    const res = await GET(new Request('http://localhost/api/admin/iscrizioni') as never)
    expect(res.status).toBe(403)
  })

  it('import: audit insert(genitori) + insert(alunni) per ogni entità creata', async () => {
    const res = await PATCH(req({ id: 'sub-1', action: 'import', assignments: { '0': 'Girasoli' }, referenteIndex: 99 }) as never)
    expect(res.status).toBe(200)
    const tipi = h.logScrittura.mock.calls.map((c) => (c[1] as { entitaTipo: string }).entitaTipo)
    expect(tipi).toContain('genitori')
    expect(tipi).toContain('alunni')
  })
})
