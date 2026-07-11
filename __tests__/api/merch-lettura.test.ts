import { it, expect, vi, beforeEach, describe } from 'vitest'
import * as XLSX from 'xlsx'

// Filtro cross-plesso (#38) delle route di lettura merch:
//  - GET /api/admin/merch/export (XLSX flat)
//  - GET /api/admin/merch/da-ordinare (aggregazione per fornitore)
// Entrambe filtrano a livello DB con .in('ordine.scuola_id', plessi) + filtro JS
// e degradano su SCHEMA_MANCANTE. Pattern di mock ripreso da merch-giacenze.test.ts.
const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  scuoleDiUtente: vi.fn(),
  rowsFor: {} as Record<string, Record<string, unknown>[]>,
  singleFor: {} as Record<string, Record<string, unknown> | null>,
  errorFor: {} as Record<string, { code?: string; message?: string } | null>,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/auth/scope', () => ({ scuoleDiUtente: (...a: unknown[]) => h.scuoleDiUtente(...a) }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: (table: string) => {
      const b: Record<string, unknown> & { _op?: string } = {}
      b.select = () => b
      b.eq = () => b
      b.in = () => b
      b.or = () => b
      b.order = () => b
      b.limit = () => b
      b.maybeSingle = async () => ({ data: h.singleFor[table] ?? null, error: null })
      b.then = (resolve: (v: unknown) => unknown) =>
        resolve(b._op ? { data: null, error: null } : { data: h.rowsFor[table] ?? [], error: h.errorFor[table] ?? null })
      return b
    },
  }),
}))

import { GET as EXPORT } from '@/app/api/admin/merch/export/route'
import { GET as DA_ORDINARE } from '@/app/api/admin/merch/da-ordinare/route'

const get = (url: string) => new Request(url, { method: 'GET' })
const EXPORT_URL = 'http://localhost/api/admin/merch/export'
const DAORD_URL = 'http://localhost/api/admin/merch/da-ordinare'
const R1 = '11111111-1111-4111-8111-111111111111'
const R2 = '22222222-2222-4222-8222-222222222222'
const ART = '33333333-3333-4333-8333-333333333333'

beforeEach(() => {
  vi.clearAllMocks()
  h.requireStaff.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: 'sc-1' } })
  h.scuoleDiUtente.mockResolvedValue(['sc-1'])
  h.rowsFor = {}
  h.singleFor = {}
  h.errorFor = {}
})

describe('GET /api/admin/merch/export', () => {
  it('200 XLSX con le righe dei plessi in ambito', async () => {
    h.rowsFor.divise_ordini_righe = [
      {
        articolo_nome: 'Polo', taglia: 'M', quantita: 2, prezzo_unitario: 10,
        stato: 'consegnato', origine: 'fornitore',
        ordinato_il: '2026-01-01', arrivato_il: '2026-01-05', consegnato_il: '2026-01-10',
        ordine_fornitore: { numero: 'PO-1' },
        ordine: {
          scuola_id: 'sc-1', creato_il: '2026-01-01',
          alunni: { nome: 'Ada', cognome: 'B', classe_sezione: 'Girasoli' },
          pagamento: { stato: 'pagato' },
        },
      },
    ]
    const res = await EXPORT(get(EXPORT_URL))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('spreadsheetml')
    expect(res.headers.get('content-disposition')).toContain('merchandise-')
    const wb = XLSX.read(Buffer.from(await res.arrayBuffer()))
    expect(wb.SheetNames).toContain('Merchandise')
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets['Merchandise'])
    expect(rows).toHaveLength(1)
    expect(rows[0]['Articolo']).toBe('Polo')
    expect(rows[0]['Taglia']).toBe('M')
    expect(rows[0]['Totale €']).toBe(20)
    expect(rows[0]['PO']).toBe('PO-1')
  })

  it('scarta le righe di plessi fuori ambito (filtro JS su ordine.scuola_id)', async () => {
    h.rowsFor.divise_ordini_righe = [
      { articolo_nome: 'Polo', taglia: 'M', quantita: 1, prezzo_unitario: 10, stato: 'da_ordinare', ordine: { scuola_id: 'sc-1' } },
      { articolo_nome: 'Felpa', taglia: 'L', quantita: 1, prezzo_unitario: 20, stato: 'da_ordinare', ordine: { scuola_id: 'sc-ALTRO' } },
    ]
    const res = await EXPORT(get(EXPORT_URL))
    expect(res.status).toBe(200)
    const wb = XLSX.read(Buffer.from(await res.arrayBuffer()))
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets['Merchandise'])
    expect(rows).toHaveLength(1)
    expect(rows[0]['Articolo']).toBe('Polo')
  })

  it('200 foglio vuoto quando l\'utente non ha plessi', async () => {
    h.scuoleDiUtente.mockResolvedValue([])
    const res = await EXPORT(get(EXPORT_URL))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('spreadsheetml')
    const wb = XLSX.read(Buffer.from(await res.arrayBuffer()))
    expect(wb.SheetNames).toContain('Merchandise')
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets['Merchandise'])
    expect(rows).toHaveLength(0)
  })

  it('403 se il gate staff nega (auth.response)', async () => {
    const { NextResponse } = await import('next/server')
    h.requireStaff.mockResolvedValue({ response: NextResponse.json({}, { status: 403 }) })
    expect((await EXPORT(get(EXPORT_URL))).status).toBe(403)
  })

  it('200 foglio vuoto su DB non migrato (SCHEMA_MANCANTE → degrade)', async () => {
    h.errorFor.divise_ordini_righe = { code: '42P01', message: 'relation "divise_ordini_righe" does not exist' }
    const res = await EXPORT(get(EXPORT_URL))
    expect(res.status).toBe(200)
    const wb = XLSX.read(Buffer.from(await res.arrayBuffer()))
    expect(XLSX.utils.sheet_to_json(wb.Sheets['Merchandise'])).toHaveLength(0)
  })

  it('500 su errore DB non-schema', async () => {
    h.errorFor.divise_ordini_righe = { code: '23505', message: 'boom' }
    expect((await EXPORT(get(EXPORT_URL))).status).toBe(500)
  })
})

describe('GET /api/admin/merch/da-ordinare', () => {
  it('200 gruppi aggregati per fornitore (articolo × taglia × qty + righe_ids)', async () => {
    h.rowsFor.divise_ordini_righe = [
      { id: R1, articolo_id: ART, articolo_nome: 'Polo', taglia: 'M', quantita: 3, ordine: { scuola_id: 'sc-1' }, articolo: { fornitore_id: 'f1' } },
      { id: R2, articolo_id: ART, articolo_nome: 'Polo', taglia: 'L', quantita: 2, ordine: { scuola_id: 'sc-1' }, articolo: { fornitore_id: 'f1' } },
    ]
    h.rowsFor.merch_fornitori = [{ id: 'f1', nome: 'Acme' }]
    const res = await DA_ORDINARE(get(DAORD_URL))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.success).toBe(true)
    expect(j.data.gruppi).toHaveLength(1)
    const g = j.data.gruppi[0]
    expect(g.fornitore).toMatchObject({ id: 'f1', nome: 'Acme' })
    expect(g.quantita).toBe(5)
    expect(g.articoli).toHaveLength(1)
    expect(g.articoli[0]).toMatchObject({ articolo_id: ART, nome: 'Polo', quantita: 5 })
    const taglie = (g.articoli[0].taglie as { taglia: string; quantita: number; righe_ids: string[] }[])
    expect(taglie).toHaveLength(2)
    expect(taglie.find((t) => t.taglia === 'M')).toMatchObject({ quantita: 3, righe_ids: [R1] })
    expect(taglie.find((t) => t.taglia === 'L')).toMatchObject({ quantita: 2, righe_ids: [R2] })
  })

  it('bucket "Senza fornitore" (fornitore=null) in coda per articoli senza fornitore', async () => {
    h.rowsFor.divise_ordini_righe = [
      { id: R1, articolo_id: ART, articolo_nome: 'Polo', taglia: 'M', quantita: 1, ordine: { scuola_id: 'sc-1' }, articolo: { fornitore_id: 'f1' } },
      { id: R2, articolo_id: null, articolo_nome: 'Cappellino', taglia: null, quantita: 4, ordine: { scuola_id: 'sc-1' }, articolo: { fornitore_id: null } },
    ]
    h.rowsFor.merch_fornitori = [{ id: 'f1', nome: 'Acme' }]
    const j = await (await DA_ORDINARE(get(DAORD_URL))).json()
    expect(j.data.gruppi).toHaveLength(2)
    // ordinamento: fornitori per nome prima, "Senza fornitore" (null) in coda
    expect(j.data.gruppi[0].fornitore).toMatchObject({ id: 'f1' })
    expect(j.data.gruppi[1].fornitore).toBeNull()
    expect(j.data.gruppi[1].articoli[0]).toMatchObject({ nome: 'Cappellino', quantita: 4 })
  })

  it('scarta le righe di plessi fuori ambito', async () => {
    h.rowsFor.divise_ordini_righe = [
      { id: R1, articolo_id: ART, articolo_nome: 'Polo', taglia: 'M', quantita: 3, ordine: { scuola_id: 'sc-1' }, articolo: { fornitore_id: 'f1' } },
      { id: R2, articolo_id: ART, articolo_nome: 'Polo', taglia: 'L', quantita: 9, ordine: { scuola_id: 'sc-ALTRO' }, articolo: { fornitore_id: 'f1' } },
    ]
    h.rowsFor.merch_fornitori = [{ id: 'f1', nome: 'Acme' }]
    const j = await (await DA_ORDINARE(get(DAORD_URL))).json()
    expect(j.data.gruppi).toHaveLength(1)
    expect(j.data.gruppi[0].quantita).toBe(3)
  })

  it('200 gruppi [] quando l\'utente non ha plessi', async () => {
    h.scuoleDiUtente.mockResolvedValue([])
    const res = await DA_ORDINARE(get(DAORD_URL))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j).toEqual({ success: true, data: { gruppi: [] } })
  })

  it('403 se il gate staff nega (auth.response)', async () => {
    const { NextResponse } = await import('next/server')
    h.requireStaff.mockResolvedValue({ response: NextResponse.json({}, { status: 403 }) })
    expect((await DA_ORDINARE(get(DAORD_URL))).status).toBe(403)
  })

  it('200 gruppi [] su DB non migrato (SCHEMA_MANCANTE → degrade)', async () => {
    h.errorFor.divise_ordini_righe = { code: 'PGRST205', message: 'schema mancante' }
    const j = await (await DA_ORDINARE(get(DAORD_URL))).json()
    expect(j).toEqual({ success: true, data: { gruppi: [] } })
  })

  it('500 su errore DB non-schema', async () => {
    h.errorFor.divise_ordini_righe = { code: '23505', message: 'boom' }
    expect((await DA_ORDINARE(get(DAORD_URL))).status).toBe(500)
  })
})
