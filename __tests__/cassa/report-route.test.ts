import { it, expect, vi, beforeEach, describe } from 'vitest'
import { SEDE_A } from '../fixtures/sedi'
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
  // Sposta il SUM piatto della funzione: simula un report che non quadra.
  spostaControllo: 0,
  argsRpc: [] as Record<string, unknown>[],
  argsCashRpc: [] as Record<string, unknown>[],
  conteggio: { data: { righe: [], totali: { entrate: 0, uscite: 0, prelievi: 0, rettifiche: 0, netto: 0 } } as unknown, error: null as unknown },
  categoria: { data: null as unknown, error: null as unknown },
  nomiSedi: [] as { id: string; nome: string }[],
  buildPdf: vi.fn(() => Buffer.from("%PDF-test")),
  carta: vi.fn(async (b: Uint8Array) => b),
}))

vi.mock('@/lib/cassa/stampa', async (orig) => ({ ...(await orig<typeof import('@/lib/cassa/stampa')>()), costruisciConteggioPdf: h.buildPdf }))
vi.mock('@/lib/carta', () => ({ applicaCartaIntestata: h.carta }))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: (...a: unknown[]) => h.requireStaff(...a) }))
// Dal 2026-09-26 (K3) la GET legge le sedi attive + la `restringiSedi` VERA
// (lettura unita e per_sede: lettura-multisede.test.ts).
vi.mock('@/lib/auth/scope', async (importActual) => ({
  restringiSedi: (await importActual<typeof import('@/lib/auth/scope')>()).restringiSedi,
  resolveScuoleAttive: (...a: unknown[]) => h.scuola(...a),
}))
vi.mock('@/lib/logging/logger', () => ({
  logEvento: (...a: unknown[]) => h.logEvento(...a),
  logErrore: (...a: unknown[]) => h.logErrore(...a),
  logOk: () => {},
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    // Dal 2026-10-10 il report lo calcola `report_cassa_aggregato`: il finto la emula
    // con la semantica di riferimento sulle stesse righe (e propaga l'errore iniettato).
    rpc: async (nome: string, args: Record<string, unknown>) => {
      if (nome === 'conteggio_cassa_provenienza') { h.argsCashRpc.push(args); return h.conteggio }
      if (nome !== 'report_cassa_aggregato') throw new Error(`rpc ${nome} non emulata`)
      const errore = h.incassi.error ?? h.movimenti.error
      if (errore) return { data: null, error: errore }
      h.argsRpc.push(args)
      const { reportCassaDiRiferimento } = await import('../fixtures/report-cassa-riferimento')
      const data = reportCassaDiRiferimento(
        { incassi: (h.incassi.data ?? []) as Record<string, unknown>[], cassa_movimenti: (h.movimenti.data ?? []) as Record<string, unknown>[] },
        args,
      )
      data.controllo.entrate += h.spostaControllo
      return { data, error: null }
    },
    from: (table: string) => {
      const result = table === 'payment_categories' ? h.categoria : table === 'incassi' ? h.incassi : table === 'schools' ? { data: h.nomiSedi, error: null } : h.movimenti
      const b: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'in', 'gte', 'lte', 'order', 'maybeSingle']) b[m] = () => b
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

const SC = SEDE_A
const CAT_SAGGIO = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

const req = (qs: string) =>
  new NextRequest(`http://localhost/api/pagamenti/cassa/report?${qs}`, {
    headers: { 'x-user-id': 'admin-1' },
  })

beforeEach(() => {
  vi.clearAllMocks()
  h.requireStaff.mockResolvedValue({ user: { id: 'admin-1', role: 'admin', scuola_id: SC } })
  h.scuola.mockResolvedValue([SC])
  h.incassi = { data: [], error: null }
  h.movimenti = { data: [], error: null }
  h.spostaControllo = 0
  h.categoria = { data: { id: CAT_SAGGIO, nome: 'Saggio', scuola_id: SC }, error: null }
  h.nomiSedi = [{ id: SC, nome: 'Kidville Alfa' }]
  h.argsRpc = []
  h.argsCashRpc = []
  h.conteggio = { data: { righe: [], totali: { entrate: 0, uscite: 0, prelievi: 0, rettifiche: 0, netto: 0 } }, error: null }
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
  it('403 per la segreteria (gate solo Direzione)', async () => {
    // Dal 2026-09-02 il gate ammette anche `coordinator`, che nell'app si chiama
    // «Direzione»: prima era il solo `admin`, e l'unico account Direzione non
    // vedeva i report della propria cassa. La segreteria resta fuori.
    h.requireStaff.mockResolvedValue({ response: NextResponse.json({ error: 'no' }, { status: 403 }) })
    const res = await GET(req(`scuola_id=${SC}`))
    expect(res.status).toBe(403)
    expect(h.requireStaff).toHaveBeenCalledWith(expect.anything(), ['admin', 'coordinator'])
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
  it('passa alla funzione SQL sedi e filtri così come sono arrivati', async () => {
    h.incassi = { data: [], error: null }
    await GET(req(`scuola_id=${SC}&da=2026-01-01&a=2026-06-30&categoria_pagamento_id=${CAT_SAGGIO}`))
    expect(h.argsRpc.at(-1)).toEqual({ p_scuola_ids: [SC], p_da: '2026-01-01', p_a: '2026-06-30', p_categoria: CAT_SAGGIO })
  })

  it('🔴 totali che non quadrano con il SUM piatto → 500 REPORT_CASSA_NON_QUADRA, e niente report', async () => {
    h.incassi = {
      data: [{ id: 'i1', importo: 20, metodo: 'contanti', storno_di: null, data_incasso: '2026-05-01', pagamenti: { scuola_id: SC, categoria_id: CAT_SAGGIO, payment_categories: { id: CAT_SAGGIO, nome: 'Saggio' } } }],
      error: null,
    }
    h.spostaControllo = 0.01
    const res = await GET(req(`scuola_id=${SC}`))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.codice).toBe('REPORT_CASSA_NON_QUADRA')
    expect(body.entrate_per_categoria).toBeUndefined()
    expect(h.logErrore).toHaveBeenCalledWith(expect.objectContaining({ evento: 'totali-non-quadrano', stato: 500 }), expect.any(Error))
    // E nemmeno il CSV esce.
    const csv = await GET(req(`scuola_id=${SC}&format=csv`))
    expect(csv.status).toBe(500)
  })

  it('report che quadra → 200 e il successo loggato con i conteggi', async () => {
    h.incassi = {
      data: [{ id: 'i1', importo: 20, metodo: 'contanti', storno_di: null, data_incasso: '2026-05-01', pagamenti: { scuola_id: SC, categoria_id: CAT_SAGGIO, payment_categories: { id: CAT_SAGGIO, nome: 'Saggio' } } }],
      error: null,
    }
    const res = await GET(req(`scuola_id=${SC}`))
    expect(res.status).toBe(200)
    expect(h.logEvento).toHaveBeenCalledWith('cassa', 'info', expect.objectContaining({ esito: 'calcolato', incassi: 1, movimenti: 0 }))
  })

  it('errore della funzione che non è «schema assente» → 500 REPORT_CASSA_NON_CALCOLATO', async () => {
    h.incassi = { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } }
    const res = await GET(req(`scuola_id=${SC}`))
    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('REPORT_CASSA_NON_CALCOLATO')
  })
})


describe('GET report PDF', () => {
  it('genera PDF privato sulla carta e logga il successo; totale ignora la categoria residua', async () => {
    const res = await GET(req(`scuola_id=${SC}&format=pdf&raggruppamento=totale&categoria_pagamento_id=${CAT_SAGGIO}&da=2026-09-01&a=2026-09-30`))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/pdf')
    expect(res.headers.get('cache-control')).toContain('private')
    expect(res.headers.get('cache-control')).toContain('no-store')
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('%PDF-test')
    expect(h.argsRpc).toHaveLength(0)
    expect(h.argsCashRpc.at(-1)).toEqual({ p_scuola_ids: [SC], p_da: '2026-09-01', p_a: '2026-09-30' })
    expect(h.buildPdf).toHaveBeenCalledWith(expect.objectContaining({ raggruppamento: 'totale', da: '2026-09-01', a: '2026-09-30', sedi: [expect.objectContaining({ nome: 'Kidville Alfa' })] }))
    expect(h.carta).toHaveBeenCalledTimes(1)
    expect(h.logEvento).toHaveBeenCalledWith('cassa', 'info', expect.objectContaining({ esito: 'export-pdf', sedi: 1 }))
  })

  it('per categoria usa solo la RPC cash e passa la scelta al renderer', async () => {
    const res = await GET(req(`scuola_id=${SC}&format=pdf&raggruppamento=categoria&categoria_pagamento_id=${CAT_SAGGIO}`))
    expect(res.status).toBe(200)
    expect(h.argsRpc).toHaveLength(0)
    expect(h.argsCashRpc).toHaveLength(1)
    expect(h.buildPdf).toHaveBeenCalledWith(expect.objectContaining({ raggruppamento: 'categoria', categoriaId: CAT_SAGGIO }))
  })

  it.each(['format=pdf', 'format=pdf&raggruppamento=sede', 'format=pdf&raggruppamento=totale&da=2026-10-01&a=2026-09-30'])('rifiuta una scelta o un periodo invalido: %s', async (qs) => {
    const res = await GET(req(`scuola_id=${SC}&${qs}`))
    expect(res.status).toBe(400)
    expect(h.argsRpc).toHaveLength(0)
    expect(h.buildPdf).not.toHaveBeenCalled()
  })

  it('non consegna PDF se i totali cash non quadrano', async () => {
    h.conteggio = { data: { righe: [], totali: { entrate: 1, uscite: 0, prelievi: 0, rettifiche: 0, netto: 1 } }, error: null }
    const res = await GET(req(`scuola_id=${SC}&format=pdf&raggruppamento=totale`))
    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('CONTEGGIO_CASSA_NON_QUADRA')
    expect(h.buildPdf).not.toHaveBeenCalled()
  })
})


it('PDF: RPC cash assente → 503 esplicito e nessun file parziale', async () => {
  h.conteggio = { data: null, error: { code: 'PGRST202', message: 'function absent' } }
  const res = await GET(req(`scuola_id=${SC}&format=pdf&raggruppamento=totale`))
  expect(res.status).toBe(503)
  expect((await res.json()).codice).toBe('CONTEGGIO_CASSA_NON_DISPONIBILE')
  expect(h.buildPdf).not.toHaveBeenCalled()
  expect(h.logErrore).toHaveBeenCalledWith(expect.objectContaining({ evento: 'conteggio-contanti-db' }), expect.anything())
})

it('PDF: risultato cash non quadrato o fuori scope → 500 e nessun documento', async () => {
  h.conteggio = { data: { righe: [], totali: { entrate: 1, uscite: 0, prelievi: 0, rettifiche: 0, netto: 1 } }, error: null }
  const res = await GET(req(`scuola_id=${SC}&format=pdf&raggruppamento=totale`))
  expect(res.status).toBe(500)
  expect((await res.json()).codice).toBe('CONTEGGIO_CASSA_NON_QUADRA')
  expect(h.buildPdf).not.toHaveBeenCalled()
})


it('PDF scaricabile ha Content-Disposition attachment', async () => {
  const res = await GET(req(`scuola_id=${SC}&format=pdf&raggruppamento=totale&scarica=1`))
  expect(res.status).toBe(200)
  expect(res.headers.get('content-disposition')).toBe('attachment; filename="conteggio-cassa.pdf"')
})

it('PDF non esce senza nomi delle sedi, evitando etichette sbagliate', async () => {
  h.nomiSedi = []
  const res = await GET(req(`scuola_id=${SC}&format=pdf&raggruppamento=totale`))
  expect(res.status).toBe(503)
  expect((await res.json()).codice).toBe('CONTEGGIO_SEDI_NON_DISPONIBILI')
  expect(h.buildPdf).not.toHaveBeenCalled()
})

it('PDF non accetta una riga della RPC fuori dalle sedi autorizzate', async () => {
  const importi = { entrate: 10, uscite: 0, prelievi: 0, rettifiche: 0, netto: 10 }
  h.conteggio = { data: { righe: [{ ...importi, scuola_id: '33333333-3333-4333-8333-333333333333', cassa_categoria_id: null, cassa_nome: null }], totali: importi }, error: null }
  const res = await GET(req(`scuola_id=${SC}&format=pdf&raggruppamento=totale`))
  expect(res.status).toBe(500)
  expect(h.buildPdf).not.toHaveBeenCalled()
})


it('PDF identifica la categoria senza movimenti e non accetta categorie di altre sedi', async () => {
  let res = await GET(req(`scuola_id=${SC}&format=pdf&raggruppamento=categoria&categoria_pagamento_id=${CAT_SAGGIO}`))
  expect(res.status).toBe(200)
  expect(h.buildPdf).toHaveBeenCalledWith(expect.objectContaining({ categoriaNome: 'Saggio' }))
  h.buildPdf.mockClear()
  h.categoria = { data: { id: CAT_SAGGIO, nome: 'Saggio altra sede', scuola_id: '33333333-3333-4333-8333-333333333333' }, error: null }
  res = await GET(req(`scuola_id=${SC}&format=pdf&raggruppamento=categoria&categoria_pagamento_id=${CAT_SAGGIO}`))
  expect(res.status).toBe(403)
  expect(h.buildPdf).not.toHaveBeenCalled()
})
