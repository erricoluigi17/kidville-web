// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireStaff: vi.fn(),
  requireDocente: vi.fn(),
  logScrittura: vi.fn(),
  legame: null as Record<string, unknown> | null,
  uploadCalls: [] as unknown[],
  inserts: [] as Record<string, unknown>[],
  updates: [] as { id: unknown; row: Record<string, unknown> }[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireUser: h.requireUser, requireStaff: h.requireStaff, requireDocente: h.requireDocente }))
vi.mock('@/lib/auth/scope', () => ({ assertAlunnoInScope: async () => null, assertClasseNomeInScope: async () => null }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = () => b
      b.order = () => b
      b.maybeSingle = async () => ({ data: table === 'legame_genitori_alunni' ? h.legame : table === 'certificati_medici' ? { alunno_id: 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1' } : null, error: null })
      b.single = async () => ({ data: { id: 'cert-1', stato: 'in_validazione' }, error: null })
      b.insert = (row: Record<string, unknown>) => { h.inserts.push(row); return b }
      b.update = (row: Record<string, unknown>) => ({ eq: async (_c: string, v: unknown) => { h.updates.push({ id: v, row }); return { error: null } } })
      return b
    },
    storage: { from: () => ({ upload: async (...args: unknown[]) => { h.uploadCalls.push(args); return { error: null } } }) },
  }),
}))

import { POST } from '@/app/api/parent/medical-certificates/route'
import { PATCH } from '@/app/api/teacher/medical-certificates/route'

function uploadReq(fields: Record<string, string>, withFile = true) {
  const fd = new FormData()
  if (withFile) fd.append('file', new File([Buffer.from('PDFDATA')], 'cert.pdf', { type: 'application/pdf' }))
  for (const [k, v] of Object.entries(fields)) fd.append(k, v)
  return new Request('http://localhost/api/parent/medical-certificates', { method: 'POST', body: fd })
}
function patchReq(body: unknown) {
  return new Request('http://localhost/api/teacher/medical-certificates', {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
}

describe('POST /api/parent/medical-certificates (upload)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.legame = { alunno_id: 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1' }
    h.uploadCalls = []
    h.inserts = []
    h.requireUser.mockResolvedValue({ user: { id: 'gen-1', role: 'genitore' } })
  })

  it('401 se non autenticato', async () => {
    h.requireUser.mockResolvedValue({ response: NextResponse.json({}, { status: 401 }) })
    expect((await POST(uploadReq({ student_id: 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1', data_inizio: '2026-03-01', data_fine: '2026-03-05' }))).status).toBe(401)
  })

  it('400 senza file', async () => {
    expect((await POST(uploadReq({ student_id: 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1', data_inizio: '2026-03-01', data_fine: '2026-03-05' }, false))).status).toBe(400)
  })

  it('400 periodo non valido (inizio > fine)', async () => {
    expect((await POST(uploadReq({ student_id: 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1', data_inizio: '2026-03-06', data_fine: '2026-03-05' }))).status).toBe(400)
  })

  it('403 se il genitore non è collegato all’alunno', async () => {
    h.legame = null
    expect((await POST(uploadReq({ student_id: 'a9a9a9a9-a9a9-a9a9-a9a9-a9a9a9a9a9a9', data_inizio: '2026-03-01', data_fine: '2026-03-05' }))).status).toBe(403)
  })

  it('201: carica il file e crea il record in_validazione', async () => {
    const res = await POST(uploadReq({ student_id: 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1', data_inizio: '2026-03-01', data_fine: '2026-03-05', note: 'influenza' }))
    expect(res.status).toBe(201)
    expect(h.uploadCalls).toHaveLength(1)
    expect(h.inserts[0].stato).toBe('in_validazione')
    expect(h.inserts[0].caricato_da).toBe('gen-1')
    expect(h.inserts[0].data_inizio).toBe('2026-03-01')
  })
})

describe('PATCH /api/teacher/medical-certificates (validazione)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.updates = []
    h.requireDocente.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: 's1' } })
  })

  it('gated al personale (docente/staff)', async () => {
    h.requireDocente.mockResolvedValue({ response: NextResponse.json({}, { status: 403 }) })
    expect((await PATCH(patchReq({ id: 'cert-1', esito: 'validato' }))).status).toBe(403)
  })

  it('400 con esito non valido', async () => {
    expect((await PATCH(patchReq({ id: 'cert-1', esito: 'boh' }))).status).toBe(400)
  })

  it('valida: stato validato + validato_da + audit', async () => {
    const res = await PATCH(patchReq({ id: 'cert-1', esito: 'validato' }))
    expect(res.status).toBe(200)
    expect(h.updates[0].row.stato).toBe('validato')
    expect(h.updates[0].row.validato_da).toBe('seg-1')
    expect(h.logScrittura).toHaveBeenCalledTimes(1)
  })

  it('400 se la correzione periodo è incoerente', async () => {
    expect((await PATCH(patchReq({ id: 'cert-1', esito: 'validato', data_inizio: '2026-03-09', data_fine: '2026-03-05' }))).status).toBe(400)
  })
})
