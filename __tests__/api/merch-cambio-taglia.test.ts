import { it, expect, vi, beforeEach, describe } from 'vitest'
import { NextResponse } from 'next/server'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  logScrittura: vi.fn(),
  scuoleDiUtente: vi.fn(),
  singleFor: {} as Record<string, Record<string, unknown> | null>,
  rowsFor: {} as Record<string, Record<string, unknown>[]>,
  inserts: [] as { table: string; row: unknown }[],
  updates: [] as { table: string; row: unknown }[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@/lib/auth/scope', () => ({ scuoleDiUtente: (...a: unknown[]) => h.scuoleDiUtente(...a) }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: (table: string) => {
      const b: Record<string, unknown> & { _last?: Record<string, unknown>; _op?: string } = {}
      b.select = () => b
      b.eq = () => b
      b.in = () => b
      b.order = () => b
      b.limit = () => b
      b.maybeSingle = async () => ({ data: h.singleFor[table] ?? null, error: null })
      b.single = async () => ({ data: b._last ?? { id: `${table}-x` }, error: null })
      b.insert = (row: unknown) => { h.inserts.push({ table, row }); b._op = 'insert'; b._last = { id: `${table}-new`, ...(Array.isArray(row) ? {} : (row as object)) }; return b }
      b.update = (row: unknown) => { h.updates.push({ table, row }); b._op = 'update'; return b }
      b.then = (resolve: (v: unknown) => unknown) => resolve(b._op ? { data: null, error: null } : { data: h.rowsFor[table] ?? [], error: null })
      return b
    },
  }),
}))

import { POST } from '@/app/api/admin/merch/cambio-taglia/route'

const URL = 'http://localhost/api/admin/merch/cambio-taglia'
const post = (body: unknown) => new Request(URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const R1 = '11111111-1111-4111-8111-111111111111'
const ART = '22222222-2222-4222-8222-222222222222'

beforeEach(() => {
  vi.clearAllMocks()
  h.requireStaff.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: 'sc-1' } })
  h.scuoleDiUtente.mockResolvedValue(['sc-1'])
  h.singleFor = {
    divise_ordini_righe: { id: R1, stato: 'consegnato', articolo_id: ART, articolo_nome: 'Polo', taglia: 'M', quantita: 1, ordine_id: 'o1', ordine: { scuola_id: 'sc-1' } },
    divise_articoli: { taglie: ['S', 'M', 'L'] },
  }
  h.rowsFor = { divise_ordini_righe: [{ stato: 'da_ordinare' }] }
  h.inserts = []; h.updates = []
})

describe('POST /api/admin/merch/cambio-taglia', () => {
  it('403 senza staff', async () => {
    h.requireStaff.mockResolvedValue({ response: NextResponse.json({}, { status: 403 }) })
    expect((await POST(post({ riga_id: R1, nuova_taglia: 'L' }))).status).toBe(403)
  })
  it('400 taglia uguale a quella attuale', async () => {
    expect((await POST(post({ riga_id: R1, nuova_taglia: 'M' }))).status).toBe(400)
  })
  it('400 taglia non nel catalogo', async () => {
    expect((await POST(post({ riga_id: R1, nuova_taglia: 'XXL' }))).status).toBe(400)
  })
  it('403 riga fuori dal plesso', async () => {
    ;(h.singleFor.divise_ordini_righe!.ordine as { scuola_id: string }).scuola_id = 'sc-ALTRO'
    expect((await POST(post({ riga_id: R1, nuova_taglia: 'L' }))).status).toBe(403)
  })
  it('201 (consegnato) crea la nuova riga (prezzo 0, da_ordinare); senza reso nessuna rettifica e originale non annullata', async () => {
    const res = await POST(post({ riga_id: R1, nuova_taglia: 'L' }))
    expect(res.status).toBe(201)
    const nuova = h.inserts.find((i) => i.table === 'divise_ordini_righe')!.row as { taglia: string; prezzo_unitario: number; stato: string; quantita: number }
    expect(nuova).toMatchObject({ taglia: 'L', prezzo_unitario: 0, stato: 'da_ordinare', quantita: 1 })
    expect(h.inserts.find((i) => i.table === 'merch_rettifiche')).toBeUndefined()
    // consegnato = terminale → la riga originale NON viene annullata
    expect(h.updates.find((u) => u.table === 'divise_ordini_righe')).toBeUndefined()
  })
  it('201 (consegnato) con reso_a_stock crea la rettifica +qty sulla taglia originale', async () => {
    const res = await POST(post({ riga_id: R1, nuova_taglia: 'L', reso_a_stock: true }))
    expect(res.status).toBe(201)
    const rett = h.inserts.find((i) => i.table === 'merch_rettifiche')!.row as { taglia: string; quantita_delta: number; motivo: string }
    expect(rett).toMatchObject({ taglia: 'M', quantita_delta: 1, motivo: 'reso' })
    expect((await res.json()).data.reso).toBe(true)
  })
  it('201 PRE-consegna: annulla la riga originale e IGNORA reso_a_stock (niente stock fantasma)', async () => {
    h.singleFor.divise_ordini_righe!.stato = 'ordinato'
    const res = await POST(post({ riga_id: R1, nuova_taglia: 'L', reso_a_stock: true }))
    expect(res.status).toBe(201)
    // nessuna rettifica: il capo non era mai stato consegnato
    expect(h.inserts.find((i) => i.table === 'merch_rettifiche')).toBeUndefined()
    // la riga originale (taglia sbagliata) viene annullata → nessun doppione attivo
    const upd = h.updates.find((u) => u.table === 'divise_ordini_righe')!.row as { stato: string }
    expect(upd.stato).toBe('annullato')
    const j = await res.json()
    expect(j.data.reso).toBe(false)
    expect(j.data.annullata_originale).toBe(true)
  })
})
