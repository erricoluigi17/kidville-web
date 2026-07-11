import { it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

// POST /api/admin/merch/ordini — la segreteria crea un ordine per un alunno.
const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  logScrittura: vi.fn(),
  scuoleDiUtente: vi.fn(),
  assertAlunnoInScope: vi.fn(),
  alunno: null as Record<string, unknown> | null,
  articoli: [] as Record<string, unknown>[],
  cats: [] as Record<string, unknown>[],
  inserts: [] as { table: string; row: unknown }[],
  updates: [] as { table: string; row: unknown }[],
  insertErr: {} as Record<string, { code: string } | undefined>,
  ordineEsistente: null as Record<string, unknown> | null,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@/lib/auth/scope', () => ({
  scuoleDiUtente: (...a: unknown[]) => h.scuoleDiUtente(...a),
  assertAlunnoInScope: (...a: unknown[]) => h.assertAlunnoInScope(...a),
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: (table: string) => {
      const b: Record<string, unknown> & { _last?: Record<string, unknown>; _op?: string } = {}
      b.select = () => b
      b.eq = () => b
      b.in = () => b
      b.or = () => b
      b.order = () => b
      b.limit = () => b
      b.maybeSingle = async () => ({ data: table === 'alunni' ? h.alunno : table === 'divise_ordini' ? h.ordineEsistente : null, error: null })
      b.single = async () => (h.insertErr[table] ? { data: null, error: h.insertErr[table] } : { data: b._last ?? { id: `${table}-x` }, error: null })
      b.insert = (row: unknown) => { h.inserts.push({ table, row }); b._op = 'insert'; b._last = { id: `${table}-new`, ...(Array.isArray(row) ? {} : (row as object)) }; return b }
      b.update = (row: unknown) => { h.updates.push({ table, row }); b._op = 'update'; return b }
      b.delete = () => { b._op = 'delete'; return b }
      b.then = (resolve: (v: unknown) => unknown) => {
        if (b._op) return resolve({ data: null, error: null })
        const data =
          table === 'divise_articoli' ? h.articoli :
          table === 'payment_categories' ? h.cats : []
        return resolve({ data, error: null })
      }
      return b
    },
  }),
}))

import { POST } from '@/app/api/admin/merch/ordini/route'

const URL = 'http://localhost/api/admin/merch/ordini'
const post = (body: unknown) =>
  new Request(URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const AID = '11111111-1111-4111-8111-111111111111'
const ART = '22222222-2222-4222-8222-222222222222'
const ART2 = '44444444-4444-4444-8444-444444444444'

beforeEach(() => {
  vi.clearAllMocks()
  h.requireStaff.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: 'sc-1' } })
  h.scuoleDiUtente.mockResolvedValue(['sc-1'])
  h.assertAlunnoInScope.mockResolvedValue(null)
  h.alunno = { scuola_id: 'sc-1' }
  h.articoli = [
    { id: ART, nome: 'Polo', prezzo: 18, taglie: ['S', 'M', 'L'], attivo: true, scuola_id: 'sc-1' },
    { id: ART2, nome: 'Cappellino', prezzo: 8, taglie: [], attivo: true, scuola_id: 'sc-1' },
  ]
  h.cats = [{ id: 'cat-divisa', scuola_id: null }]
  h.inserts = []; h.updates = []
  h.insertErr = {}; h.ordineEsistente = null
})

it('403 alunno fuori scope', async () => {
  h.assertAlunnoInScope.mockResolvedValue(NextResponse.json({ error: 'x' }, { status: 403 }))
  expect((await POST(post({ alunno_id: AID, righe: [{ articolo_id: ART, taglia: 'M', quantita: 1 }] }))).status).toBe(403)
})

it('400 carrello vuoto', async () => {
  expect((await POST(post({ alunno_id: AID, righe: [] }))).status).toBe(400)
})

it('400 articolo di un\'altra scuola', async () => {
  h.articoli = [{ id: ART, nome: 'Polo', prezzo: 18, taglie: ['M'], attivo: true, scuola_id: 'sc-ALTRA' }]
  expect((await POST(post({ alunno_id: AID, righe: [{ articolo_id: ART, taglia: 'M', quantita: 1 }] }))).status).toBe(400)
})

it('400 taglia non valida quando l\'articolo HA taglie', async () => {
  expect((await POST(post({ alunno_id: AID, righe: [{ articolo_id: ART, taglia: 'XXL', quantita: 1 }] }))).status).toBe(400)
})

it('201 articolo SENZA taglie accetta taglia vuota (fix bug latente)', async () => {
  const res = await POST(post({ alunno_id: AID, righe: [{ articolo_id: ART2, quantita: 3 }] }))
  expect(res.status).toBe(201)
  const righe = h.inserts.find((i) => i.table === 'divise_ordini_righe')!.row as { taglia: string; articolo_nome: string }[]
  expect(righe[0]).toMatchObject({ taglia: '', articolo_nome: 'Cappellino' })
})

it('201 prezzi/totale SERVER-SIDE, parent_id NULL, righe con stato da_ordinare', async () => {
  const res = await POST(post({ alunno_id: AID, importo: 1, righe: [{ articolo_id: ART, taglia: 'M', quantita: 2, prezzo: 1 }] }))
  expect(res.status).toBe(201)
  const ordine = h.inserts.find((i) => i.table === 'divise_ordini')!.row as { totale: number; parent_id: unknown; stato: string }
  expect(ordine.totale).toBe(36) // 18 × 2, ignora prezzo del client
  expect(ordine.parent_id).toBeNull()
  expect(ordine.stato).toBe('inviato') // tutte le righe da_ordinare
  const righe = h.inserts.find((i) => i.table === 'divise_ordini_righe')!.row as { prezzo_unitario: number; stato: string; origine: string }[]
  expect(righe[0]).toMatchObject({ prezzo_unitario: 18, quantita: 2, stato: 'da_ordinare', origine: 'fornitore' })
})

it('201 crea pagamento categoria divisa/da_pagare con descrizione "Merchandise:" e collega l\'ordine', async () => {
  const res = await POST(post({ alunno_id: AID, righe: [{ articolo_id: ART, taglia: 'M', quantita: 2 }] }))
  expect(res.status).toBe(201)
  const pag = h.inserts.find((i) => i.table === 'pagamenti')!.row as Record<string, unknown>
  expect(pag).toMatchObject({
    alunno_id: AID, scuola_id: 'sc-1', importo: 36, categoria_id: 'cat-divisa',
    tipo: 'singolo', obbligatorio: false, stato: 'da_pagare', creato_da: 'seg-1',
  })
  expect(String(pag.descrizione)).toContain('Merchandise:')
  const link = h.updates.find((u) => u.table === 'divise_ordini')!.row as { pagamento_id: string }
  expect(link.pagamento_id).toBe('pagamenti-new')
})

it('idempotenza: stessa chiave (23505) → ritorna l\'ordine esistente senza duplicare l\'addebito (200)', async () => {
  h.insertErr.divise_ordini = { code: '23505' }
  h.ordineEsistente = { id: 'ord-gia', pagamento_id: 'pag-gia', totale: 36 }
  const res = await POST(post({ alunno_id: AID, righe: [{ articolo_id: ART, taglia: 'M', quantita: 2 }], idempotency_key: '33333333-3333-4333-8333-333333333333' }))
  expect(res.status).toBe(200)
  const j = await res.json()
  expect(j.data).toMatchObject({ ordine_id: 'ord-gia', pagamento_id: 'pag-gia', idempotente: true })
  expect(h.inserts.find((i) => i.table === 'pagamenti')).toBeUndefined() // niente secondo addebito
})
