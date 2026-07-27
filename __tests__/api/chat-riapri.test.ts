import { describe, it, expect, vi, beforeEach } from 'vitest'

// C5 §2 — POST /api/chat/threads/[id]/riapri
// Riapertura = UPDATE dei soli campi riaperta_* sulla riga ATTIVA (mai INSERT né DELETE):
// lo storico append-only resta intero. Autorizzato SOLO a:
//  · chi ha sospeso (sospesa_da === chiamante) → riaperta_tipo='sospendente';
//  · staff con ruolo admin/coordinator → riaperta_tipo='direzione'.
// Un terzo (né sospendente né direzione) → 403.

const SOSPENDENTE = 'aaaaaaaa-0000-4000-8000-000000000001'
const ALTRO = 'bbbbbbbb-0000-4000-8000-000000000002'
const ADMIN = 'cccccccc-0000-4000-8000-000000000003'
const THREAD = 'dddddddd-0000-4000-8000-000000000004'

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  attiva: null as Record<string, unknown> | null,
  updated: null as Record<string, unknown> | null,
  insertCalled: false,
  deleteCalled: false,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireUser: h.requireUser }))

const adminClient = {
  from(table: string) {
    const b: Record<string, unknown> = {}
    b.select = () => b
    b.eq = () => b
    b.is = () => b
    b.maybeSingle = async () => {
      if (table === 'conversazioni_sospensioni') return { data: h.attiva, error: null }
      return { data: null, error: null }
    }
    b.update = (row: Record<string, unknown>) => {
      h.updated = row
      // update().eq().is() → awaitable { error }
      const u: Record<string, unknown> = {}
      u.eq = () => u
      u.is = () => u
      u.then = (onF: (v: { error: null }) => unknown) => Promise.resolve({ error: null }).then(onF)
      return u
    }
    b.insert = () => { h.insertCalled = true; return b }
    b.delete = () => { h.deleteCalled = true; return b }
    return b
  },
}
vi.mock('@/lib/supabase/server-client', () => ({ createAdminClient: async () => adminClient }))

import { POST } from '@/app/api/chat/threads/[id]/riapri/route'

const req = () =>
  new Request(`http://localhost/api/chat/threads/${THREAD}/riapri`, { method: 'POST' })
const ctx = { params: Promise.resolve({ id: THREAD }) }

beforeEach(() => {
  vi.clearAllMocks()
  h.attiva = { id: 'sosp-1', sospesa_da: SOSPENDENTE }
  h.updated = null
  h.insertCalled = false
  h.deleteCalled = false
})

describe('POST /api/chat/threads/[id]/riapri', () => {
  it('chi ha sospeso riapre → 200, UPDATE riaperta_* con tipo=sospendente, mai INSERT/DELETE', async () => {
    h.requireUser.mockResolvedValue({ user: { id: SOSPENDENTE, role: 'genitore' } })
    const res = await POST(req(), ctx)
    expect(res.status).toBe(200)
    expect(h.updated).toMatchObject({ riaperta_da: SOSPENDENTE, riaperta_tipo: 'sospendente' })
    expect(h.updated?.riaperta_il).toBeTruthy()
    expect(h.insertCalled).toBe(false)
    expect(h.deleteCalled).toBe(false)
  })

  it('staff admin riapre (anche se non è il sospendente) → 200, tipo=direzione', async () => {
    h.requireUser.mockResolvedValue({ user: { id: ADMIN, role: 'admin' } })
    const res = await POST(req(), ctx)
    expect(res.status).toBe(200)
    expect(h.updated).toMatchObject({ riaperta_da: ADMIN, riaperta_tipo: 'direzione' })
  })

  it('coordinator riapre → 200, tipo=direzione', async () => {
    h.requireUser.mockResolvedValue({ user: { id: ADMIN, role: 'coordinator' } })
    const res = await POST(req(), ctx)
    expect(res.status).toBe(200)
    expect(h.updated).toMatchObject({ riaperta_tipo: 'direzione' })
  })

  it('un terzo (né sospendente né direzione) → 403 e NESSUN update', async () => {
    h.requireUser.mockResolvedValue({ user: { id: ALTRO, role: 'genitore' } })
    const res = await POST(req(), ctx)
    expect(res.status).toBe(403)
    expect(h.updated).toBeNull()
  })

  it('educator che non ha sospeso → 403 (educator non è direzione)', async () => {
    h.requireUser.mockResolvedValue({ user: { id: ALTRO, role: 'educator' } })
    const res = await POST(req(), ctx)
    expect(res.status).toBe(403)
    expect(h.updated).toBeNull()
  })

  it('nessuna sospensione attiva → 404', async () => {
    h.attiva = null
    h.requireUser.mockResolvedValue({ user: { id: SOSPENDENTE, role: 'genitore' } })
    const res = await POST(req(), ctx)
    expect(res.status).toBe(404)
  })
})
