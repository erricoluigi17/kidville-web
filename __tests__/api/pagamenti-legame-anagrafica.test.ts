import { describe, it, expect, vi, beforeEach } from 'vitest'

// A2 — Il ramo genitore di GET /api/pagamenti risolveva i figli leggendo SOLO
// `legame_genitori_alunni`: un genitore importato dal form pubblico (legame in
// `student_parents`) si vedeva rispondere una lista VUOTA, come se non avesse
// figli né rette. Qui si verifica l'unione delle due sorgenti.

const ALUNNO = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  requireUser: vi.fn(),
  righe: {} as Record<string, Record<string, unknown>[]>,
  filtri: [] as { op: string; args: unknown[] }[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff, requireUser: h.requireUser }))
vi.mock('@/lib/auth/scope', () => ({
  resolveScuoleAttive: vi.fn(async () => ['sc-1']),
  assertAlunnoInScope: vi.fn(async () => null),
}))
vi.mock('@/lib/settings/module-config', () => ({ getModuleConfig: async () => ({}) }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: (table: string) => {
      const righe = () => h.righe[table] ?? []
      const b: Record<string, unknown> = {}
      const rec = (op: string) => (...args: unknown[]) => { h.filtri.push({ op: `${table}.${op}`, args }); return b }
      b.select = rec('select'); b.order = rec('order'); b.eq = rec('eq')
      b.in = rec('in'); b.or = rec('or'); b.gte = rec('gte'); b.lte = rec('lte')
      b.maybeSingle = async () => ({ data: righe()[0] ?? null, error: null })
      b.then = (resolve: (v: unknown) => unknown) => resolve({ data: righe(), error: null })
      return b
    },
  }),
}))

import { GET } from '@/app/api/pagamenti/route'

const url = () => new Request('http://localhost/api/pagamenti') as unknown as import('next/server').NextRequest
const filtroAlunni = () => h.filtri.find((c) => c.op === 'pagamenti.in' && c.args[0] === 'alunno_id')

beforeEach(() => {
  vi.clearAllMocks()
  h.filtri.length = 0
  h.righe = {}
  h.requireUser.mockResolvedValue({ user: { id: 'gen-1', role: 'genitore' } })
})

describe('GET /api/pagamenti — figli dall\'unione runtime+anagrafica', () => {
  it('genitore col legame SOLO in student_parents: i pagamenti del figlio si vedono', async () => {
    h.righe = {
      legame_genitori_alunni: [],
      parents: [{ id: 'p1' }],
      student_parents: [{ student_id: ALUNNO }],
      pagamenti: [{ id: 'pag-1', alunno_id: ALUNNO, scuola_id: 'sc-1', importo: 100, importo_pagato: 0, stato: 'da_pagare', tipo: 'singolo', scadenza: '2026-08-31' }],
    }
    const res = await GET(url())
    expect(res.status).toBe(200)
    expect(filtroAlunni()?.args[1]).toEqual([ALUNNO])
    const j = await res.json()
    expect(j.data).toHaveLength(1)
  })

  it('nessun legame in nessuna delle due sorgenti: lista vuota (invariato)', async () => {
    h.righe = { legame_genitori_alunni: [], parents: [], student_parents: [] }
    const res = await GET(url())
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true, data: [] })
    expect(filtroAlunni()).toBeUndefined()
  })

  it('legame solo runtime: comportamento storico preservato', async () => {
    h.righe = {
      legame_genitori_alunni: [{ alunno_id: ALUNNO }],
      parents: [],
      student_parents: [],
      pagamenti: [],
    }
    const res = await GET(url())
    expect(res.status).toBe(200)
    expect(filtroAlunni()?.args[1]).toEqual([ALUNNO])
  })
})
