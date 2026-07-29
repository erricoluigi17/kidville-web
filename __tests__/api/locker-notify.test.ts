import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

// M5.3: "Avvisa" dell'armadietto genitore — requireUser + verifica legame
// genitore↔alunno + notifica staff scuola e docenti sezione (locker_scorte).

// Il legame genitore↔alunno si risolve ora sull'UNIONE runtime
// (`legame_genitori_alunni`) + anagrafica (`student_parents` → `parents`): il
// mock è per TABELLA, non più una catena cablata su una sola.
const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  enqueueNotifiche: vi.fn(),
  docentiDiSezione: vi.fn(),
  righe: {} as Record<string, Record<string, unknown>[]>,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireUser: h.requireUser }))
vi.mock('@/lib/push/enqueue', () => ({ enqueueNotifiche: h.enqueueNotifiche }))
vi.mock('@/lib/sezioni/docenti', () => ({ docentiDiSezione: h.docentiDiSezione }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from(table: string) {
      const righe = () => h.righe[table] ?? []
      const b: Record<string, unknown> = {}
      const chain = () => b
      b.select = chain; b.eq = chain; b.in = chain
      b.maybeSingle = async () => ({ data: righe()[0] ?? null, error: null })
      b.then = (res: (v: { data: unknown; error: null }) => unknown) => res({ data: righe(), error: null })
      return b
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
  h.righe = {
    legame_genitori_alunni: [{ genitore_id: 'gen-1', alunno_id: ALUNNO }],
    parents: [],
    student_parents: [],
    alunni: [{ id: ALUNNO, nome: 'Sofia', scuola_id: 'sc-1', section_id: 'sez-1' }],
    utenti: [
      { id: 'adm-1', role: 'admin', ruolo: null },
      { id: 'seg-1', role: null, ruolo: 'segreteria' },
      { id: 'edu-1', role: 'educator', ruolo: null },
    ],
  }
})

describe('POST /api/locker/notify', () => {
  it('401 senza utente', async () => {
    h.requireUser.mockResolvedValue({ response: NextResponse.json({}, { status: 401 }) })
    expect((await post({ alunno_id: ALUNNO, materiale: 'Pannolini' })).status).toBe(401)
  })

  it('400 body non valido (materiale vuoto)', async () => {
    expect((await post({ alunno_id: ALUNNO, materiale: '' })).status).toBe(400)
  })

  it('403 senza legame genitore↔alunno (in NESSUNA delle due sorgenti)', async () => {
    h.righe.legame_genitori_alunni = []
    const res = await post({ alunno_id: ALUNNO, materiale: 'Pannolini' })
    expect(res.status).toBe(403)
    expect(h.enqueueNotifiche).not.toHaveBeenCalled()
  })

  it('200 anche col legame presente SOLO in anagrafica (student_parents)', async () => {
    h.righe.legame_genitori_alunni = []
    h.righe.parents = [{ id: 'p1', auth_user_id: 'gen-1' }]
    h.righe.student_parents = [{ student_id: ALUNNO, parent_id: 'p1' }]
    expect((await post({ alunno_id: ALUNNO, materiale: 'Pannolini' })).status).toBe(200)
    expect(h.enqueueNotifiche).toHaveBeenCalledTimes(1)
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
