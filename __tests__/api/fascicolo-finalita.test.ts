import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── P2/Slice 4 — Finalità di accesso al Fascicolo cablata. ──
// Le route fascicolo devono inoltrare il parametro `finalita` a
// logAccessoFascicolo (colonna fascicolo_accessi_audit.finalita già esistente),
// oggi sempre null. Tracciamento accessi più completo (DL-011 / §Fascicolo).

const rbac = vi.hoisted(() => ({
  puoAccedereFascicolo: vi.fn(),
  logAccessoFascicolo: vi.fn(),
}))
vi.mock('@/lib/primaria/fascicolo-rbac', () => rbac)

const h = vi.hoisted(() => {
  const state = { queues: {} as Record<string, Array<{ data: unknown; error: unknown }>>, used: {} as Record<string, number> }
  function take(table: string) {
    const q = state.queues[table] || []
    const i = state.used[table] ?? 0
    state.used[table] = i + 1
    return q[i] ?? { data: null, error: null }
  }
  function makeClient() {
    return {
      from(table: string) {
        const qb: Record<string, unknown> = {}
        for (const m of ['select', 'eq', 'order', 'limit', 'in']) qb[m] = () => qb
        qb.single = () => Promise.resolve(take(table))
        qb.maybeSingle = () => Promise.resolve(take(table))
        qb.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
          Promise.resolve(take(table)).then(res, rej)
        return qb
      },
      storage: {
        from: () => ({ createSignedUrl: () => Promise.resolve({ data: { signedUrl: 'https://signed/x' }, error: null }) }),
      },
    }
  }
  return { state, makeClient }
})

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: vi.fn().mockResolvedValue(h.makeClient()),
}))
const auth = vi.hoisted(() => ({ getRequestUserId: vi.fn(), resolveIdentity: vi.fn(), loadAppUser: vi.fn() }))
vi.mock('@/lib/auth/require-staff', () => auth)

import { GET as LIST } from '@/app/api/primaria/fascicolo/route'
import { GET as FILE } from '@/app/api/primaria/fascicolo/file/route'
import { NextRequest } from 'next/server'

beforeEach(() => {
  vi.clearAllMocks()
  h.state.queues = {}
  h.state.used = {}
  auth.getRequestUserId.mockReturnValue('u-1')
  auth.resolveIdentity.mockResolvedValue({ userId: 'u-1', source: 'header' })
  rbac.puoAccedereFascicolo.mockResolvedValue({ consentito: true, ruolo: 'coordinator', motivo: 'staff' })
  rbac.logAccessoFascicolo.mockResolvedValue(undefined)
})

describe('Fascicolo — finalità di accesso', () => {
  it('GET list inoltra finalita a logAccessoFascicolo', async () => {
    h.state.queues = { student_documents: [{ data: [], error: null }] }
    const req = new NextRequest('http://localhost/api/primaria/fascicolo?alunnoId=a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1&finalita=Colloquio%20GLO', { headers: { 'x-user-id': 'u-1' } })
    const res = await LIST(req)
    expect(res.status).toBe(200)
    expect(rbac.logAccessoFascicolo).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ azione: 'list', finalita: 'Colloquio GLO' }),
    )
  })

  it('GET file (download) inoltra finalita a logAccessoFascicolo', async () => {
    h.state.queues = { student_documents: [{ data: { id: 'd1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1', student_id: 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1', storage_path: 'a-1/x.pdf', file_name: 'x.pdf' }, error: null }] }
    const req = new NextRequest('http://localhost/api/primaria/fascicolo/file?documentoId=d1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1&finalita=Verifica%20diagnosi', { headers: { 'x-user-id': 'u-1' } })
    const res = await FILE(req)
    expect(res.status).toBe(200)
    expect(rbac.logAccessoFascicolo).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ azione: 'download', finalita: 'Verifica diagnosi' }),
    )
  })
})
