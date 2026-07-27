import { describe, it, expect, vi, beforeEach } from 'vitest'

// C5 §2 — POST /api/chat/threads/[id]/sospendi
// Sospensione di una conversazione 1:1 (decisione titolare B: dichiarata, non silenziosa).
//  · bidirezionale: genitore→docente e docente→genitore;
//  · deve essere partecipante del thread (altrimenti 403);
//  · una sola sospensione ATTIVA per thread → 409 sul doppione;
//  · notifica la Direzione (tipo conversazione_sospesa), corpo GENERICO senza motivo;
//  · il MOTIVO (testo libero) non compare MAI in chiaro nei log (criterio 6).

const TEACHER = 'aaaaaaaa-0000-4000-8000-000000000001'
const PARENT = 'bbbbbbbb-0000-4000-8000-000000000002'
const THIRD = 'cccccccc-0000-4000-8000-000000000003'
const THREAD = 'dddddddd-0000-4000-8000-000000000004'

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  staffScuola: vi.fn(),
  scuolaUnicaReale: vi.fn(),
  notificaEvento: vi.fn(),
  thread: null as Record<string, unknown> | null,
  attiva: null as Record<string, unknown> | null,
  inserted: null as Record<string, unknown> | null,
  insertError: null as { code?: string; message?: string } | null,
  fromCalls: [] as string[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireUser: h.requireUser }))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: h.notificaEvento }))
vi.mock('@/lib/notifiche/destinatari', () => ({
  staffScuola: h.staffScuola,
  scuolaUnicaReale: h.scuolaUnicaReale,
}))

const adminClient = {
  from(table: string) {
    h.fromCalls.push(table)
    const st = { didInsert: false }
    const b: Record<string, unknown> = {}
    b.select = () => b
    b.eq = () => b
    b.is = () => b
    b.insert = (row: Record<string, unknown>) => {
      st.didInsert = true
      h.inserted = row
      return b
    }
    b.maybeSingle = async () => {
      if (table === 'chat_threads') return { data: h.thread, error: null }
      if (table === 'alunni') return { data: { scuola_id: 'sc-1' }, error: null }
      if (table === 'conversazioni_sospensioni') {
        if (st.didInsert) {
          return { data: h.insertError ? null : { id: 'sosp-new' }, error: h.insertError }
        }
        return { data: h.attiva, error: null }
      }
      return { data: null, error: null }
    }
    return b
  },
}
vi.mock('@/lib/supabase/server-client', () => ({ createAdminClient: async () => adminClient }))

import { POST } from '@/app/api/chat/threads/[id]/sospendi/route'

const req = (body: unknown) =>
  new Request(`http://localhost/api/chat/threads/${THREAD}/sospendi`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
const ctx = { params: Promise.resolve({ id: THREAD }) }

beforeEach(() => {
  vi.clearAllMocks()
  h.requireUser.mockResolvedValue({ user: { id: PARENT, role: 'genitore', scuola_id: null } })
  h.staffScuola.mockResolvedValue(['admin-1'])
  h.scuolaUnicaReale.mockResolvedValue('sc-1')
  h.notificaEvento.mockResolvedValue(undefined)
  h.thread = { teacher_id: TEACHER, parent_id: PARENT, student_id: 'stud-1' }
  h.attiva = null
  h.inserted = null
  h.insertError = null
  h.fromCalls = []
})

describe('POST /api/chat/threads/[id]/sospendi', () => {
  it('genitore → docente: 201, riga con sospesa_da=genitore e sospesa_verso=docente', async () => {
    const res = await POST(req({ motivo: 'toni sgradevoli' }), ctx)
    expect(res.status).toBe(201)
    expect(h.inserted).toMatchObject({
      thread_id: THREAD,
      sospesa_da: PARENT,
      sospesa_verso: TEACHER,
    })
    // Notifica la Direzione col tipo dedicato, corpo generico (mai il motivo).
    expect(h.notificaEvento).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tipo: 'conversazione_sospesa', link: '/admin/moderazione' }),
    )
    const arg = h.notificaEvento.mock.calls[0][1] as { corpo?: string; titolo?: string }
    expect(`${arg.titolo} ${arg.corpo}`).not.toContain('toni sgradevoli')
  })

  it('docente → genitore: 201, direzione invertita', async () => {
    h.requireUser.mockResolvedValue({ user: { id: TEACHER, role: 'educator', scuola_id: 'sc-1' } })
    const res = await POST(req({}), ctx)
    expect(res.status).toBe(201)
    expect(h.inserted).toMatchObject({ sospesa_da: TEACHER, sospesa_verso: PARENT })
  })

  it('sospensione già attiva → 409 e NESSUN insert', async () => {
    h.attiva = { id: 'sosp-esistente' }
    const res = await POST(req({}), ctx)
    expect(res.status).toBe(409)
    expect(h.inserted).toBeNull()
  })

  it('race a livello di indice (23505 sull’insert) → 409', async () => {
    h.insertError = { code: '23505', message: 'duplicate key' }
    const res = await POST(req({}), ctx)
    expect(res.status).toBe(409)
  })

  it('non-partecipante → 403 e NESSUN insert', async () => {
    h.requireUser.mockResolvedValue({ user: { id: THIRD, role: 'genitore', scuola_id: null } })
    const res = await POST(req({}), ctx)
    expect(res.status).toBe(403)
    expect(h.inserted).toBeNull()
  })

  it('thread inesistente → 404', async () => {
    h.thread = null
    const res = await POST(req({}), ctx)
    expect(res.status).toBe(404)
  })

  it('il MOTIVO non compare mai in chiaro nei log (criterio 6)', async () => {
    const logger = await import('@/lib/logging/logger')
    const spiaEvt = vi.spyOn(logger, 'logEvento')
    const spiaErr = vi.spyOn(logger, 'logErrore')
    const res = await POST(req({ motivo: 'MOTIVO_SEGRETO_NEI_LOG' }), ctx)
    expect(res.status).toBe(201)
    const dump = JSON.stringify([...spiaEvt.mock.calls, ...spiaErr.mock.calls])
    expect(dump).not.toContain('MOTIVO_SEGRETO_NEI_LOG')
    spiaEvt.mockRestore()
    spiaErr.mockRestore()
  })
})
