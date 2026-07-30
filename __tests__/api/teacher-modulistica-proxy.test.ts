// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

const h = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  logScrittura: vi.fn(),
  uploads: [] as Array<{ bucket: string; path: string }>,
  inserts: [] as Record<string, unknown>[],
  // Il genitore si risolve ora sull'unione runtime (`legame_genitori_alunni`) +
  // anagrafica (`student_parents` → `parents.auth_user_id`): mock per TABELLA.
  righe: {} as Record<string, Record<string, unknown>[]>,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireDocente: h.requireDocente }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: (table: string) => {
      const righe = () => h.righe[table] ?? []
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = () => b
      b.in = () => b
      b.limit = () => b
      b.maybeSingle = async () => ({ data: righe()[0] ?? null, error: null })
      b.insert = (row: Record<string, unknown>) => { h.inserts.push(row); return b }
      b.single = async () => ({ data: { id: 'sub-cart' }, error: null })
      b.then = (res: (v: { data: unknown; error: null }) => unknown) => res({ data: righe(), error: null })
      return b
    },
    storage: {
      from: (bucket: string) => ({
        upload: async (path: string) => { h.uploads.push({ bucket, path }); return { error: null } },
      }),
    },
  }),
}))

import { POST } from '@/app/api/teacher/modulistica/route'

const pdf = (name = 'firmato.pdf', type = 'application/pdf', bytes = 12) =>
  new File([Buffer.from('x'.repeat(bytes))], name, { type })
function proxyReq(fields: Record<string, string>, file?: File) {
  const fd = new FormData()
  if (file) fd.append('file', file)
  for (const [k, v] of Object.entries(fields)) fd.append(k, v)
  return new Request('http://localhost/api/teacher/modulistica', { method: 'POST', body: fd })
}

beforeEach(() => {
  vi.clearAllMocks()
  h.uploads = []; h.inserts = []
  h.righe = {
    legame_genitori_alunni: [{ alunno_id: 'al-1', genitore_id: 'gen-1' }],
    student_parents: [],
    parents: [],
    // Scope dell'alunno (B2): l'upload cartaceo scrive sul fascicolo di un
    // minore, quindi l'alunno dev'essere nel plesso e nella sezione del docente.
    alunni: [{ id: 'al-1', section_id: 'sec-1', scuola_id: 'sc-1' }],
    utenti_sezioni: [{ section_id: 'sec-1', utente_id: 'doc-1' }],
  }
  h.requireDocente.mockResolvedValue({ user: { id: 'doc-1', role: 'educator', scuola_id: 'sc-1' } })
})

describe('POST /api/teacher/modulistica — proxy upload cartaceo', () => {
  it('401 se non docente', async () => {
    h.requireDocente.mockResolvedValue({ response: NextResponse.json({}, { status: 401 }) })
    expect((await POST(proxyReq({ form_id: 'f-1', student_id: 'al-1' }, pdf()))).status).toBe(401)
  })

  it('400 senza file', async () => {
    expect((await POST(proxyReq({ form_id: 'f-1', student_id: 'al-1' }))).status).toBe(400)
  })

  it('400 senza form_id o student_id', async () => {
    expect((await POST(proxyReq({ form_id: 'f-1' }, pdf()))).status).toBe(400)
  })

  it('400 tipo file non ammesso', async () => {
    const exe = new File([Buffer.from('MZ')], 'v.exe', { type: 'application/octet-stream' })
    expect((await POST(proxyReq({ form_id: 'f-1', student_id: 'al-1' }, exe))).status).toBe(400)
  })

  it('201 carica la scansione e inserisce origine=cartaceo + audit', async () => {
    const res = await POST(proxyReq({ form_id: 'f-1', student_id: 'al-1' }, pdf()))
    expect(res.status).toBe(201)
    expect(h.uploads[0].bucket).toBe('form_attachments')
    expect(h.uploads[0].path).toMatch(/^cartaceo\/f-1\//)
    const row = h.inserts[0]
    expect(row.origine).toBe('cartaceo')
    expect(row.is_signed).toBe(true)
    expect(row.pdf_path).toBe(h.uploads[0].path)
    expect(row.parent_id).toBe('gen-1')
    expect(h.logScrittura).toHaveBeenCalled()
  })

  // ── Scope dell'alunno (B2) ────────────────────────────────────────────────
  // `requireDocente` verifica il RUOLO: senza scope, un docente poteva allegare
  // una scansione al fascicolo di un bambino di un'ALTRA sede (e farsi
  // restituire il legame col suo genitore) semplicemente indovinandone l'id.
  it('403 se l\'alunno è di un\'altra sede: nessun upload, nessuna insert', async () => {
    h.righe.alunni = [{ id: 'al-1', section_id: 'sec-b', scuola_id: 'sc-ALTRA' }]
    const res = await POST(proxyReq({ form_id: 'f-1', student_id: 'al-1' }, pdf()))
    expect(res.status).toBe(403)
    expect(h.uploads).toHaveLength(0)
    expect(h.inserts).toHaveLength(0)
  })

  it('403 se l\'alunno è del proprio plesso ma di una sezione non assegnata', async () => {
    h.righe.utenti_sezioni = [{ section_id: 'sec-altra', utente_id: 'doc-1' }]
    const res = await POST(proxyReq({ form_id: 'f-1', student_id: 'al-1' }, pdf()))
    expect(res.status).toBe(403)
    expect(h.uploads).toHaveLength(0)
    expect(h.inserts).toHaveLength(0)
  })

  it('la segreteria carica su qualunque classe del PROPRIO plesso', async () => {
    h.requireDocente.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: 'sc-1' } })
    h.righe.utenti_sezioni = []
    const res = await POST(proxyReq({ form_id: 'f-1', student_id: 'al-1' }, pdf()))
    expect(res.status).toBe(201)
  })

  it('201 col legame presente SOLO in anagrafica: parent_id valorizzato lo stesso', async () => {
    h.righe.legame_genitori_alunni = []
    h.righe.student_parents = [{ student_id: 'al-1', parent_id: 'p1' }]
    h.righe.parents = [{ id: 'p1', auth_user_id: 'gen-9' }]
    const res = await POST(proxyReq({ form_id: 'f-1', student_id: 'al-1' }, pdf()))
    expect(res.status).toBe(201)
    expect(h.inserts[0].parent_id).toBe('gen-9')
  })
})
