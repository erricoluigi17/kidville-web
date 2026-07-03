import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

// M5.3: "Avvisa" dell'armadietto genitore — requireUser + verifica legame
// genitore↔alunno + notifica staff scuola e docenti sezione (locker_scorte).

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  enqueueNotifiche: vi.fn(),
  docentiDiSezione: vi.fn(),
  legame: { alunno_id: 'a1' } as Record<string, unknown> | null,
  alunno: {
    id: '61616161-6161-4616-8616-616161616161',
    nome: 'Sofia',
    scuola_id: 'sc-1',
    section_id: 'sez-1',
  } as Record<string, unknown> | null,
  staff: [
    { id: 'adm-1', role: 'admin', ruolo: null },
    { id: 'seg-1', role: null, ruolo: 'segreteria' },
    { id: 'edu-1', role: 'educator', ruolo: null },
  ] as Record<string, unknown>[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireUser: h.requireUser }))
vi.mock('@/lib/push/enqueue', () => ({ enqueueNotifiche: h.enqueueNotifiche }))
vi.mock('@/lib/sezioni/docenti', () => ({ docentiDiSezione: h.docentiDiSezione }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from(table: string) {
      if (table === 'legame_genitori_alunni') {
        return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: h.legame, error: null }) }) }) }) }
      }
      if (table === 'alunni') {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: h.alunno, error: null }) }) }) }
      }
      // utenti (staff del plesso)
      return { select: () => ({ eq: () => Promise.resolve({ data: h.staff, error: null }) }) }
    },
  }),
}))

import { POST } from '@/app/api/locker/notify/route'

const ALUNNO = '61616161-6161-4616-8616-616161616161'
const post = (body: unknown) =>
  POST(new Request('http://localhost/api/locker/notify', { method: 'POST', body: JSON.stringify(body) }))

beforeEach(() => {
  vi.clearAllMocks()
  h.requireUser.mockResolvedValue({ user: { id: 'gen-1', role: 'genitore' } })
  h.docentiDiSezione.mockResolvedValue(['edu-1', 'edu-2'])
  h.legame = { alunno_id: ALUNNO }
})

describe('POST /api/locker/notify', () => {
  it('401 senza utente', async () => {
    h.requireUser.mockResolvedValue({ response: NextResponse.json({}, { status: 401 }) })
    expect((await post({ alunno_id: ALUNNO, materiale: 'Pannolini' })).status).toBe(401)
  })

  it('400 body non valido (materiale vuoto)', async () => {
    expect((await post({ alunno_id: ALUNNO, materiale: '' })).status).toBe(400)
  })

  it('403 senza legame genitore↔alunno', async () => {
    h.legame = null
    const res = await post({ alunno_id: ALUNNO, materiale: 'Pannolini' })
    expect(res.status).toBe(403)
    expect(h.enqueueNotifiche).not.toHaveBeenCalled()
  })

  it('200 notifica staff scuola (role O ruolo legacy) + docenti sezione, dedup', async () => {
    const res = await post({ alunno_id: ALUNNO, materiale: 'Pannolini' })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true, destinatari: 4 })
    expect(h.enqueueNotifiche).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tipo: 'locker_scorte',
        entitaTipo: 'armadietto',
        entitaId: ALUNNO,
        bufferMin: 0,
      }),
    )
    // adm-1 + seg-1 (via colonna legacy `ruolo`) + edu-1 dedup con docenti + edu-2
    const ids = (h.enqueueNotifiche.mock.calls[0][1] as { utenteIds: string[] }).utenteIds
    expect([...ids].sort()).toEqual(['adm-1', 'edu-1', 'edu-2', 'seg-1'])
  })
})
