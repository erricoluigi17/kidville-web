import { it, expect, vi, beforeEach, describe } from 'vitest'

// =============================================================================
// E1.5 — storno di un movimento cassa (test PRIMA dell'implementazione).
//  · 400 motivo < 3 · 404 inesistente
//  · 409 già stornato / è esso stesso uno storno / movimento di chiusura /
//    entrata auto
//  · 200 → contro-movimento (stesso tipo, importo negato, metodo, storno_di) +
//    marca l'originale (stornato_il/storno_motivo)
//  · il MOTIVO non finisce MAI nei log
// =============================================================================

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  verificaSoglia: vi.fn(),
  orig: null as Record<string, unknown> | null,
  inserts: [] as { table: string; row: Record<string, unknown> }[],
  updates: [] as { table: string; row: Record<string, unknown> }[],
  logCalls: [] as unknown[][],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/cassa/notifiche', () => ({ verificaSogliaCassa: (...a: unknown[]) => h.verificaSoglia(...a) }))
vi.mock('@/lib/logging/logger', () => ({
  logOk: (...a: unknown[]) => h.logCalls.push(a),
  logErrore: (...a: unknown[]) => h.logCalls.push(a),
  logEvento: (...a: unknown[]) => h.logCalls.push(a),
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = () => b
      b.maybeSingle = async () => (table === 'cassa_movimenti' ? { data: h.orig, error: null } : { data: null, error: null })
      b.single = async () => ({ data: { id: 'contro-1' }, error: null })
      b.insert = (row: Record<string, unknown>) => {
        h.inserts.push({ table, row })
        return b
      }
      b.update = (row: Record<string, unknown>) => {
        h.updates.push({ table, row })
        return b
      }
      b.then = (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null })
      return b
    },
  }),
}))

import { POST } from '@/app/api/pagamenti/cassa/movimenti/storno/route'

const MOV = '22222222-2222-4222-8222-222222222222'
const SEDE = 'd53b0fbc-a9eb-4073-b302-73d1d5abd529'
const MOTIVO = 'errore di conteggio'

const post = (body: unknown) =>
  new Request('http://localhost/api/pagamenti/cassa/movimenti/storno', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-user-id': 'seg-1' },
    body: JSON.stringify(body),
  })

beforeEach(() => {
  vi.clearAllMocks()
  h.requireStaff.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: SEDE } })
  h.verificaSoglia.mockResolvedValue(undefined)
  h.orig = { id: MOV, scuola_id: SEDE, tipo: 'uscita', importo: 20, metodo: 'contanti', stornato_il: null, storno_di: null, chiusura_id: null, incasso_id: null, categoria_id: null }
  h.inserts = []
  h.updates = []
  h.logCalls = []
})

describe('POST /api/pagamenti/cassa/movimenti/storno', () => {
  it('motivo troppo corto → 400', async () => {
    const res = await POST(post({ movimento_id: MOV, motivo: 'x' }))
    expect(res.status).toBe(400)
  })

  it('movimento inesistente → 404', async () => {
    h.orig = null
    const res = await POST(post({ movimento_id: MOV, motivo: MOTIVO }))
    expect(res.status).toBe(404)
  })

  it('già stornato → 409', async () => {
    h.orig = { ...(h.orig as Record<string, unknown>), stornato_il: '2026-07-20T10:00:00Z' }
    const res = await POST(post({ movimento_id: MOV, motivo: MOTIVO }))
    expect(res.status).toBe(409)
  })

  it('è esso stesso uno storno → 409', async () => {
    h.orig = { ...(h.orig as Record<string, unknown>), storno_di: 'altro-mov' }
    const res = await POST(post({ movimento_id: MOV, motivo: MOTIVO }))
    expect(res.status).toBe(409)
  })

  it('movimento di chiusura (chiusura_id valorizzato) → 409', async () => {
    h.orig = { ...(h.orig as Record<string, unknown>), chiusura_id: 'chius-1' }
    const res = await POST(post({ movimento_id: MOV, motivo: MOTIVO }))
    expect(res.status).toBe(409)
  })

  it('entrata auto (incasso_id valorizzato) → 409', async () => {
    h.orig = { ...(h.orig as Record<string, unknown>), incasso_id: 'inc-1' }
    const res = await POST(post({ movimento_id: MOV, motivo: MOTIVO }))
    expect(res.status).toBe(409)
  })

  it('storno valido → 200, contro-movimento con stesso tipo/metodo e importo negato', async () => {
    const res = await POST(post({ movimento_id: MOV, motivo: MOTIVO }))
    expect(res.status).toBe(200)
    const contro = h.inserts.find((i) => i.table === 'cassa_movimenti')!.row
    expect(contro.tipo).toBe('uscita')
    expect(Number(contro.importo)).toBe(-20)
    expect(contro.metodo).toBe('contanti')
    expect(contro.storno_di).toBe(MOV)
    // Marca l'originale.
    const marca = h.updates.find((u) => u.table === 'cassa_movimenti')!.row
    expect(marca.storno_motivo).toBe(MOTIVO)
    expect(marca.stornato_il).toBeTruthy()
    const body = await res.json()
    expect(body.contro_movimento_id).toBe('contro-1')
  })

  it('il MOTIVO non finisce mai nei log', async () => {
    await POST(post({ movimento_id: MOV, motivo: MOTIVO }))
    expect(JSON.stringify(h.logCalls)).not.toContain(MOTIVO)
  })
})
