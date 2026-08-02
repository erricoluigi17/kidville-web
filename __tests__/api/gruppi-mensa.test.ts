import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import type { DBFinto, Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A } from '../fixtures/sedi'

// Finto client REALE (filtra e scrive davvero): il builder «a piatto» di prima
// restituiva le stesse righe qualunque filtro ricevesse, quindi non poteva
// distinguere una bulk corretta da una bulk senza scope — ed è esattamente
// quello che il 31/07 ha lasciato passare PATCH/DELETE senza gate di sede.

const ALU_1 = '11111111-1111-4111-8111-aaaaaaaaaaaa'
const ALU_2 = '11111111-1111-4111-8111-aaaaaaaaaaab'
const GM_1 = '44444444-4444-4444-8444-aaaaaaaaaaaa'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  logScrittura: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  tabelle: [] as string[],
  scritture: [] as unknown[],
}))
vi.mock('@/lib/auth/require-staff', async (orig) => ({ ...(await orig() as object), requireStaff: h.requireStaff }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return {
    createAdminClient: async () =>
      creaFintoSupabase(h.db, h.tabelle, { scritture: h.scritture as Scrittura[] }),
  }
})

import { PATCH } from '@/app/api/admin/students/route'
import { GET as GM_GET, POST as GM_POST } from '@/app/api/admin/gruppi-mensa/route'

const denied = () => ({ response: NextResponse.json({ error: 'denied' }, { status: 403 }) }) as never
const patchReq = (body: unknown) =>
  new Request('http://localhost/api/admin/students', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

const riga = (id: string) => h.db.alunni.find((a) => a.id === id)

const dbBase = (): DBFinto => ({
  utenti_scuole: [],
  sections: [{ id: 'sec-1', scuola_id: SEDE_A, name: 'Girasoli' }],
  gruppi_mensa: [{ id: GM_1, scuola_id: SEDE_A, nome: 'Turno 1', attivo: true }],
  alunni: [
    { id: ALU_1, nome: 'Uno', cognome: 'Alfa', scuola_id: SEDE_A, classe_sezione: 'Margherite', gruppo_mensa_id: null },
    { id: ALU_2, nome: 'Due', cognome: 'Beta', scuola_id: SEDE_A, classe_sezione: 'Margherite', gruppo_mensa_id: null },
  ],
})

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.scritture = []
  h.requireStaff.mockResolvedValue({ user: { id: 'seg1', role: 'segreteria', scuola_id: SEDE_A } })
})

describe('PATCH /api/admin/students — bulk gruppo mensa', () => {
  it('assegna il gruppo mensa a tutti gli id e audita per alunno', async () => {
    const res = await PATCH(patchReq({ ids: [ALU_1, ALU_2], gruppo_mensa_id: GM_1 }) as never)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.updated).toBe(2)
    expect(riga(ALU_1)?.gruppo_mensa_id).toBe(GM_1)
    expect(riga(ALU_2)?.gruppo_mensa_id).toBe(GM_1)
    expect(h.logScrittura).toHaveBeenCalledTimes(2)
  })

  it('accetta gruppo_mensa_id null (rimozione dal gruppo)', async () => {
    h.db.alunni[0].gruppo_mensa_id = GM_1
    const res = await PATCH(patchReq({ ids: [ALU_1], gruppo_mensa_id: null }) as never)
    expect(res.status).toBe(200)
    expect(riga(ALU_1)?.gruppo_mensa_id).toBeNull()
  })

  it('la bulk classe_sezione continua a funzionare (regressione)', async () => {
    const res = await PATCH(patchReq({ ids: [ALU_1], classe_sezione: 'Girasoli' }) as never)
    expect(res.status).toBe(200)
    expect(riga(ALU_1)?.classe_sezione).toBe('Girasoli')
  })
})

describe('/api/admin/gruppi-mensa — gate', () => {
  it('GET 403 quando il gate nega', async () => {
    h.requireStaff.mockResolvedValue(denied())
    const res = await GM_GET(new Request('http://localhost/api/admin/gruppi-mensa') as never)
    expect(res.status).toBe(403)
  })

  it('POST crea un gruppo per lo staff', async () => {
    const res = await GM_POST(
      new Request('http://localhost/api/admin/gruppi-mensa', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nome: 'Turno 2', scuola_id: SEDE_A }) }) as never
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.nome).toBe('Turno 2')
    expect(body.data.scuola_id).toBe(SEDE_A)
  })
})
