import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import type { DBFinto } from '../fixtures/finto-supabase'

/**
 * Agosto, materiali dell'armadietto (`locker/materials` POST, giro 1-bis): un docente con la classe `in_chiusura` non crea
 * materiali per quella classe (403 SEZIONE_IN_CHIUSURA); la segreteria sì; il docente con la classe corrente sì.
 * Il gate è quello VERO (`assertClasseNomeScrivibile`): cambia solo l'esito della funzione SQL `sezioni_visibili_docente`.
 */

const DOCENTE = '33333333-3333-4333-8333-333333333333'
const SEGRETERIA = '44444444-4444-4444-8444-444444444444'
const SEDE = '22222222-2222-4222-8222-222222222222'
const SEZIONE = '55555555-5555-4555-8555-555555555551'

const h = vi.hoisted(() => ({ db: {} as unknown, solaLettura: true, requireDocente: vi.fn() }))

vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase: crea } = await import('../fixtures/finto-supabase')
  return {
    createAdminClient: async () =>
      crea(h.db as DBFinto, [], {
        rpc: {
          sezioni_visibili_docente: () => ({ data: [{ section_id: SEZIONE, sola_lettura: h.solaLettura }], error: null }),
        } as never,
      }),
  }
})
vi.mock('@/lib/auth/require-staff', () => ({ requireDocente: h.requireDocente }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: vi.fn(async () => undefined) }))

import { POST } from '@/app/api/locker/materials/route'

const docente = { id: DOCENTE, role: 'educator', scuola_id: SEDE, scuole_ids: [SEDE] }
const segreteria = { id: SEGRETERIA, role: 'segreteria', scuola_id: SEDE, scuole_ids: [SEDE] }
const nuovo = () =>
  new NextRequest('http://localhost/api/locker/materials', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ classe_sezione: 'Girasoli', nome: 'Pannolini' }),
  })

beforeEach(() => {
  h.solaLettura = true
  h.db = {
    utenti: [{ id: DOCENTE, scuola_id: SEDE, scuole_ids: [SEDE], role: 'educator' }],
    utenti_sezioni: [{ utente_id: DOCENTE, section_id: SEZIONE }],
    sections: [{ id: SEZIONE, name: 'Girasoli', school_type: 'nido', scuola_id: SEDE, anno_id: null }],
    locker_config: [],
  }
})

describe('locker/materials POST in agosto', () => {
  it('educator con la classe in chiusura → 403 (SEZIONE_SOLA_LETTURA: nel finto lo stato dell’anno non si legge)', async () => {
    h.requireDocente.mockResolvedValue({ user: docente })
    const res = await POST(nuovo())
    expect(res.status).toBe(403)
    expect(['SEZIONE_IN_CHIUSURA', 'SEZIONE_SOLA_LETTURA']).toContain((await res.json()).codice)
  })

  it('educator con la classe dell’anno corrente → passa il gate', async () => {
    h.solaLettura = false
    h.requireDocente.mockResolvedValue({ user: docente })
    const res = await POST(nuovo())
    expect(res.status).not.toBe(403)
  })

  it('segreteria → passa il gate', async () => {
    h.requireDocente.mockResolvedValue({ user: segreteria })
    const res = await POST(nuovo())
    expect(res.status).not.toBe(403)
  })
})
