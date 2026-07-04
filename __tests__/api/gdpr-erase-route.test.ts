import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  logScrittura: vi.fn(),
  alunno: null as Record<string, unknown> | null,
  links: [] as { parent_id: string }[],
  parentChildren: {} as Record<string, { stato: string; anonimizzato_il: string | null }[]>,
  updates: [] as Record<string, unknown>[],
  removed: [] as string[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: (table: string) => {
      const ctx: { table: string } = { table }
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = () => b
      b.is = () => b
      b.neq = () => b
      b.in = () => b
      b.maybeSingle = async () => ({ data: table === 'alunni' ? h.alunno : null, error: null })
      // student_parents: link parent_id; alunni (per i figli del parent): lista
      b.then = (res: (v: unknown) => unknown) => {
        if (table === 'student_parents') return Promise.resolve({ data: h.links, error: null }).then(res)
        return Promise.resolve({ data: [], error: null }).then(res)
      }
      b.update = (row: Record<string, unknown>) => { h.updates.push({ table: ctx.table, ...row }); return { eq: async () => ({ error: null }) } }
      return b
    },
    storage: { from: () => ({ remove: async (paths: string[]) => { h.removed.push(...paths); return { error: null } } }) },
  }),
}))

// Conta i figli iscritti di un parent (per la regola "orfano").
vi.mock('@/lib/gdpr/orfano', () => ({
  parentHaAltriFigliIscritti: vi.fn(async (_s: unknown, parentId: string) => {
    const kids = h.parentChildren[parentId] ?? []
    return kids.some((k) => k.stato === 'iscritto' && !k.anonimizzato_il)
  }),
}))

import { POST } from '@/app/api/admin/gdpr/erase/route'

const req = (body: unknown) =>
  new Request('http://localhost/api/admin/gdpr/erase', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })

beforeEach(() => {
  vi.clearAllMocks()
  h.requireStaff.mockResolvedValue({ user: { id: 'dir-1', role: 'admin', scuola_id: 'sc-1' } })
  h.alunno = { id: 'al-1', nome: 'Marco', cognome: 'Rossi', stato: 'non_iscritto', anonimizzato_il: null, documento_path: null }
  h.links = [{ parent_id: 'p-1' }]
  h.parentChildren = { 'p-1': [] } // orfano
  h.updates = []; h.removed = []
})

describe('POST /api/admin/gdpr/erase', () => {
  it('403 senza Direzione', async () => {
    h.requireStaff.mockResolvedValue({ response: NextResponse.json({}, { status: 403 }) })
    expect((await POST(req({ alunno_id: 'al-1', mode: 'dryrun' }))).status).toBe(403)
  })

  it('404 se alunno assente', async () => {
    h.alunno = null
    expect((await POST(req({ alunno_id: 'nope', mode: 'dryrun' }))).status).toBe(404)
  })

  it('rifiuta un alunno ISCRITTO (409)', async () => {
    h.alunno = { ...h.alunno, stato: 'iscritto' }
    expect((await POST(req({ alunno_id: 'al-1', mode: 'dryrun' }))).status).toBe(409)
  })

  it('dryrun: ritorna conteggi senza scrivere', async () => {
    const res = await POST(req({ alunno_id: 'al-1', mode: 'dryrun' }))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.dryrun).toBe(true)
    expect(json.alunno).toBe(1)
    expect(json.parents).toBe(1)
    expect(h.updates).toHaveLength(0)
  })

  it('execute con conferma errata → 400', async () => {
    const res = await POST(req({ alunno_id: 'al-1', mode: 'execute', confirm: 'Rossi Luca' }))
    expect(res.status).toBe(400)
    expect(h.updates).toHaveLength(0)
  })

  it('execute ok: anonimizza alunno + parent orfano + audit', async () => {
    const res = await POST(req({ alunno_id: 'al-1', mode: 'execute', confirm: 'rossi marco' }))
    expect(res.status).toBe(200)
    const upd = h.updates
    expect(upd.some((u) => u.table === 'alunni' && typeof u.nome === 'string' && (u.nome as string).startsWith('CANCELLATO-'))).toBe(true)
    expect(upd.some((u) => u.table === 'parents' && (u.first_name as string)?.startsWith('CANCELLATO-'))).toBe(true)
    expect(h.logScrittura).toHaveBeenCalled()
  })

  it('parent con altro figlio iscritto → NON anonimizzato', async () => {
    h.parentChildren = { 'p-1': [{ stato: 'iscritto', anonimizzato_il: null }] }
    await POST(req({ alunno_id: 'al-1', mode: 'execute', confirm: 'ROSSI MARCO' }))
    expect(h.updates.some((u) => u.table === 'parents')).toBe(false)
    // l'alunno viene comunque anonimizzato
    expect(h.updates.some((u) => u.table === 'alunni')).toBe(true)
  })
})
