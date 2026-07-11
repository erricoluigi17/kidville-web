import { it, expect, vi, beforeEach, describe } from 'vitest'
import { NextResponse } from 'next/server'

// Flusso logistico Merchandise: generazione PO + check-in arrivi.
const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  logScrittura: vi.fn(),
  scuoleDiUtente: vi.fn(),
  enqueue: vi.fn(),
  rowsFor: {} as Record<string, Record<string, unknown>[]>,
  singleFor: {} as Record<string, Record<string, unknown> | null>,
  rpcData: null as unknown,
  rpcError: null as { code?: string } | null,
  inserts: [] as { table: string; row: unknown }[],
  updates: [] as { table: string; row: unknown }[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@/lib/auth/scope', () => ({ scuoleDiUtente: (...a: unknown[]) => h.scuoleDiUtente(...a) }))
vi.mock('@/lib/push/enqueue', () => ({ enqueueNotifiche: (...a: unknown[]) => h.enqueue(...a) }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    rpc: async () => ({ data: h.rpcData, error: h.rpcError }),
    from: (table: string) => {
      const b: Record<string, unknown> & { _last?: Record<string, unknown>; _op?: string } = {}
      b.select = () => b
      b.eq = () => b
      b.in = () => b
      b.or = () => b
      b.order = () => b
      b.limit = () => b
      b.maybeSingle = async () => ({ data: h.singleFor[table] ?? null, error: null })
      b.single = async () => ({ data: b._last ?? { id: `${table}-x` }, error: null })
      b.insert = (row: unknown) => { h.inserts.push({ table, row }); b._op = 'insert'; b._last = { id: `${table}-new`, ...(Array.isArray(row) ? {} : (row as object)) }; return b }
      b.update = (row: unknown) => {
        h.updates.push({ table, row }); b._op = 'update'
        // .update(...).select('id') ritorna le righe "aggiornate" (quelle lette);
        // senza .select() resta {data:null} come prima (POGEN invariato).
        const ret = h.singleFor[table] ? [h.singleFor[table]] : (h.rowsFor[table] ?? [])
        const u: Record<string, unknown> & { _sel?: boolean } = {}
        u.eq = () => u
        u.in = () => u
        u.order = () => u
        u.limit = () => u
        u.select = () => { u._sel = true; return u }
        u.single = async () => ({ data: ret[0] ?? null, error: null })
        u.maybeSingle = async () => ({ data: ret[0] ?? null, error: null })
        u.then = (r: (v: unknown) => unknown) => r({ data: u._sel ? ret : null, error: null })
        return u
      }
      b.delete = () => { b._op = 'delete'; return b }
      b.then = (resolve: (v: unknown) => unknown) => resolve(b._op ? { data: null, error: null } : { data: h.rowsFor[table] ?? [], error: null })
      return b
    },
  }),
}))

import { POST as POGEN, PATCH as ANNULLA } from '@/app/api/admin/merch/ordini-fornitore/route'
import { POST as CHECKIN } from '@/app/api/admin/merch/ordini-fornitore/checkin/route'
import { poCompleto } from '@/lib/merch/stati'

const OF_URL = 'http://localhost/api/admin/merch/ordini-fornitore'
const CI_URL = 'http://localhost/api/admin/merch/ordini-fornitore/checkin'
const post = (url: string, body: unknown) =>
  new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const patch = (url: string, body: unknown) =>
  new Request(url, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const FID = '55555555-5555-4555-8555-555555555555'
const R1 = '11111111-1111-4111-8111-111111111111'
const R2 = '22222222-2222-4222-8222-222222222222'

beforeEach(() => {
  vi.clearAllMocks()
  h.requireStaff.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: 'sc-1' } })
  h.scuoleDiUtente.mockResolvedValue(['sc-1'])
  h.enqueue.mockResolvedValue(undefined)
  h.rowsFor = {}
  h.singleFor = {}
  h.rpcData = 6
  h.rpcError = null
  h.inserts = []; h.updates = []
})

describe('POST /api/admin/merch/ordini-fornitore', () => {
  beforeEach(() => {
    h.rowsFor.divise_ordini_righe = [
      { id: R1, stato: 'da_ordinare', ordine_id: 'o1', ordine: { scuola_id: 'sc-1' } },
      { id: R2, stato: 'da_ordinare', ordine_id: 'o1', ordine: { scuola_id: 'sc-1' } },
    ]
    h.singleFor.merch_fornitori = { id: FID, nome: 'ForniTop', scuola_id: 'sc-1' }
  })

  it('403 senza staff', async () => {
    h.requireStaff.mockResolvedValue({ response: NextResponse.json({}, { status: 403 }) })
    expect((await POGEN(post(OF_URL, { fornitore_id: FID, righe_ids: [R1] }))).status).toBe(403)
  })

  it('201 crea PO numerato PO-AAAA-NNN e marca le righe ordinato', async () => {
    const res = await POGEN(post(OF_URL, { fornitore_id: FID, righe_ids: [R1, R2] }))
    expect(res.status).toBe(201)
    const po = h.inserts.find((i) => i.table === 'merch_ordini_fornitore')!.row as { numero: string; fornitore_nome: string; stato: string }
    expect(po.numero).toMatch(/^PO-\d{4}-006$/)
    expect(po).toMatchObject({ fornitore_nome: 'ForniTop', stato: 'aperto' })
    const upd = h.updates.find((u) => u.table === 'divise_ordini_righe')!.row as { stato: string; ordine_fornitore_id: string }
    expect(upd).toMatchObject({ stato: 'ordinato', ordine_fornitore_id: 'merch_ordini_fornitore-new' })
    const j = await res.json()
    expect(j.data.po.numero).toMatch(/^PO-\d{4}-006$/)
  })

  it('201 senza fornitore → nessun PO, righe ordinato con ordine_fornitore_id null', async () => {
    h.rowsFor.divise_ordini_righe = [{ id: R1, stato: 'da_ordinare', ordine_id: 'o1', ordine: { scuola_id: 'sc-1' } }]
    const res = await POGEN(post(OF_URL, { fornitore_id: null, righe_ids: [R1] }))
    expect(res.status).toBe(201)
    expect(h.inserts.find((i) => i.table === 'merch_ordini_fornitore')).toBeUndefined()
    const upd = h.updates.find((u) => u.table === 'divise_ordini_righe')!.row as { stato: string; ordine_fornitore_id: string | null }
    expect(upd).toMatchObject({ stato: 'ordinato', ordine_fornitore_id: null })
  })

  it('409 se una riga non è più da_ordinare', async () => {
    h.rowsFor.divise_ordini_righe[0].stato = 'ordinato'
    expect((await POGEN(post(OF_URL, { fornitore_id: FID, righe_ids: [R1, R2] }))).status).toBe(409)
  })

  it('403 righe fuori dal plesso', async () => {
    h.rowsFor.divise_ordini_righe = [{ id: R1, stato: 'da_ordinare', ordine_id: 'o1', ordine: { scuola_id: 'sc-ALTRO' } }]
    expect((await POGEN(post(OF_URL, { fornitore_id: FID, righe_ids: [R1] }))).status).toBe(403)
  })

  it('400 righe di plessi diversi', async () => {
    h.rowsFor.divise_ordini_righe = [
      { id: R1, stato: 'da_ordinare', ordine_id: 'o1', ordine: { scuola_id: 'sc-1' } },
      { id: R2, stato: 'da_ordinare', ordine_id: 'o2', ordine: { scuola_id: 'sc-2' } },
    ]
    expect((await POGEN(post(OF_URL, { fornitore_id: FID, righe_ids: [R1, R2] }))).status).toBe(400)
  })
})

describe('POST /api/admin/merch/ordini-fornitore/checkin', () => {
  beforeEach(() => {
    h.rowsFor.divise_ordini_righe = [
      { id: R1, stato: 'ordinato', ordine_id: 'o1', ordine_fornitore_id: 'po1', articolo_nome: 'Polo', ordine: { scuola_id: 'sc-1', alunno_id: 'al-1', alunni: { nome: 'Ada', cognome: 'B' } } },
    ]
    h.rowsFor.legame_genitori_alunni = [{ genitore_id: 'g1' }]
  })

  it('200 segna arrivato + notifica i genitori', async () => {
    const res = await CHECKIN(post(CI_URL, { righe_ids: [R1] }))
    expect(res.status).toBe(200)
    const upd = h.updates.find((u) => u.table === 'divise_ordini_righe')!.row as { stato: string }
    expect(upd.stato).toBe('arrivato')
    expect(h.enqueue).toHaveBeenCalled()
    const params = h.enqueue.mock.calls[0][1] as { utenteIds: string[]; tipo: string }
    expect(params.utenteIds).toEqual(['g1'])
    expect(params.tipo).toBe('merch_arrivato')
  })

  it('409 se una riga non è ordinata', async () => {
    h.rowsFor.divise_ordini_righe[0].stato = 'da_ordinare'
    expect((await CHECKIN(post(CI_URL, { righe_ids: [R1] }))).status).toBe(409)
  })

  it('403 righe fuori dal plesso', async () => {
    ;(h.rowsFor.divise_ordini_righe[0].ordine as { scuola_id: string }).scuola_id = 'sc-ALTRO'
    expect((await CHECKIN(post(CI_URL, { righe_ids: [R1] }))).status).toBe(403)
  })
})

// #17 — Rollback PO: annulla il PO, le righe 'ordinato' tornano 'da_ordinare'.
describe('PATCH /api/admin/merch/ordini-fornitore (annulla PO)', () => {
  it('404 se il PO non esiste', async () => {
    h.singleFor.merch_ordini_fornitore = null
    const res = await ANNULLA(patch(OF_URL, { id: FID, stato: 'annullato' }))
    expect(res.status).toBe(404)
  })

  it('403 se il PO è fuori dal plesso', async () => {
    h.singleFor.merch_ordini_fornitore = { id: FID, scuola_id: 'sc-ALTRO', stato: 'aperto' }
    const res = await ANNULLA(patch(OF_URL, { id: FID, stato: 'annullato' }))
    expect(res.status).toBe(403)
  })

  it('200 annulla il PO: righe → da_ordinare, PO → annullato', async () => {
    h.singleFor.merch_ordini_fornitore = { id: FID, scuola_id: 'sc-1', stato: 'aperto' }
    h.rowsFor.divise_ordini_righe = [{ id: 'r1', ordine_id: 'o1' }]
    const res = await ANNULLA(patch(OF_URL, { id: FID, stato: 'annullato' }))
    expect(res.status).toBe(200)
    const rigaUpd = h.updates.find((u) => u.table === 'divise_ordini_righe')!.row as { stato: string }
    expect(rigaUpd.stato).toBe('da_ordinare')
    const poUpd = h.updates.find((u) => u.table === 'merch_ordini_fornitore')!.row as { stato: string }
    expect(poUpd.stato).toBe('annullato')
  })
})

// #33 — Chiusura PO al check-in: verifica della funzione pura poCompleto.
// (Il mock ritorna la STESSA h.rowsFor.divise_ordini_righe per il check-in e per
//  la ri-query interna di chiudiPOcompleti, quindi i due stati non sono
//  distinguibili nel test d'integrazione: si copre la logica di chiusura qui.)
describe('poCompleto (chiusura PO)', () => {
  it('true se tutte le righe attive sono arrivate/consegnate', () => {
    expect(poCompleto(['arrivato', 'consegnato'])).toBe(true)
    expect(poCompleto(['consegnato', 'consegnato'])).toBe(true)
  })

  it('false se resta almeno una riga ordinata', () => {
    expect(poCompleto(['ordinato', 'arrivato'])).toBe(false)
    expect(poCompleto(['da_ordinare', 'arrivato'])).toBe(false)
  })

  it('le righe annullate sono ignorate; PO senza righe attive non è completo', () => {
    expect(poCompleto(['arrivato', 'annullato'])).toBe(true)
    expect(poCompleto(['annullato'])).toBe(false)
    expect(poCompleto([])).toBe(false)
  })
})
