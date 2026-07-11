import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import * as XLSX from 'xlsx'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  pagamenti: [] as Record<string, unknown>[],
  alunni: [] as Record<string, unknown>[],
  incassi: [] as Record<string, unknown>[],
  parentReg: null as Record<string, unknown> | null,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/auth/scope', () => ({ resolveScuoleAttive: vi.fn(async () => ['sc-1']) }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.order = () => b
      b.eq = () => b
      b.in = () => b
      b.gte = () => b
      b.lte = () => b
      b.maybeSingle = async () => ({ data: table === 'parents' ? h.parentReg : null, error: null })
      b.then = (resolve: (v: unknown) => unknown) =>
        resolve({
          data: table === 'pagamenti' ? h.pagamenti : table === 'alunni' ? h.alunni : table === 'incassi' ? h.incassi : [],
          error: null,
        })
      return b
    },
  }),
}))

import { GET } from '@/app/api/pagamenti/export/route'

const url = (qs: string) => new Request(`http://localhost/api/pagamenti/export?${qs}`) as unknown as import('next/server').NextRequest

describe('GET /api/pagamenti/export', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.requireStaff.mockResolvedValue({ user: { id: 'staff-1', role: 'segreteria' } })
    h.pagamenti = [{
      id: 'p1', descrizione: 'Retta Settembre', importo: 150, importo_pagato: 150, stato: 'pagato',
      tipo: 'singolo', scadenza: '2026-09-05', periodo_competenza: '2026-09-01', fattura_stato: 'non_richiesta',
      alunni: { nome: 'Mario', cognome: 'Rossi', classe_sezione: 'Girasoli' },
      payment_categories: { nome: 'Retta' },
    }]
  })

  it('403 per i non-staff', async () => {
    h.requireStaff.mockResolvedValue({ response: NextResponse.json({}, { status: 403 }) })
    expect((await GET(url('tipo=scadenzario'))).status).toBe(403)
  })

  it('400 con tipo non previsto', async () => {
    expect((await GET(url('tipo=boh'))).status).toBe(400)
  })

  it('200 con XLSX in attachment', async () => {
    const res = await GET(url('tipo=scadenzario'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('spreadsheetml')
    expect(res.headers.get('content-disposition')).toContain('scadenzario')
    const buf = await res.arrayBuffer()
    expect(buf.byteLength).toBeGreaterThan(0)
  })
})

describe('GET /api/pagamenti/export?tipo=ade', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.requireStaff.mockResolvedValue({ user: { id: 'staff-1', role: 'segreteria' } })
    h.alunni = [
      { id: 'al-1', nome: 'Mario', cognome: 'Rossi', codice_fiscale: 'RSSMRA20A01F839X', opposizione_ade: false, intestatario_fatture: { adult_id: 'p-1' }, scuola_id: 'sc-1' },
      { id: 'al-2', nome: 'Lia', cognome: 'Bianchi', codice_fiscale: 'BNCLIA20A41F839Y', opposizione_ade: true, intestatario_fatture: { adult_id: 'p-1' }, scuola_id: 'sc-1' },
    ]
    h.incassi = [
      { importo: 150, metodo: 'bonifico', data_incasso: '2026-01-10', pagamenti: { alunno_id: 'al-1', descrizione: 'Retta Gennaio', payment_categories: { slug: 'retta' } } },
      { importo: 50, metodo: 'contanti', data_incasso: '2026-02-10', pagamenti: { alunno_id: 'al-1', descrizione: 'Gita', payment_categories: { slug: 'gita' } } },
      { importo: 100, metodo: 'bonifico', data_incasso: '2026-01-15', pagamenti: { alunno_id: 'al-2', descrizione: 'Retta Gennaio', payment_categories: { slug: 'retta' } } },
    ]
    h.parentReg = { id: 'p-1', first_name: 'Giulia', last_name: 'Farina', fiscal_code: 'FRNGLI80A41F839K', residence_address: null, residence_city: null, zip_code: null }
  })

  it('400 senza anno', async () => {
    expect((await GET(url('tipo=ade'))).status).toBe(400)
  })

  it('due fogli: comunicabili (tracciabile, no opposizione) ed escluse con motivo', async () => {
    const res = await GET(url('tipo=ade&anno=2026'))
    expect(res.status).toBe(200)
    const wb = XLSX.read(Buffer.from(await res.arrayBuffer()))
    expect(wb.SheetNames).toEqual(['Da comunicare', 'Escluse'])

    const daComunicare = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets['Da comunicare'])
    expect(daComunicare).toHaveLength(1)
    expect(daComunicare[0]['CF alunno']).toBe('RSSMRA20A01F839X')
    expect(daComunicare[0]['CF pagatore']).toBe('FRNGLI80A41F839K')
    expect(daComunicare[0]['Importo comunicabile €']).toBe(150)

    const escluse = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets['Escluse'])
    // al-2 per opposizione + la quota contanti di al-1
    expect(escluse.some((r) => r['Alunno'] === 'Lia Bianchi' && String(r['Motivo']).toLowerCase().includes('opposizione'))).toBe(true)
    expect(escluse.some((r) => r['Alunno'] === 'Mario Rossi' && String(r['Motivo']).toLowerCase().includes('tracciab'))).toBe(true)
  })
})
