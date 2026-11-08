import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import type { DBFinto } from '../fixtures/finto-supabase'

/**
 * Un docente con la sezione di un anno passato (sola lettura): la lettura dello scrutinio
 * passa (200), la scrittura no (403 `SEZIONE_SOLA_LETTURA`). Il gate è quello VERO
 * (`assertSezioneScrivibile`), non un mock: cambia solo l'esito della funzione SQL.
 */

const DOCENTE = '33333333-3333-4333-8333-333333333333'
const SEDE = '22222222-2222-4222-8222-222222222222'
const S_PASSATA = '55555555-5555-4555-8555-555555555551'
const SCRUTINIO = 'a0000000-0000-4000-8000-000000000001'
const ALUNNO = 'c0000000-0000-4000-8000-000000000003'
const MATERIA = 'd0000000-0000-4000-8000-000000000004'

const h = vi.hoisted(() => ({ db: {} as unknown, requireDocente: vi.fn() }))

vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase: crea } = await import('../fixtures/finto-supabase')
  return {
    createAdminClient: async () =>
      crea(h.db as DBFinto, [], {
        rpc: {
          sezioni_visibili_docente: () => ({ data: [{ section_id: S_PASSATA, sola_lettura: true }], error: null }),
        } as never,
      }),
  }
})
vi.mock('@/lib/auth/require-staff', () => ({ requireDocente: h.requireDocente }))

import { GET, POST } from '@/app/api/primaria/scrutinio/route'

beforeEach(() => {
  h.db = {
    utenti: [{ id: DOCENTE, scuola_id: SEDE, scuole_ids: [SEDE], role: 'educator' }],
    utenti_sezioni: [{ utente_id: DOCENTE, section_id: S_PASSATA }],
    sections: [{ id: S_PASSATA, name: 'Girasoli', school_type: 'primaria', scuola_id: SEDE }],
    scrutini: [{ id: SCRUTINIO, section_id: S_PASSATA, stato: 'aperto' }],
    scrutinio_periodi: [],
  }
  h.requireDocente.mockResolvedValue({
    user: { id: DOCENTE, role: 'educator', scuola_id: SEDE, scuole_ids: [SEDE] },
  })
})

describe('/api/primaria/scrutinio con la sezione in sola lettura', () => {
  it('GET → 200', async () => {
    const res = await GET(new NextRequest(`http://localhost/api/primaria/scrutinio?sectionId=${S_PASSATA}`))
    expect(res.status).toBe(200)
  })

  it('POST → 403 SEZIONE_SOLA_LETTURA', async () => {
    const res = await POST(new NextRequest('http://localhost/api/primaria/scrutinio', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scrutinioId: SCRUTINIO, giudizi: [{ alunnoId: ALUNNO, materiaId: MATERIA, giudizioSintetico: 'Buono' }] }),
    }))
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ codice: 'SEZIONE_SOLA_LETTURA' })
  })
})
