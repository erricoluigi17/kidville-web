import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  requireUser: vi.fn(),
  emetti: vi.fn(),
  pag: null as Record<string, unknown> | null,
  fatt: null as Record<string, unknown> | null,
  legame: null as Record<string, unknown> | null,
  fattureList: [] as Record<string, unknown>[],
  storageFile: null as unknown,
  updates: [] as { table: string; row: unknown }[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff, requireUser: h.requireUser }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = () => b
      b.order = () => b
      b.limit = () => b
      b.maybeSingle = async () => ({
        data: table === 'pagamenti' ? h.pag : table === 'fatture_emesse' ? h.fatt : table === 'legame_genitori_alunni' ? h.legame : null,
        error: null,
      })
      b.update = (row: unknown) => ({ eq: async () => { h.updates.push({ table, row }); return { error: null } } })
      b.then = (resolve: (v: unknown) => unknown) => resolve({ data: table === 'fatture_emesse' ? h.fattureList : [], error: null })
      return b
    },
    storage: { from: () => ({ download: async () => ({ data: h.storageFile }) }) },
  }),
}))
vi.mock('@/lib/aruba/emissione', () => ({ emettiFatturaPagamento: h.emetti }))

import { POST, GET } from '@/app/api/pagamenti/fattura/route'
import { GET as LIST } from '@/app/api/pagamenti/fattura/list/route'

const PID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const FID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1'
function post(body: unknown) {
  return new Request('http://localhost/api/pagamenti/fattura', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
}

describe('POST /api/pagamenti/fattura', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.requireStaff.mockResolvedValue({ user: { id: 'staff-1', role: 'segreteria' } })
  })

  it('blocca i non-staff (gate requireStaff)', async () => {
    h.requireStaff.mockResolvedValue({ response: NextResponse.json({ error: 'x' }, { status: 403 }) })
    const res = await POST(post({ pagamento_id: PID }))
    expect(res.status).toBe(403)
    expect(h.emetti).not.toHaveBeenCalled()
  })

  it('400 senza pagamento_id', async () => {
    expect((await POST(post({}))).status).toBe(400)
  })

  it('mappa esito non_configurato → 503', async () => {
    h.emetti.mockResolvedValue({ ok: false, motivo: 'non_configurato', messaggio: 'Aruba non configurata', httpStatus: 503 })
    expect((await POST(post({ pagamento_id: PID }))).status).toBe(503)
  })

  it('esito ok → 200 con numero e id', async () => {
    h.emetti.mockResolvedValue({ ok: true, fatturaStato: 'in_attesa', uploadFileName: 'ITxx_a.xml.p7m', numero: 7 })
    const res = await POST(post({ pagamento_id: PID }))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.data.numero).toBe(7)
  })
})

describe('GET /api/pagamenti/fattura?fattura_id=', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.requireUser.mockResolvedValue({ user: { id: 'staff-1', role: 'segreteria' } })
    h.pag = { id: PID, alunno_id: 'al-1', descrizione: 'Retta', importo: 150, fattura_stato: 'emessa', fattura_pdf_path: null, fattura_aruba_id: 'X', fattura_emessa_il: '2026-01-01', fattura_causale: null, alunni: { nome: 'Mario', cognome: 'Rossi' } }
    h.fatt = { id: FID, numero: 7, causale: 'Retta — quota Mamma', importo: 75, intestatario: { nome: 'Giulia', cognome: 'Farina' }, pdf_path: null, inviata_il: '2026-01-01' }
  })

  it('serve l\'anteprima della singola quota (200 pdf)', async () => {
    const res = await GET(new Request(`http://localhost/api/pagamenti/fattura?pagamento_id=${PID}&fattura_id=${FID}`))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/pdf')
  })

  it('404 se la fattura indicata non esiste', async () => {
    h.fatt = null
    const res = await GET(new Request(`http://localhost/api/pagamenti/fattura?pagamento_id=${PID}&fattura_id=${FID}`))
    expect(res.status).toBe(404)
  })

  it('403 genitore non proprietario del bambino', async () => {
    h.requireUser.mockResolvedValue({ user: { id: 'g1', role: 'genitore' } })
    h.legame = null
    const res = await GET(new Request(`http://localhost/api/pagamenti/fattura?pagamento_id=${PID}&fattura_id=${FID}`))
    expect(res.status).toBe(403)
  })
})

describe('GET /api/pagamenti/fattura/list', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.requireUser.mockResolvedValue({ user: { id: 'staff-1', role: 'segreteria' } })
    h.pag = { id: PID, alunno_id: 'al-1' }
    h.fattureList = [
      { id: 'f1', numero: 10, anno: 2026, quota_label: 'Mamma', quota_adult_id: 'u-mamma', intestatario: { nome: 'Giulia', cognome: 'Farina' }, pdf_path: 'p.pdf', sdi_stato: 7, sdi_stato_label: 'Consegnata' },
      { id: 'f2', numero: 11, anno: 2026, quota_label: 'Papà', quota_adult_id: 'u-papa', intestatario: { nome: 'Marco', cognome: 'Rossi' }, pdf_path: null, sdi_stato: 1, sdi_stato_label: 'Presa in carico' },
    ]
  })

  it('401 senza sessione', async () => {
    h.requireUser.mockResolvedValue({ response: NextResponse.json({}, { status: 401 }) })
    expect((await LIST(new Request(`http://localhost/api/pagamenti/fattura/list?pagamento_id=${PID}`))).status).toBe(401)
  })

  it('400 senza pagamento_id', async () => {
    expect((await LIST(new Request('http://localhost/api/pagamenti/fattura/list'))).status).toBe(400)
  })

  it('403 genitore non proprietario', async () => {
    h.requireUser.mockResolvedValue({ user: { id: 'g1', role: 'genitore' } })
    h.legame = null
    expect((await LIST(new Request(`http://localhost/api/pagamenti/fattura/list?pagamento_id=${PID}`))).status).toBe(403)
  })

  it('200 elenca le fatture (una per quota, con intestatario e pdf_disponibile)', async () => {
    const res = await LIST(new Request(`http://localhost/api/pagamenti/fattura/list?pagamento_id=${PID}`))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data).toHaveLength(2)
    expect(j.data[0]).toMatchObject({ numero: 10, intestatario: 'Giulia Farina', pdf_disponibile: true })
    expect(j.data[1]).toMatchObject({ numero: 11, intestatario: 'Marco Rossi', pdf_disponibile: false })
  })
})
