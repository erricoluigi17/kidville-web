import { it, expect, vi, beforeEach, describe } from 'vitest'

// evadi-magazzino (409 senza stock / ok scala), consegna (warning non pagato +
// notifica), rettifica POST.
const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  logScrittura: vi.fn(),
  scuoleDiUtente: vi.fn(),
  enqueue: vi.fn(),
  rowsFor: {} as Record<string, Record<string, unknown>[]>,
  singleFor: {} as Record<string, Record<string, unknown> | null>,
  singleErr: {} as Record<string, { code: string } | null>,
  inserts: [] as { table: string; row: unknown }[],
  updates: [] as { table: string; row: unknown }[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@/lib/auth/scope', () => ({ scuoleDiUtente: (...a: unknown[]) => h.scuoleDiUtente(...a) }))
vi.mock('@/lib/push/enqueue', () => ({ enqueueNotifiche: (...a: unknown[]) => h.enqueue(...a) }))
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
      b.maybeSingle = async () => ({ data: h.singleErr[table] ? null : (h.singleFor[table] ?? null), error: h.singleErr[table] ?? null })
      b.single = async () => ({ data: b._last ?? { id: `${table}-x` }, error: null })
      b.insert = (row: unknown) => { h.inserts.push({ table, row }); b._op = 'insert'; b._last = { id: `${table}-new`, ...(Array.isArray(row) ? {} : (row as object)) }; return b }
      b.update = (row: unknown) => {
        h.updates.push({ table, row }); b._op = 'update'
        // .update(...).eq/.in(...).select('id') ritorna le righe "aggiornate":
        // quelle lette per questa tabella (rowsFor o singleFor).
        const ret = h.singleFor[table] ? [h.singleFor[table]] : (h.rowsFor[table] ?? [])
        const u: Record<string, unknown> = {}
        u.eq = () => u
        u.in = () => u
        u.select = () => ({ then: (r: (v: unknown) => unknown) => r({ data: ret, error: null }) })
        u.then = (r: (v: unknown) => unknown) => r({ data: null, error: null })
        return u
      }
      b.delete = () => { b._op = 'delete'; return b }
      b.then = (resolve: (v: unknown) => unknown) => resolve(b._op ? { data: null, error: null } : { data: h.rowsFor[table] ?? [], error: null })
      return b
    },
  }),
}))

import { POST as EVADI } from '@/app/api/admin/merch/evadi-magazzino/route'
import { POST as CONSEGNA } from '@/app/api/admin/merch/consegna/route'
import { POST as RETTIFICA } from '@/app/api/admin/merch/giacenze/route'

const post = (url: string, body: unknown) =>
  new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const R1 = '11111111-1111-4111-8111-111111111111'
const ART = '22222222-2222-4222-8222-222222222222'

beforeEach(() => {
  vi.clearAllMocks()
  h.requireStaff.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: 'sc-1' } })
  h.scuoleDiUtente.mockResolvedValue(['sc-1'])
  h.enqueue.mockResolvedValue(undefined)
  h.rowsFor = {}
  h.singleFor = {}
  h.singleErr = {}
  h.inserts = []; h.updates = []
})

describe('POST /api/admin/merch/evadi-magazzino', () => {
  beforeEach(() => {
    h.singleFor.divise_ordini_righe = { id: R1, stato: 'da_ordinare', ordine_id: 'o1', articolo_id: ART, articolo_nome: 'Polo', taglia: 'M', quantita: 2, ordine: { scuola_id: 'sc-1', alunno_id: 'al-1' } }
    h.rowsFor.divise_ordini_righe = [] // nessun movimento magazzino pregresso
    h.rowsFor.legame_genitori_alunni = [{ genitore_id: 'g1' }]
  })

  it('409 se disponibilità insufficiente', async () => {
    h.rowsFor.merch_rettifiche = [{ articolo_id: ART, taglia: 'M', quantita_delta: 1 }] // caricato 1 < 2
    const res = await EVADI(post('http://localhost/api/admin/merch/evadi-magazzino', { riga_id: R1 }))
    expect(res.status).toBe(409)
  })

  it('200 evade da magazzino e imposta origine=magazzino/arrivato', async () => {
    h.rowsFor.merch_rettifiche = [{ articolo_id: ART, taglia: 'M', quantita_delta: 5 }] // caricato 5 ≥ 2
    const res = await EVADI(post('http://localhost/api/admin/merch/evadi-magazzino', { riga_id: R1 }))
    expect(res.status).toBe(200)
    const upd = h.updates.find((u) => u.table === 'divise_ordini_righe')!.row as { stato: string; origine: string }
    expect(upd).toMatchObject({ stato: 'arrivato', origine: 'magazzino' })
    const j = await res.json()
    expect(j.data.disponibile_residuo).toBe(3)
  })

  it('409 se la riga non è da_ordinare', async () => {
    h.singleFor.divise_ordini_righe!.stato = 'ordinato'
    h.rowsFor.merch_rettifiche = [{ articolo_id: ART, taglia: 'M', quantita_delta: 9 }]
    expect((await EVADI(post('http://localhost/api/admin/merch/evadi-magazzino', { riga_id: R1 }))).status).toBe(409)
  })

  it('403 se la riga è fuori dal plesso', async () => {
    h.singleFor.divise_ordini_righe = {
      id: R1, stato: 'da_ordinare', ordine_id: 'o1', articolo_id: ART, articolo_nome: 'Polo', taglia: 'M', quantita: 2,
      ordine: { scuola_id: 'sc-ALTRO', alunno_id: 'al-1' },
    }
    expect((await EVADI(post('http://localhost/api/admin/merch/evadi-magazzino', { riga_id: R1 }))).status).toBe(403)
  })

  it('404 se la riga non esiste', async () => {
    h.singleFor.divise_ordini_righe = null
    expect((await EVADI(post('http://localhost/api/admin/merch/evadi-magazzino', { riga_id: R1 }))).status).toBe(404)
  })

  it('503 se lo schema magazzino è mancante (DB non migrato)', async () => {
    h.singleErr.divise_ordini_righe = { code: '42P01' }
    expect((await EVADI(post('http://localhost/api/admin/merch/evadi-magazzino', { riga_id: R1 }))).status).toBe(503)
  })
})

describe('POST /api/admin/merch/consegna', () => {
  beforeEach(() => {
    h.rowsFor.divise_ordini_righe = [
      { id: R1, stato: 'arrivato', ordine_id: 'o1', articolo_nome: 'Polo', ordine: { id: 'o1', scuola_id: 'sc-1', alunno_id: 'al-1', pagamento: { stato: 'da_pagare' }, alunni: { nome: 'Ada', cognome: 'B' } } },
    ]
    h.rowsFor.legame_genitori_alunni = [{ genitore_id: 'g1' }]
  })

  it('200 consegna + warning "non pagato" (non bloccante) + notifica', async () => {
    const res = await CONSEGNA(post('http://localhost/api/admin/merch/consegna', { righe_ids: [R1] }))
    expect(res.status).toBe(200)
    const upd = h.updates.find((u) => u.table === 'divise_ordini_righe')!.row as { stato: string; consegnato_da: string }
    expect(upd).toMatchObject({ stato: 'consegnato', consegnato_da: 'seg-1' })
    const j = await res.json()
    expect(j.data.warnings).toHaveLength(1)
    expect(j.data.warnings[0]).toMatchObject({ pagamento_stato: 'da_pagare' })
    expect(h.enqueue).toHaveBeenCalled()
    expect((h.enqueue.mock.calls[0][1] as { tipo: string }).tipo).toBe('merch_consegnato')
  })

  it('nessun warning se pagamento saldato', async () => {
    ;(h.rowsFor.divise_ordini_righe[0].ordine as { pagamento: { stato: string } }).pagamento.stato = 'pagato'
    const j = await (await CONSEGNA(post('http://localhost/api/admin/merch/consegna', { righe_ids: [R1] }))).json()
    expect(j.data.warnings).toHaveLength(0)
  })

  it('409 se una riga non è arrivata', async () => {
    h.rowsFor.divise_ordini_righe[0].stato = 'ordinato'
    expect((await CONSEGNA(post('http://localhost/api/admin/merch/consegna', { righe_ids: [R1] }))).status).toBe(409)
  })
})

describe('POST /api/admin/merch/giacenze (rettifica)', () => {
  beforeEach(() => {
    h.singleFor.divise_articoli = { id: ART, scuola_id: 'sc-1', nome: 'Polo' }
  })
  it('400 quantita_delta = 0', async () => {
    expect((await RETTIFICA(post('http://localhost/api/admin/merch/giacenze', { articolo_id: ART, quantita_delta: 0 }))).status).toBe(400)
  })
  it('403 articolo fuori dal plesso', async () => {
    h.singleFor.divise_articoli = { id: ART, scuola_id: 'sc-ALTRO', nome: 'Polo' }
    expect((await RETTIFICA(post('http://localhost/api/admin/merch/giacenze', { articolo_id: ART, quantita_delta: 5 }))).status).toBe(403)
  })
  it('201 carico + snapshot nome + audit', async () => {
    const res = await RETTIFICA(post('http://localhost/api/admin/merch/giacenze', { articolo_id: ART, taglia: 'M', quantita_delta: 10, motivo: 'carico' }))
    expect(res.status).toBe(201)
    expect(h.inserts[0].row).toMatchObject({ articolo_id: ART, articolo_nome: 'Polo', scuola_id: 'sc-1', quantita_delta: 10, motivo: 'carico' })
    expect(h.logScrittura).toHaveBeenCalled()
  })
})
