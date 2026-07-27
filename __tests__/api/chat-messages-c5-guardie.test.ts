import { describe, it, expect, vi, beforeEach } from 'vitest'

// C5 — Le due guardie server-side di POST /api/chat/messages, esercitate
// END-TO-END attraverso la route (guardie reali, non mockate):
//   1. conversazione sospesa → 403 motivo conversazione_sospesa
//   2. genitore senza Termini accettati → 403 motivo termini_non_accettati
// In entrambi i casi NESSUN messaggio viene inserito. Il MOTIVO della sospensione
// non deve MAI comparire in chiaro in un log (criterio 6).

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
  sospensione: null as Record<string, unknown> | null,
  parent: null as Record<string, unknown> | null,
}))

// Solo il guard morosità è mockato (torna null): le DUE guardie C5 girano reali.
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
    b.is = () => b
    b.maybeSingle = async () => {
      if (table === 'chat_threads') return { data: h.thread, error: null }
      if (table === 'conversazioni_sospensioni') return { data: h.sospensione, error: null }
      if (table === 'parents') return { data: h.parent, error: null }
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
  h.assertGenitore.mockResolvedValue(null) // non moroso
  h.controparteThread.mockResolvedValue(null)
  h.nomeUtente.mockResolvedValue(null)
  h.notificaEvento.mockResolvedValue(undefined)
  h.inserted = null
  h.thread = { teacher_id: TEACHER, parent_id: PARENT }
  h.sospensione = null
  h.parent = { consensi_gdpr: { privacy: true, termini: true } } // onboardato ok
})

describe('POST /api/chat/messages — guardia conversazione sospesa (C5)', () => {
  it('thread sospeso verso il mittente → 403 motivo conversazione_sospesa, nessun insert', async () => {
    h.sospensione = { sospesa_verso: PARENT }
    const res = await POST(postReq({ thread_id: THREAD, content: 'ciao' }))
    expect(res.status).toBe(403)
    expect((await res.json()).motivo).toBe('conversazione_sospesa')
    expect(h.inserted).toBeNull()
  })

  it('chi HA sospeso può ancora scrivere (sospesa_verso = altro) → 201', async () => {
    h.sospensione = { sospesa_verso: TEACHER }
    const res = await POST(postReq({ thread_id: THREAD, content: 'ciao' }))
    expect(res.status).toBe(201)
    expect(h.inserted).toMatchObject({ sender_id: PARENT })
  })

  it('il MOTIVO non compare mai in chiaro nei log (criterio 6)', async () => {
    const logger = await import('@/lib/logging/logger')
    const spiaEvt = vi.spyOn(logger, 'logEvento')
    const spiaErr = vi.spyOn(logger, 'logErrore')
    h.sospensione = { sospesa_verso: PARENT, motivo: 'MOTIVO_SEGRETO_DA_NON_LOGGARE' }
    const res = await POST(postReq({ thread_id: THREAD, content: 'ciao' }))
    expect(res.status).toBe(403)
    const dump = JSON.stringify([...spiaEvt.mock.calls, ...spiaErr.mock.calls])
    expect(dump).not.toContain('MOTIVO_SEGRETO_DA_NON_LOGGARE')
    spiaEvt.mockRestore()
    spiaErr.mockRestore()
  })
})

describe('POST /api/chat/messages — gate Termini (C5)', () => {
  it('genitore senza termini accettati → 403 motivo termini_non_accettati, nessun insert', async () => {
    h.parent = { consensi_gdpr: { privacy: true } } // manca termini
    const res = await POST(postReq({ thread_id: THREAD, content: 'ciao' }))
    expect(res.status).toBe(403)
    expect((await res.json()).motivo).toBe('termini_non_accettati')
    expect(h.inserted).toBeNull()
  })

  it('genitore con termini accettati → 201 e messaggio inserito', async () => {
    const res = await POST(postReq({ thread_id: THREAD, content: 'ciao' }))
    expect(res.status).toBe(201)
    expect(h.inserted).toMatchObject({ sender_id: PARENT })
  })

  it('docente (staff): il gate Termini è trasparente → 201', async () => {
    h.requireUser.mockResolvedValue({ user: { id: TEACHER, role: 'educator', scuola_id: 'sc-1' } })
    h.parent = null // nessun record parents per lo staff
    const res = await POST(postReq({ thread_id: THREAD, content: 'ciao' }))
    expect(res.status).toBe(201)
    expect(h.inserted).toMatchObject({ sender_id: TEACHER })
  })
})
