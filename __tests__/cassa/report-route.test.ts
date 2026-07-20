import { it, expect, vi, beforeEach, describe } from 'vitest'
import { NextResponse, NextRequest } from 'next/server'

// ── Report cassa (E2.5) ───────────────────────────────────────────────────────
// Logica pura di aggregazione (entrate per categoria di pagamento cross-mese,
// uscite per categoria cassa, mensile, CSV) + route GET (solo admin, degradazione,
// export CSV con BOM/';'/virgola decimale).

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  scuola: vi.fn(),
  incassi: { data: null as unknown, error: null as unknown },
  movimenti: { data: null as unknown, error: null as unknown },
  logEvento: vi.fn(),
  logErrore: vi.fn(),
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: (...a: unknown[]) => h.requireStaff(...a) }))
vi.mock('@/lib/auth/scope', () => ({ resolveScuolaScrittura: (...a: unknown[]) => h.scuola(...a) }))
vi.mock('@/lib/logging/logger', () => ({
  logEvento: (...a: unknown[]) => h.logEvento(...a),
  logErrore: (...a: unknown[]) => h.logErrore(...a),
  logOk: () => {},
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: (table: string) => {
      const result = table === 'incassi' ? h.incassi : h.movimenti
      const b: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'gte', 'lte', 'order']) b[m] = () => b
      b.then = (resolve: (v: unknown) => unknown) => resolve(result)
      return b
    },
  }),
}))

import { GET } from '@/app/api/pagamenti/cassa/report/route'
import {
  aggregaEntratePerCategoria,
  aggregaUscitePerCategoria,
  aggregaMensile,
  costruisciCsvReport,
  type IncassoReport,
  type IncassoReportData,
  type UscitaReport,
} from '@/lib/cassa/report'
import { CASSA_METODO_LABEL, metodoLabel, meseItaliano } from '@/lib/cassa/tipi'

const SC = 'd53b0fbc-a9eb-4073-b302-73d1d5abd529'
const CAT_SAGGIO = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

const req = (qs: string) =>
  new NextRequest(`http://localhost/api/pagamenti/cassa/report?${qs}`, {
    headers: { 'x-user-id': 'admin-1' },
  })

beforeEach(() => {
  vi.clearAllMocks()
  h.requireStaff.mockResolvedValue({ user: { id: 'admin-1', role: 'admin', scuola_id: SC } })
  h.scuola.mockResolvedValue({ scuolaId: SC })
  h.incassi = { data: [], error: null }
  h.movimenti = { data: [], error: null }
})

// ── CONTRATTO ETICHETTE (P1/P3, condiviso con E3) ────────────────────────────
// metodoLabel/meseItaliano sono importati anche dalla UI (CassaReport/CassaPanel):
// le firme qui asserite sono VINCOLANTI, non cambiarle senza toccare E3.
describe('metodoLabel', () => {
  it('mappa i metodi noti alle label capitalizzate', () => {
    expect(metodoLabel('contanti')).toBe('Contanti')
    expect(metodoLabel('bonifico')).toBe('Bonifico')
    expect(metodoLabel('pos')).toBe('POS')
    expect(metodoLabel('credito_famiglia')).toBe('Credito famiglia')
  })

  it('fallback per metodi sconosciuti: iniziale maiuscola', () => {
    expect(metodoLabel('sconosciuto')).toBe('Sconosciuto')
  })

  it('la tabella CASSA_METODO_LABEL espone le chiavi del contratto', () => {
    expect(CASSA_METODO_LABEL.pos).toBe('POS')
    expect(CASSA_METODO_LABEL.assegno).toBe('Assegno')
    expect(CASSA_METODO_LABEL.storno).toBe('Storno')
  })
})

describe('meseItaliano', () => {
  it("'AAAA-MM' → 'MM/AAAA'", () => {
    expect(meseItaliano('2026-07')).toBe('07/2026')
    expect(meseItaliano('2026-01')).toBe('01/2026')
  })

  it('input non conforme resta invariato (nessun crash)', () => {
    expect(meseItaliano('2026')).toBe('2026')
    expect(meseItaliano('')).toBe('')
  })
})

// ── LOGICA PURA ────────────────────────────────────────────────────────────────
describe('aggregaEntratePerCategoria', () => {
  it('un incasso contanti in una categoria → un totale per metodo', () => {
    const inc: IncassoReport[] = [
      { id: 'i1', importo: 50, metodo: 'contanti', storno_di: null, categoria_id: CAT_SAGGIO, categoria_nome: 'Saggio' },
    ]
    const out = aggregaEntratePerCategoria(inc)
    expect(out).toHaveLength(1)
    expect(out[0].categoria_nome).toBe('Saggio')
    expect(out[0].totale).toBe(50)
    expect(out[0].per_metodo).toEqual({ contanti: 50 })
  })

  it('«quota Saggio» in 3 acconti su 3 mesi (metodi misti) → UN totale unico', () => {
    const inc: IncassoReport[] = [
      { id: 'i1', importo: 20, metodo: 'contanti', storno_di: null, categoria_id: CAT_SAGGIO, categoria_nome: 'Saggio' },
      { id: 'i2', importo: 30, metodo: 'bonifico', storno_di: null, categoria_id: CAT_SAGGIO, categoria_nome: 'Saggio' },
      { id: 'i3', importo: 40, metodo: 'contanti', storno_di: null, categoria_id: CAT_SAGGIO, categoria_nome: 'Saggio' },
    ]
    const out = aggregaEntratePerCategoria(inc)
    expect(out).toHaveLength(1)
    expect(out[0].totale).toBe(90)
    expect(out[0].per_metodo).toEqual({ contanti: 60, bonifico: 30 })
  })

  it('storno di un incasso → si sottrae dallo stesso metodo dell’originale (netto)', () => {
    const inc: IncassoReport[] = [
      { id: 'a', importo: 50, metodo: 'contanti', storno_di: null, categoria_id: CAT_SAGGIO, categoria_nome: 'Saggio' },
      { id: 'b', importo: -50, metodo: 'storno', storno_di: 'a', categoria_id: CAT_SAGGIO, categoria_nome: 'Saggio' },
    ]
    const out = aggregaEntratePerCategoria(inc)
    expect(out[0].totale).toBe(0)
    expect(out[0].per_metodo.contanti).toBe(0)
  })

  it('metodi non reali (rettifica, credito_famiglia) sono ignorati', () => {
    const inc: IncassoReport[] = [
      { id: 'x', importo: 100, metodo: 'rettifica', storno_di: null, categoria_id: CAT_SAGGIO, categoria_nome: 'Saggio' },
      { id: 'y', importo: 100, metodo: 'credito_famiglia', storno_di: null, categoria_id: CAT_SAGGIO, categoria_nome: 'Saggio' },
    ]
    expect(aggregaEntratePerCategoria(inc)).toEqual([])
  })
})

describe('aggregaUscitePerCategoria', () => {
  it('uscita contanti + uscita bonifico → split contanti/altri, totale netto', () => {
    const usc: UscitaReport[] = [
      { importo: 20, metodo: 'contanti', categoria_id: 'c1', categoria_nome: 'Pulizie' },
      { importo: 80, metodo: 'bonifico', categoria_id: 'c1', categoria_nome: 'Pulizie' },
    ]
    const out = aggregaUscitePerCategoria(usc)
    expect(out).toHaveLength(1)
    expect(out[0].totale).toBe(100)
    expect(out[0].contanti).toBe(20)
    expect(out[0].altri).toBe(80)
  })

  it('storno di un’uscita (importo negato) si ricompone', () => {
    const usc: UscitaReport[] = [
      { importo: 20, metodo: 'contanti', categoria_id: 'c1', categoria_nome: 'Pulizie' },
      { importo: -20, metodo: 'contanti', categoria_id: 'c1', categoria_nome: 'Pulizie' },
    ]
    const out = aggregaUscitePerCategoria(usc)
    expect(out[0].totale).toBe(0)
    expect(out[0].contanti).toBe(0)
  })
})

describe('aggregaMensile', () => {
  it('raggruppa entrate e uscite per mese YYYY-MM', () => {
    const entrate: IncassoReportData[] = [
      { id: 'i1', importo: 20, metodo: 'contanti', storno_di: null, categoria_id: CAT_SAGGIO, categoria_nome: 'Saggio', data: '2026-05-10' },
      { id: 'i2', importo: 30, metodo: 'contanti', storno_di: null, categoria_id: CAT_SAGGIO, categoria_nome: 'Saggio', data: '2026-06-01' },
    ]
    const uscite = [
      { importo: 10, metodo: 'contanti', data: '2026-06-15' },
    ]
    const out = aggregaMensile(entrate, uscite)
    expect(out).toEqual([
      { mese: '2026-05', entrate: 20, uscite: 0 },
      { mese: '2026-06', entrate: 30, uscite: 10 },
    ])
  })
})

describe('costruisciCsvReport', () => {
  it('CSV con BOM, separatore «;» e virgola decimale', () => {
    const csv = costruisciCsvReport({
      entrate_per_categoria: [{ categoria_id: CAT_SAGGIO, categoria_nome: 'Saggio', totale: 50, per_metodo: { contanti: 50 } }],
      uscite_per_categoria: [{ categoria_id: 'c1', categoria_nome: 'Pulizie', totale: 20, contanti: 20, altri: 0 }],
      mensile: [{ mese: '2026-06', entrate: 50, uscite: 20 }],
    })
    expect(csv.startsWith('﻿')).toBe(true)
    expect(csv).toContain(';')
    expect(csv).toContain('50,00')
    expect(csv).toContain('Saggio')
    // niente separatore decimale col punto sugli importi
    expect(csv).not.toContain('50.00')
  })

  it('CSV localizzato: metodo con label capitalizzata e mese MM/AAAA (P1/P3)', () => {
    const csv = costruisciCsvReport({
      entrate_per_categoria: [{ categoria_id: CAT_SAGGIO, categoria_nome: 'Saggio', totale: 50, per_metodo: { contanti: 50 } }],
      uscite_per_categoria: [{ categoria_id: 'c1', categoria_nome: 'Pulizie', totale: 20, contanti: 20, altri: 0 }],
      mensile: [{ mese: '2026-06', entrate: 50, uscite: 20 }],
    })
    // metodo grezzo 'contanti' → label 'Contanti'
    expect(csv).toContain('Contanti')
    expect(csv).not.toMatch(/;contanti;/)
    // mese 'AAAA-MM' → 'MM/AAAA'
    expect(csv).toContain('06/2026')
    expect(csv).not.toContain('2026-06')
    // BOM/separatore/decimale invariati
    expect(csv.startsWith('﻿')).toBe(true)
    expect(csv).toContain(';')
    expect(csv).toContain('50,00')
  })
})

// ── ROUTE GET ───────────────────────────────────────────────────────────────────
describe('GET /api/pagamenti/cassa/report', () => {
  it('403 per la segreteria (gate solo admin)', async () => {
    h.requireStaff.mockResolvedValue({ response: NextResponse.json({ error: 'no' }, { status: 403 }) })
    const res = await GET(req(`scuola_id=${SC}`))
    expect(res.status).toBe(403)
    expect(h.requireStaff).toHaveBeenCalledWith(expect.anything(), ['admin'])
  })

  it('schema cassa assente (42P01 su cassa_movimenti) → 200 { disponibile:false }, mai 500', async () => {
    h.movimenti = { data: null, error: { code: '42P01', message: 'relation does not exist' } }
    const res = await GET(req(`scuola_id=${SC}`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.disponibile).toBe(false)
    expect(h.logEvento).toHaveBeenCalled()
  })

  it('aggrega le entrate per categoria di pagamento (cross-mese)', async () => {
    h.incassi = {
      data: [
        { id: 'i1', importo: 20, metodo: 'contanti', storno_di: null, data_incasso: '2026-05-01', stornato_il: null, pagamenti: { scuola_id: SC, categoria_id: CAT_SAGGIO, payment_categories: { id: CAT_SAGGIO, nome: 'Saggio' } } },
        { id: 'i2', importo: 40, metodo: 'contanti', storno_di: null, data_incasso: '2026-06-01', stornato_il: null, pagamenti: { scuola_id: SC, categoria_id: CAT_SAGGIO, payment_categories: { id: CAT_SAGGIO, nome: 'Saggio' } } },
      ],
      error: null,
    }
    const res = await GET(req(`scuola_id=${SC}&categoria_pagamento_id=${CAT_SAGGIO}`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.disponibile).toBe(true)
    expect(body.entrate_per_categoria).toHaveLength(1)
    expect(body.entrate_per_categoria[0].totale).toBe(60)
  })

  it('format=csv → text/csv con BOM e logga l’export', async () => {
    h.incassi = {
      data: [
        { id: 'i1', importo: 50, metodo: 'contanti', storno_di: null, data_incasso: '2026-06-01', stornato_il: null, pagamenti: { scuola_id: SC, categoria_id: CAT_SAGGIO, payment_categories: { id: CAT_SAGGIO, nome: 'Saggio' } } },
      ],
      error: null,
    }
    const res = await GET(req(`scuola_id=${SC}&format=csv`))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/csv')
    // Il BOM viene emesso come byte EF BB BF (Response.text() lo strippa in decodifica,
    // perciò si controllano i byte grezzi: è ciò che Excel legge davvero).
    const bytes = new Uint8Array(await res.arrayBuffer())
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf])
    expect(h.logEvento).toHaveBeenCalledWith('cassa', 'info', expect.objectContaining({ esito: 'export-csv' }))
  })
})
