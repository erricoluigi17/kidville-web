import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

// M7.4 — /api/admin/presenze/realtime: gate staff, scoping ai plessi,
// contratto { totale, sedi:[{ scuola, presenti, iscritti, classi }] }.

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  scuoleDiUtente: vi.fn(),
  rows: {} as Record<string, Record<string, unknown>[]>,
  filters: [] as { table: string; method: string; args: unknown[] }[],
  /** Il `max_rows` di PostgREST: nessuna risposta porta più righe di così, e nessuna lo dice. */
  MAX_ROWS: 1000,
  /** Se impostato, il `.range(da, …)` di quella tabella risponde `{ error }` (PostgREST non lancia). */
  cadeRange: null as { table: string; da: number } | null,
  logEvento: vi.fn(),
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/auth/scope', () => ({ scuoleDiUtente: h.scuoleDiUtente }))
// Solo `logEvento` è una spia (la riga `cockpit-lettura-parziale`): il resto del logger è quello vero.
vi.mock('@/lib/logging/logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/logging/logger')>()),
  logEvento: h.logEvento,
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from(table: string) {
      const rows = () => h.rows[table] ?? []
      const b: Record<string, unknown> = {
        then: (res: (v: { data: unknown; error: null }) => unknown) =>
          res({ data: rows().slice(0, h.MAX_ROWS), error: null }),
      }
      const track = (method: string) => (...args: unknown[]) => {
        h.filters.push({ table, method, args })
        return b
      }
      b.select = track('select')
      b.in = track('in')
      b.eq = track('eq')
      b.limit = track('limit')
      b.order = track('order')
      // `.range()` chiude la catena di `leggiABlocchi`: la pagina chiesta, mai oltre il tetto.
      b.range = (da: number, a: number) => {
        h.filters.push({ table, method: 'range', args: [da, a] })
        if (h.cadeRange && h.cadeRange.table === table && h.cadeRange.da === da) {
          return Promise.resolve({ data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } })
        }
        return Promise.resolve({ data: rows().slice(da, a + 1).slice(0, h.MAX_ROWS), error: null })
      }
      return b
    },
  }),
}))

import { GET } from '@/app/api/admin/presenze/realtime/route'
import { oggiFiscaleISO } from '@/lib/format/fiscal-date'

const req = () =>
  ({ url: 'http://test/api/admin/presenze/realtime', headers: new Headers() }) as never

beforeEach(() => {
  vi.clearAllMocks()
  h.rows = {}
  h.filters = []
  h.cadeRange = null
  h.requireStaff.mockResolvedValue({ user: { id: 'staff-1', role: 'admin', scuola_id: 'sc-1' } })
  h.scuoleDiUtente.mockResolvedValue(['sc-1'])
})

describe('GET /api/admin/presenze/realtime', () => {
  it('401 quando il gate nega', async () => {
    h.requireStaff.mockResolvedValue({ response: NextResponse.json({}, { status: 401 }) })
    expect((await GET(req())).status).toBe(401)
  })

  it('totale a zero e nessuna sede senza plessi (nessuna query)', async () => {
    h.scuoleDiUtente.mockResolvedValue([])
    const res = await GET(req())
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data).toEqual({
      totale: { presenti: 0, iscritti: 0, assenti: 0, appelli_mancanti: 0 },
      sedi: [],
    })
    expect(h.filters).toHaveLength(0)
  })

  it('200 con il contratto aggregato multi-sede', async () => {
    h.rows['alunni'] = [
      { id: 'al-1', section_id: 'sez-a', scuola_id: 'sc-1' },
      { id: 'al-2', section_id: 'sez-a', scuola_id: 'sc-1' },
    ]
    h.rows['presenze'] = [{ alunno_id: 'al-1', stato: 'presente' }]
    h.rows['sections'] = [{ id: 'sez-a', name: 'Girasoli', scuola_id: 'sc-1' }]
    h.rows['schools'] = [{ id: 'sc-1', nome: 'Kidville Centro' }]
    const res = await GET(req())
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.success).toBe(true)
    expect(j.data.totale).toEqual({ presenti: 1, iscritti: 2, assenti: 0, appelli_mancanti: 0 })
    expect(j.data.sedi).toHaveLength(1)
    expect(j.data.sedi[0]).toMatchObject({ scuola: 'Kidville Centro', presenti: 1, iscritti: 2 })
    expect(j.data.sedi[0].classi[0]).toMatchObject({
      classe: 'Girasoli',
      presenti: 1,
      iscritti: 2,
      appello_fatto: true,
    })
  })

  it('scopa alunni/sections/presenze/schools sui plessi dello staff', async () => {
    await GET(req())
    const inCalls = h.filters.filter((f) => f.method === 'in')
    expect(inCalls.map((f) => f.table).sort()).toEqual(['alunni', 'presenze', 'schools', 'sections'])
    expect(inCalls.find((f) => f.table === 'alunni')?.args).toEqual(['scuola_id', ['sc-1']])
    expect(inCalls.find((f) => f.table === 'presenze')?.args).toEqual(['alunni.scuola_id', ['sc-1']])
    expect(inCalls.find((f) => f.table === 'schools')?.args).toEqual(['id', ['sc-1']])
  })

  it('filtra le presenze sulla data di OGGI, nel fuso dell’istituto', async () => {
    await GET(req())
    const eqPresenze = h.filters.find((f) => f.table === 'presenze' && f.method === 'eq')
    expect(eqPresenze?.args[0]).toBe('data')
    /**
     * ⚠️ `oggiFiscaleISO()` e NON `new Date().toISOString().slice(0,10)`.
     *
     * Questa riga diceva UTC, e il prodotto dice Europe/Rome: fra la mezzanotte
     * e le due italiane sono due giorni DIVERSI, e il test diventava rosso da
     * solo — senza che nessuno avesse toccato una riga. Misurato il 2026-08-09
     * alle 00:06: atteso «2026-08-08» (UTC), ricevuto «2026-08-09» (Roma, che è
     * la risposta giusta). La CI, che quella notte girava a cavallo della
     * mezzanotte, ha bloccato un rilascio per questo.
     *
     * Il difetto è la copia esatta di quello che la rotta dichiara di aver
     * corretto — `route.ts:38`, «`new Date().toISOString()` è UTC, e il runtime
     * gira in UTC: fra le 00:00 e le 02:00…». Il commento c'era, il test lo
     * contraddiceva: una prova che pretende il contrario di ciò che il codice
     * accanto spiega è un allarme che suonerà sempre all'ora sbagliata.
     */
    expect(eqPresenze?.args[1]).toBe(oggiFiscaleISO())
  })

  it('oltre max_rows: TUTTI gli iscritti e TUTTE le presenze, a blocchi ordinati per id, senza `.limit`', async () => {
    const id = (p: string, i: number) => `${p}-${String(i).padStart(4, '0')}`
    h.rows['alunni'] = Array.from({ length: 1500 }, (_, i) => ({ id: id('al', i), section_id: 'sez-a', scuola_id: 'sc-1' }))
    h.rows['presenze'] = Array.from({ length: 1200 }, (_, i) => ({ id: id('pr', i), alunno_id: id('al', i), stato: 'presente' }))
    h.rows['sections'] = [{ id: 'sez-a', name: 'Girasoli', scuola_id: 'sc-1' }]
    h.rows['schools'] = [{ id: 'sc-1', nome: 'Kidville Centro' }]

    const res = await GET(req())
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data.totale).toMatchObject({ iscritti: 1500, presenti: 1200 })
    const ordini = h.filters.filter((f) => f.method === 'order').map((f) => `${f.table}:${String(f.args[0])}`)
    expect(new Set(ordini)).toEqual(new Set(['alunni:id', 'presenze:id']))
    // `.limit(5000)` non serviva: `max_rows` vince su qualunque `limit`.
    expect(h.filters.filter((f) => f.method === 'limit')).toEqual([])
  })

  it('i blocchi di `leggiABlocchi` sono consecutivi e interi: 0-999 e 1000-1999, per ogni tabella letta', async () => {
    h.rows['alunni'] = Array.from({ length: 1500 }, (_, i) => ({ id: `al-${String(i).padStart(4, '0')}`, section_id: 'sez-a', scuola_id: 'sc-1' }))
    h.rows['presenze'] = Array.from({ length: 1200 }, (_, i) => ({ id: `pr-${String(i).padStart(4, '0')}`, alunno_id: `al-${String(i).padStart(4, '0')}`, stato: 'presente' }))
    await GET(req())
    const intervalli = (t: string) => h.filters.filter((f) => f.table === t && f.method === 'range').map((f) => f.args)
    expect(intervalli('alunni')).toEqual([[0, 999], [1000, 1999]])
    expect(intervalli('presenze')).toEqual([[0, 999], [1000, 1999]])
    // Il filtro di sede e quello di giorno viaggiano su OGNI blocco, non solo sul primo.
    expect(h.filters.filter((f) => f.table === 'alunni' && f.method === 'in')).toHaveLength(2)
    expect(h.filters.filter((f) => f.table === 'presenze' && f.method === 'eq')).toHaveLength(2)
  })

  it('gli iscritti sono solo quelli con stato `iscritto`', async () => {
    await GET(req())
    const eqAlunni = h.filters.filter((f) => f.table === 'alunni' && f.method === 'eq').map((f) => f.args)
    expect(eqAlunni).toEqual([['stato', 'iscritto']])
  })

  it('un blocco che cade NON lascia un conteggio parziale: zero iscritti e una riga cockpit-lettura-parziale', async () => {
    h.rows['alunni'] = Array.from({ length: 1500 }, (_, i) => ({ id: `al-${String(i).padStart(4, '0')}`, section_id: 'sez-a', scuola_id: 'sc-1' }))
    h.rows['sections'] = [{ id: 'sez-a', name: 'Girasoli', scuola_id: 'sc-1' }]
    h.rows['schools'] = [{ id: 'sc-1', nome: 'Kidville Centro' }]
    h.cadeRange = { table: 'alunni', da: 1000 } // il SECONDO blocco: il primo (1000 righe) era già arrivato

    const res = await GET(req())
    expect(res.status).toBe(200)
    const j = await res.json()
    // Né 1500 (impossibile) né 1000 (il primo blocco spacciato per l'elenco): la lettura è fallita.
    expect(j.data.totale.iscritti).toBe(0)
    const righe = h.logEvento.mock.calls.filter(([, , campi]) => campi?.esito === 'cockpit-lettura-parziale')
    expect(righe).toHaveLength(1)
    expect(righe[0][0]).toBe('registro')
    expect(righe[0][1]).toBe('error')
    expect(righe[0][2]).toMatchObject({ operazione: 'admin/presenze/realtime:GET', entita_tipo: 'alunni' })
    // L'errore del blocco arriva al log com'è (codice di PostgREST), non inghiottito.
    expect(righe[0][3]).toMatchObject({ code: '57014' })
  })

  it('anche le presenze: un blocco caduto non lascia presenti parziali', async () => {
    h.rows['alunni'] = Array.from({ length: 10 }, (_, i) => ({ id: `al-${i}`, section_id: 'sez-a', scuola_id: 'sc-1' }))
    h.rows['presenze'] = Array.from({ length: 1200 }, (_, i) => ({ id: `pr-${String(i).padStart(4, '0')}`, alunno_id: `al-${i % 10}`, stato: 'presente' }))
    h.rows['sections'] = [{ id: 'sez-a', name: 'Girasoli', scuola_id: 'sc-1' }]
    h.rows['schools'] = [{ id: 'sc-1', nome: 'Kidville Centro' }]
    h.cadeRange = { table: 'presenze', da: 1000 }

    const res = await GET(req())
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data.totale).toMatchObject({ iscritti: 10, presenti: 0 })
    const righe = h.logEvento.mock.calls.filter(([, , campi]) => campi?.esito === 'cockpit-lettura-parziale')
    expect(righe.map(([, , campi]) => campi.entita_tipo)).toEqual(['presenze'])
  })

  it('al tetto dei blocchi la lettura è un guasto che lo dice, con i soli conteggi', async () => {
    // 50.001 iscritti: oltre i 50 blocchi da 1000 che `leggiABlocchi` concede.
    h.rows['alunni'] = Array.from({ length: 50_001 }, (_, i) => ({ id: `al-${i}`, section_id: 'sez-a', scuola_id: 'sc-1' }))
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect((await res.json()).data.totale.iscritti).toBe(0)
    const righe = h.logEvento.mock.calls.filter(([, , campi]) => campi?.esito === 'cockpit-lettura-parziale')
    expect(righe).toHaveLength(1)
    expect(righe[0][2]).toMatchObject({ entita_tipo: 'alunni' })
    expect((righe[0][3] as Error).message).toBe(
      'lettura-troncata: presenze-realtime-alunni oltre 50000 righe (50000 lette in 51 blocchi)',
    )
  })
})
