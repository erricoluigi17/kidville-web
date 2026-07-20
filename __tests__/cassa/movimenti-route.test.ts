import { it, expect, vi, beforeEach, describe } from 'vitest'

// =============================================================================
// E1.4 — API movimenti cassa (test PRIMA dell'implementazione).
//  · gate staff (401 senza identità)
//  · POST uscita senza categoria → 400; POST tipo 'prelievo' → 400
//  · GET con schema assente (42P01) → 200 { disponibile:false }
//  · TRAPPOLA #5: GET come segreteria NON espone la chiave `totali`; admin sì
//  · POST valido → 201, insert con registrato_da = user.id
// =============================================================================

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  resolveScuoleAttive: vi.fn(),
  resolveScuolaScrittura: vi.fn(),
  notificaUscita: vi.fn(),
  verificaSoglia: vi.fn(),
  movimentiResp: { data: [], error: null } as { data: unknown; error: unknown },
  incassiResp: { data: [], error: null } as { data: unknown; error: unknown },
  auditResp: { data: null, error: null } as { data: unknown; error: unknown },
  inserts: [] as { table: string; row: unknown }[],
  logCalls: [] as unknown[][],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/logging/logger', () => ({
  logOk: (...a: unknown[]) => h.logCalls.push(a),
  logErrore: (...a: unknown[]) => h.logCalls.push(a),
  logEvento: (...a: unknown[]) => h.logCalls.push(a),
}))
vi.mock('@/lib/auth/scope', () => ({
  resolveScuoleAttive: h.resolveScuoleAttive,
  resolveScuolaScrittura: h.resolveScuolaScrittura,
}))
vi.mock('@/lib/cassa/notifiche', () => ({
  notificaUscitaNonAdmin: (...a: unknown[]) => h.notificaUscita(...a),
  verificaSogliaCassa: (...a: unknown[]) => h.verificaSoglia(...a),
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from(table: string) {
      const b: Record<string, unknown> & { _insert?: unknown } = {}
      b.select = () => b
      b.eq = () => b
      b.is = () => b
      b.in = () => b
      b.gte = () => b
      b.lte = () => b
      b.order = () => b
      b.insert = (row: unknown) => {
        h.inserts.push({ table, row })
        b._insert = row
        return b
      }
      b.single = async () =>
        table === 'cassa_movimenti'
          ? { data: { id: 'mov-1', ...(b._insert as Record<string, unknown>) }, error: null }
          : { data: { id: `${table}-1` }, error: null }
      b.maybeSingle = async () => ({ data: null, error: null })
      b.then = (resolve: (v: unknown) => unknown) => {
        if (table === 'cassa_movimenti') return resolve(h.movimentiResp)
        if (table === 'incassi') return resolve(h.incassiResp)
        if (table === 'registro_modifiche') return resolve(h.auditResp)
        return resolve({ data: [], error: null })
      }
      return b
    },
  }),
}))

import { GET, POST } from '@/app/api/pagamenti/cassa/movimenti/route'

const SEDE = 'd53b0fbc-a9eb-4073-b302-73d1d5abd529'

const getReq = (qs = `scuola_id=${SEDE}`) =>
  new Request(`http://localhost/api/pagamenti/cassa/movimenti?${qs}`, {
    headers: { 'x-user-id': 'u1' },
  })
const postReq = (body: unknown) =>
  new Request('http://localhost/api/pagamenti/cassa/movimenti', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-user-id': 'u1' },
    body: JSON.stringify(body),
  })

beforeEach(() => {
  vi.clearAllMocks()
  h.requireStaff.mockResolvedValue({ user: { id: 'admin-1', role: 'admin', scuola_id: SEDE } })
  h.resolveScuoleAttive.mockResolvedValue([SEDE])
  h.resolveScuolaScrittura.mockResolvedValue({ scuolaId: SEDE })
  h.notificaUscita.mockResolvedValue(undefined)
  h.verificaSoglia.mockResolvedValue(undefined)
  h.movimentiResp = { data: [], error: null }
  h.incassiResp = { data: [], error: null }
  h.auditResp = { data: null, error: null }
  h.inserts = []
  h.logCalls = []
})

describe('GET /api/pagamenti/cassa/movimenti', () => {
  it('401 senza identità (gate staff)', async () => {
    h.requireStaff.mockResolvedValue({ response: new Response('no', { status: 401 }) })
    const res = await GET(getReq())
    expect(res.status).toBe(401)
  })

  it('schema cassa assente (42P01) → 200 { disponibile:false }', async () => {
    h.movimentiResp = { data: null, error: { code: '42P01' } }
    const res = await GET(getReq())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.disponibile).toBe(false)
  })

  it('come SEGRETERIA la risposta NON contiene la chiave `totali` (trappola #5)', async () => {
    h.requireStaff.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: SEDE } })
    const res = await GET(getReq())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.disponibile).toBe(true)
    expect(body).not.toHaveProperty('totali')
  })

  it('come ADMIN la risposta contiene `totali`', async () => {
    h.movimentiResp = { data: [{ id: 'm1', tipo: 'uscita', importo: 20, metodo: 'contanti', data: '2026-07-20', categoria_id: null, descrizione: null, note: null, allegato_path: null, incasso_id: null, chiusura_id: null, registrato_da: 'admin-1', creato_il: '2026-07-20T10:00:00Z', storno_di: null, stornato_il: null, storno_motivo: null }], error: null }
    const res = await GET(getReq())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.disponibile).toBe(true)
    expect(body).toHaveProperty('totali')
    expect(body.totali.uscite_contanti).toBe(20)
  })
})

describe('POST /api/pagamenti/cassa/movimenti', () => {
  it('uscita senza categoria_id → 400', async () => {
    const res = await POST(postReq({ scuola_id: SEDE, tipo: 'uscita', importo: 20, metodo: 'contanti' }))
    expect(res.status).toBe(400)
  })

  it("tipo 'prelievo' non è ammesso via API → 400 (lo genera solo la chiusura)", async () => {
    const res = await POST(postReq({ scuola_id: SEDE, tipo: 'prelievo', importo: 20, metodo: 'contanti' }))
    expect(res.status).toBe(400)
  })

  it('importo ≤ 0 → 400', async () => {
    const res = await POST(postReq({ scuola_id: SEDE, tipo: 'entrata', importo: 0, metodo: 'contanti' }))
    expect(res.status).toBe(400)
  })

  it('RC1 — campi facoltativi a null (contratto del client) → 201', async () => {
    // Il modale invia `descrizione/note/allegato_path/categoria_id/data = valore || null`.
    // Lo schema deve accettarli a null (nullish), non solo a undefined.
    const res = await POST(
      postReq({
        scuola_id: SEDE,
        tipo: 'entrata',
        importo: 5,
        metodo: 'contanti',
        data: null,
        categoria_id: null,
        descrizione: null,
        note: null,
        allegato_path: null,
      }),
    )
    expect(res.status).toBe(201)
    const ins = h.inserts.find((i) => i.table === 'cassa_movimenti')!.row as Record<string, unknown>
    // I null diventano null (o undefined per la data) nell'INSERT, mai la stringa "null".
    expect(ins.descrizione).toBeNull()
    expect(ins.note).toBeNull()
    expect(ins.allegato_path).toBeNull()
    expect(ins.categoria_id).toBeNull()
  })

  it('entrata manuale valida → 201, insert con registrato_da = user.id', async () => {
    const res = await POST(postReq({ scuola_id: SEDE, tipo: 'entrata', importo: 10, metodo: 'contanti' }))
    expect(res.status).toBe(201)
    const ins = h.inserts.find((i) => i.table === 'cassa_movimenti')!.row as Record<string, unknown>
    expect(ins.registrato_da).toBe('admin-1')
    expect(ins.tipo).toBe('entrata')
    expect(Number(ins.importo)).toBe(10)
    expect(ins.scuola_id).toBe(SEDE)
  })

  it("uscita da SEGRETERIA → notifica gli admin (notificaUscitaNonAdmin)", async () => {
    h.requireStaff.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: SEDE } })
    const catId = '11111111-1111-4111-8111-111111111111'
    const res = await POST(postReq({ scuola_id: SEDE, tipo: 'uscita', importo: 15, metodo: 'contanti', categoria_id: catId }))
    expect(res.status).toBe(201)
    expect(h.notificaUscita).toHaveBeenCalledTimes(1)
  })

  it('uscita da ADMIN → NON notifica (è l\'admin stesso)', async () => {
    const catId = '11111111-1111-4111-8111-111111111111'
    const res = await POST(postReq({ scuola_id: SEDE, tipo: 'uscita', importo: 15, metodo: 'contanti', categoria_id: catId }))
    expect(res.status).toBe(201)
    expect(h.notificaUscita).not.toHaveBeenCalled()
  })

  it('RC3 — audit del movimento fallito (errore reale) → warn «audit-non-scritto», 201', async () => {
    h.auditResp = { data: null, error: { code: '23505', message: 'boom' } }
    const res = await POST(postReq({ scuola_id: SEDE, tipo: 'entrata', importo: 10, metodo: 'contanti' }))
    expect(res.status).toBe(201)
    const warn = h.logCalls.find(
      (c) => c[1] === 'warn' && (c[2] as { esito?: string } | undefined)?.esito === 'audit-non-scritto',
    )
    expect(warn).toBeTruthy()
  })
})
