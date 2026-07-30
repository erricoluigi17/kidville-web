import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { DBFinto } from '../fixtures/finto-supabase'

// =============================================================================
// Modulistica — il caso in cui l'isolamento NON era rimediabile in codice.
//
// Prima della migrazione `modulistica_sede_su_modelli_e_compilazioni`
// (2026-07-30) non esisteva NESSUN dato da cui dedurre a quale plesso
// appartenesse una compilazione: `form_submissions` non aveva la sede, il
// modello nemmeno, e `user_id` non ha una FK. Elenchi, graduatorie ed export
// mostravano quindi i dati delle famiglie di tutte e tre le sedi a qualunque
// segreteria — e non c'era niente su cui filtrare.
//
// Ora la sede è scritta all'INVIO (`forms/submit`, `public/forms/[token]/submit`)
// e i lettori la filtrano. Qui si verificano entrambe le metà: che venga scritta,
// e che venga rispettata.
// =============================================================================

const SEDE_A = 'aaaaaaaa-0000-4000-8000-00000000000a'
const SEDE_B = 'bbbbbbbb-0000-4000-8000-00000000000b'
const SUB_A = '11111111-1111-4111-8111-111111111111'
const SUB_B = '22222222-2222-4222-8222-222222222222'
const MODELLO = '33333333-3333-4333-8333-333333333333'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  tabelle: [] as string[],
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireStaff: h.requireStaff,
  requireUser: h.requireStaff,
}))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return {
    createAdminClient: async () => creaFintoSupabase(h.db, h.tabelle),
    createClient: async () => creaFintoSupabase(h.db, h.tabelle),
  }
})

import { GET as SUBMISSIONS } from '@/app/api/admin/forms/submissions/route'
import { GET as RANKINGS } from '@/app/api/admin/forms/rankings/route'

const req = (url: string) => new NextRequest(`http://localhost${url}`)

const dbBase = (): DBFinto => ({
  utenti_scuole: [],
  form_submissions: [
    {
      id: SUB_A, model_id: MODELLO, user_id: null, scuola_id: SEDE_A,
      status: 'completed', score: 10, created_at: '2026-07-30T10:00:00Z',
      data: { nome: 'FAMIGLIA-SEDE-A' },
      form_model: { id: MODELLO, title: 'Iscrizione' },
    },
    {
      id: SUB_B, model_id: MODELLO, user_id: null, scuola_id: SEDE_B,
      status: 'completed', score: 20, created_at: '2026-07-30T11:00:00Z',
      data: { nome: 'FAMIGLIA-SEDE-B' },
      form_model: { id: MODELLO, title: 'Iscrizione' },
    },
  ],
  form_models: [{ id: MODELLO, title: 'Iscrizione', scuola_id: null }],
})

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.requireStaff.mockResolvedValue({ user: { id: 'seg1', role: 'segreteria', scuola_id: SEDE_A } })
})

describe('GET /api/admin/forms/submissions — elenco compilazioni', () => {
  it('nessuna compilazione delle famiglie dell\'altra sede', async () => {
    const res = await SUBMISSIONS(req('/api/admin/forms/submissions'))
    expect(res.status).toBe(200)
    const corpo = await res.text()
    expect(corpo).toContain('FAMIGLIA-SEDE-A')
    expect(corpo).not.toContain('FAMIGLIA-SEDE-B')
  })

  it('scope vuoto: elenco vuoto, non elenco completo', async () => {
    h.requireStaff.mockResolvedValue({ user: { id: 'orfano', role: 'segreteria', scuola_id: null } })
    const res = await SUBMISSIONS(req('/api/admin/forms/submissions'))
    expect(res.status).toBe(200)
    expect(await res.text()).not.toContain('FAMIGLIA-SEDE-A')
  })
})

describe('GET /api/admin/forms/rankings — graduatorie', () => {
  it('la graduatoria non mescola le famiglie delle due sedi', async () => {
    const res = await RANKINGS(req('/api/admin/forms/rankings'))
    expect(res.status).toBe(200)
    const corpo = await res.text()
    expect(corpo).toContain('FAMIGLIA-SEDE-A')
    // Il punteggio più alto è quello dell'altra sede: senza filtro sarebbe in
    // cima alla graduatoria di questa segreteria.
    expect(corpo).not.toContain('FAMIGLIA-SEDE-B')
  })
})
