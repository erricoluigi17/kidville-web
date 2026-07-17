import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

// M4 — Morosità residua: il genitore SOSPESO non può inviare messaggi in chat.
// La guardia va DOPO l'identità di sessione (requireUser) e blocca solo la
// SCRITTURA (POST). Le letture (GET) restano accessibili.

const TEACHER = 'aaaaaaaa-0000-4000-8000-000000000001'
const PARENT = 'bbbbbbbb-0000-4000-8000-000000000002'
const THREAD = 'dddddddd-0000-4000-8000-000000000004'

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  assertGenitore: vi.fn(),
  controparteThread: vi.fn(),
  nomeUtente: vi.fn(),
  notificaEvento: vi.fn(),
  inserted: null as Record<string, unknown> | null,
  thread: null as Record<string, unknown> | null,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireUser: h.requireUser }))
vi.mock('@/lib/pagamenti/sospensione', () => ({ assertGenitoreNonSospeso: h.assertGenitore }))
vi.mock('@/lib/chat/delivered', () => ({ marcaConsegnati: vi.fn() }))
vi.mock('@/lib/notifiche/destinatari', () => ({ controparteThread: h.controparteThread }))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: h.notificaEvento, nomeUtente: h.nomeUtente }))

const adminClient = {
  from(table: string) {
    const b: Record<string, unknown> = {}
    b.select = () => b
    b.eq = () => b
    b.maybeSingle = async () => {
      if (table === 'chat_threads') return { data: h.thread, error: null }
      if (table === 'utenti') return { data: { scuola_id: 'sc-1' }, error: null }
      return { data: null, error: null }
    }
    b.insert = (row: Record<string, unknown>) => {
      h.inserted = { id: 'msg-new', ...row }
      return { select: () => ({ single: async () => ({ data: h.inserted, error: null }) }) }
    }
    b.update = () => ({ eq: async () => ({ error: null }) })
    return b
  },
}
vi.mock('@/lib/supabase/server-client', () => ({ createAdminClient: async () => adminClient }))

import { POST } from '@/app/api/chat/messages/route'

const postReq = (body: unknown) =>
  new Request('http://localhost/api/chat/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

beforeEach(() => {
  vi.clearAllMocks()
  h.requireUser.mockResolvedValue({ user: { id: PARENT, role: 'genitore', scuola_id: 'sc-1' } })
  h.controparteThread.mockResolvedValue(null)
  h.nomeUtente.mockResolvedValue(null)
  h.notificaEvento.mockResolvedValue(undefined)
  h.inserted = null
  h.thread = { teacher_id: TEACHER, parent_id: PARENT }
})

describe('POST /api/chat/messages — gate sospensione morosità (M4)', () => {
  it('genitore sospeso → 403 e NESSUN messaggio inserito', async () => {
    h.assertGenitore.mockResolvedValue(
      NextResponse.json({ motivo: 'account_sospeso' }, { status: 403 }),
    )
    const res = await POST(postReq({ thread_id: THREAD, content: 'ciao' }))
    expect(res.status).toBe(403)
    expect(h.inserted).toBeNull()
    // La guardia è invocata con l'identità di SESSIONE (mai dal body).
    expect(h.assertGenitore).toHaveBeenCalledWith(expect.anything(), PARENT)
  })

  it('genitore non sospeso → 201 e messaggio inserito', async () => {
    h.assertGenitore.mockResolvedValue(null)
    const res = await POST(postReq({ thread_id: THREAD, content: 'ciao' }))
    expect(res.status).toBe(201)
    expect(h.inserted).toMatchObject({ sender_id: PARENT })
    expect(h.assertGenitore).toHaveBeenCalled()
  })
})
