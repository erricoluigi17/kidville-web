import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  legame: null as Record<string, unknown> | null,
  alunno: null as Record<string, unknown> | null,
  articoli: [] as Record<string, unknown>[],
  ordini: [] as Record<string, unknown>[],
  cats: [] as Record<string, unknown>[],
  inserts: [] as { table: string; row: unknown }[],
  updates: [] as { table: string; row: unknown }[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireUser: h.requireUser }))
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
      b.maybeSingle = async () => ({
        data: table === 'legame_genitori_alunni' ? h.legame : table === 'alunni' ? h.alunno : null,
        error: null,
      })
      b.single = async () => ({ data: b._last ?? { id: `${table}-x` }, error: null })
      b.insert = (row: unknown) => { h.inserts.push({ table, row }); b._last = { id: `${table}-new`, ...(Array.isArray(row) ? {} : (row as object)) }; return b }
      b.update = (row: unknown) => { h.updates.push({ table, row }); b._op = 'update'; return b }
      b.delete = () => { b._op = 'delete'; return b }
      b.then = (resolve: (v: unknown) => unknown) => {
        if (b._op) return resolve({ data: null, error: null })
        const data =
          table === 'divise_articoli' ? h.articoli :
          table === 'divise_ordini' ? h.ordini :
          table === 'payment_categories' ? h.cats : []
        return resolve({ data, error: null })
      }
      return b
    },
  }),
}))

import { GET, POST } from '@/app/api/parent/divise/route'

const P_URL = 'http://localhost/api/parent/divise'
const post = (body: unknown) =>
  new Request(`${P_URL}?userId=g1`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const AID = '11111111-1111-4111-8111-111111111111' // alunno
const ART = '22222222-2222-4222-8222-222222222222' // articolo

beforeEach(() => {
  vi.clearAllMocks()
  h.requireUser.mockResolvedValue({ user: { id: 'g1', role: 'genitore' } })
  h.legame = { alunno_id: AID }
  h.alunno = { scuola_id: 'sc-1' }
  h.articoli = [{ id: ART, nome: 'Polo', prezzo: 18, taglie: ['S', 'M', 'L'], attivo: true, scuola_id: 'sc-1', descrizione: null }]
  h.ordini = []
  h.cats = [{ id: 'cat-divisa', scuola_id: null }]
  h.inserts = []; h.updates = []
})

describe('GET /api/parent/divise', () => {
  it('401 senza sessione', async () => {
    h.requireUser.mockResolvedValue({ response: NextResponse.json({}, { status: 401 }) })
    expect((await GET(new Request(`${P_URL}?alunno_id=${AID}`))).status).toBe(401)
  })
  it('403 se il bambino non è del genitore', async () => {
    h.legame = null
    expect((await GET(new Request(`${P_URL}?alunno_id=${AID}`))).status).toBe(403)
  })
  it('200 articoli + ordini', async () => {
    const res = await GET(new Request(`${P_URL}?alunno_id=${AID}`))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data.articoli).toHaveLength(1)
  })
})

describe('POST /api/parent/divise', () => {
  it('403 su figlio altrui', async () => {
    h.legame = null
    expect((await POST(post({ alunno_id: AID, righe: [{ articolo_id: ART, taglia: 'M', quantita: 1 }] }))).status).toBe(403)
  })

  it('400 carrello vuoto', async () => {
    expect((await POST(post({ alunno_id: AID, righe: [] }))).status).toBe(400)
  })

  it('400 quantità < 1', async () => {
    expect((await POST(post({ alunno_id: AID, righe: [{ articolo_id: ART, taglia: 'M', quantita: 0 }] }))).status).toBe(400)
  })

  it('400 taglia non disponibile', async () => {
    expect((await POST(post({ alunno_id: AID, righe: [{ articolo_id: ART, taglia: 'XXL', quantita: 1 }] }))).status).toBe(400)
  })

  it('400 articolo di un\'altra scuola', async () => {
    h.articoli = [{ id: ART, nome: 'Polo', prezzo: 18, taglie: ['M'], attivo: true, scuola_id: 'sc-ALTRA', descrizione: null }]
    expect((await POST(post({ alunno_id: AID, righe: [{ articolo_id: ART, taglia: 'M', quantita: 1 }] }))).status).toBe(400)
  })

  it('totale ricalcolato SERVER-SIDE (ignora prezzo dal client)', async () => {
    // il client prova a spacciare un prezzo/totale falso: viene ignorato.
    const res = await POST(post({ alunno_id: AID, importo: 1, righe: [{ articolo_id: ART, taglia: 'M', quantita: 2, prezzo: 1 }] }))
    expect(res.status).toBe(201)
    const ordine = h.inserts.find((i) => i.table === 'divise_ordini')!.row as { totale: number }
    expect(ordine.totale).toBe(36) // 18 × 2
    const righe = h.inserts.find((i) => i.table === 'divise_ordini_righe')!.row as { articolo_nome: string; prezzo_unitario: number }[]
    expect(righe[0]).toMatchObject({ articolo_nome: 'Polo', prezzo_unitario: 18, quantita: 2 })
  })

  it('crea la riga pagamenti (categoria divisa, da_pagare, non obbligatorio) e collega l\'ordine', async () => {
    const res = await POST(post({ alunno_id: AID, righe: [{ articolo_id: ART, taglia: 'M', quantita: 2 }] }))
    expect(res.status).toBe(201)
    const pag = h.inserts.find((i) => i.table === 'pagamenti')!.row as Record<string, unknown>
    expect(pag).toMatchObject({
      alunno_id: AID, scuola_id: 'sc-1', importo: 36, categoria_id: 'cat-divisa',
      tipo: 'singolo', obbligatorio: false, stato: 'da_pagare', creato_da: 'g1',
    })
    expect(String(pag.descrizione)).toContain('Divise:')
    // l'ordine viene collegato al pagamento
    const link = h.updates.find((u) => u.table === 'divise_ordini')!.row as { pagamento_id: string }
    expect(link.pagamento_id).toBe('pagamenti-new')
  })
})
