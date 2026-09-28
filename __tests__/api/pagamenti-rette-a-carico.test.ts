import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import type { DBFinto, ErrorePostgrest } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B, SEDE_C, NOME_SEDE_A, NOME_SEDE_B } from '../fixtures/sedi'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  db: {} as DBFinto,
  errori: {} as Record<string, ErrorePostgrest>,
  logEvento: vi.fn(),
}))
vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/logging/logger', async (importActual) => {
  const vero = await importActual<typeof import('@/lib/logging/logger')>()
  h.logEvento.mockImplementation(vero.logEvento)
  return { ...vero, logEvento: h.logEvento }
})
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return { createAdminClient: async () => creaFintoSupabase(h.db, [], { errori: h.errori }) }
})

import { GET } from '@/app/api/pagamenti/rette-a-carico/route'

const req = (qs = '') => new NextRequest(`http://localhost/api/pagamenti/rette-a-carico${qs ? `?${qs}` : ''}`)
const ADMIN_AB = { id: 'admin-1', role: 'admin', scuola_id: SEDE_A }

const alunno = (id: string, sede: string, extra: Record<string, unknown> = {}) => ({
  id, nome: `N-${id}`, cognome: `C-${id}`, classe_sezione: `Sez-${id}`, section_id: null,
  scuola_id: sede, stato: 'iscritto', gender: 'M', archiviato_il: null, retta_a_carico_di: null, ...extra,
})

beforeEach(() => {
  vi.clearAllMocks()
  h.errori = {}
  h.db = {
    schools: [{ id: SEDE_A, nome: NOME_SEDE_A }, { id: SEDE_B, nome: NOME_SEDE_B }, { id: SEDE_C, nome: 'Terza' }],
    scuole: [{ id: SEDE_A, attiva: true }, { id: SEDE_B, attiva: true }, { id: SEDE_C, attiva: true }],
    utenti_scuole: [{ utente_id: 'admin-1', scuola_id: SEDE_A }, { utente_id: 'admin-1', scuola_id: SEDE_B }],
    alunni: [
      alunno('pa', SEDE_A), alunno('fa', SEDE_A, { retta_a_carico_di: 'pa' }),
      alunno('pb', SEDE_B, { gender: 'F' }), alunno('fb', SEDE_B, { retta_a_carico_di: 'pb' }),
      alunno('pc', SEDE_C), alunno('fc', SEDE_C, { retta_a_carico_di: 'pc' }),     // sede non accessibile
      alunno('fr', SEDE_A, { retta_a_carico_di: 'pa', stato: 'ritirato' }),        // non iscritto
    ],
  }
  h.requireStaff.mockResolvedValue({ user: ADMIN_AB })
})

describe('GET /api/pagamenti/rette-a-carico', () => {
  it('i legami delle sedi accessibili, con il solo pagante (niente dati del bambino)', async () => {
    const res = await GET(req())
    expect(res.status).toBe(200)
    const corpo = await res.json()
    expect(corpo.success).toBe(true)
    const ids = (corpo.data as { alunno_id: string }[]).map((l) => l.alunno_id).sort()
    expect(ids).toEqual(['fa', 'fb'])
    const fb = corpo.data.find((l: { alunno_id: string }) => l.alunno_id === 'fb')
    expect(fb).toEqual({
      alunno_id: 'fb', scuola_id: SEDE_B,
      pagante: { id: 'pb', nome: 'N-pb', cognome: 'C-pb', sesso: 'F', classe_sezione: 'Sez-pb', iscritto: true, scuola_id: SEDE_B },
    })
    expect(JSON.stringify(corpo)).not.toContain('N-fb')
  })

  it('scuola_id restringe a quella sede', async () => {
    const corpo = await (await GET(req(`scuola_id=${SEDE_A}`))).json()
    expect(corpo.data.map((l: { alunno_id: string }) => l.alunno_id)).toEqual(['fa'])
  })

  it('scuola_id di una sede non accessibile: 403, mai «nessun legame»', async () => {
    const res = await GET(req(`scuola_id=${SEDE_C}`))
    expect(res.status).toBe(403)
    expect((await res.json()).codice).toBe('SEDE_NON_ACCESSIBILE')
  })

  it('scuola_id non uuid: 400', async () => {
    expect((await GET(req('scuola_id=abc'))).status).toBe(400)
  })

  it('senza staff: la risposta del gate, tale e quale', async () => {
    h.requireStaff.mockResolvedValue({ response: NextResponse.json({ error: 'no' }, { status: 401 }) })
    expect((await GET(req())).status).toBe(401)
  })

  it('DB non migrato (42703): 200 con zero legami', async () => {
    h.errori = { 'alunni:select': { code: '42703', message: 'column alunni.retta_a_carico_di does not exist' } }
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual([])
  })

  it('guasto di lettura: 500 con LETTURA_FALLITA, e il log dice perché', async () => {
    h.errori = { 'alunni:select': { code: '57014' } }
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('LETTURA_FALLITA')
    expect(h.logEvento).toHaveBeenCalledWith('pagamento', 'error', expect.objectContaining({ operazione: 'pagamenti/rette-a-carico:GET', esito: 'legami-bambini-non-letti' }), expect.anything())
  })
})
