import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import type { DBFinto } from '../fixtures/finto-supabase'

/**
 * COMPITO 4.5.4-bis · l'elenco dei legami da confermare prima della Piattaforma Unica non porta i genitori di chi non è ancora iscritto.
 *
 * `GET /api/admin/sidi/legami` elenca i legami genitore↔figlio con nome e cognome del minore e il codice fiscale dell'adulto, per la
 * conferma della segreteria. Un bambino «in arrivo» (domanda per l'anno dopo) non è un frequentante: i suoi genitori non sono
 * da confermare per un invio al Ministero. Il finto client non costruisce i join: l'oggetto `alunni` annidato lo mette la fixture,
 * con lo `stato` che PostgREST restituirebbe. Solo uuid e testi finti.
 */

const SEDE = 'a0000000-0000-4000-8000-000000000001'

const h = vi.hoisted(() => ({ db: {} as Record<string, Record<string, unknown>[]> }))
vi.mock('@/lib/auth/require-staff', () => ({
  requireStaff: async () => ({ user: { id: 'seg-1', role: 'segreteria', scuola_id: 'a0000000-0000-4000-8000-000000000001' } }),
}))
vi.mock('@/lib/auth/scope', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth/scope')>()),
  resolveScuoleAttive: async () => ['a0000000-0000-4000-8000-000000000001'],
}))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase: crea } = await import('../fixtures/finto-supabase')
  return { createAdminClient: async () => crea(h.db as DBFinto) }
})

import { GET } from '@/app/api/admin/sidi/legami/route'

const legame = (studente: string, stato: string | null) => ({
  student_id: studente, parent_id: `p-${studente}`, relation_type: 'madre', is_primary: true, validato_sidi: false,
  alunni: { nome: 'N', cognome: studente, scuola_id: SEDE, stato },
  parents: { first_name: 'G', last_name: 'G', fiscal_code: 'CFGENITORE00000' },
})

beforeEach(() => {
  h.db = {
    student_parents: [
      legame('a-frequenta', 'iscritto'),
      legame('b-sospeso', 'sospeso'),
      legame('c-stato-null', null),
      legame('d-in-arrivo', 'in_arrivo'),
    ],
  }
})

describe('GET /api/admin/sidi/legami · il bambino in arrivo', () => {
  it('i genitori di chi non è ancora iscritto non sono da confermare; gli altri restano, stato vuoto compreso', async () => {
    const res = await GET({ url: 'http://localhost/api/admin/sidi/legami', headers: new Headers(), nextUrl: new URL('http://localhost/api/admin/sidi/legami') } as unknown as NextRequest)
    expect(res.status).toBe(200)
    const corpo = (await res.json()) as { data: Array<{ student_id: string; alunni: Record<string, unknown> }> }
    expect(corpo.data.map((r) => r.student_id).sort()).toEqual(['a-frequenta', 'b-sospeso', 'c-stato-null'])
    // lo stato serve al filtro, non alla segreteria: non esce nel corpo
    for (const r of corpo.data) expect(r.alunni).not.toHaveProperty('stato')
  })
})
