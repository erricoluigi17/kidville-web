import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  requireUser: vi.fn(),
  pag: null as Record<string, unknown> | null,
  legame: null as Record<string, unknown> | null,
  alunno: null as Record<string, unknown> | null,
  incassi: [] as Record<string, unknown>[],
  ricevutaAttiva: null as Record<string, unknown> | null,
  ricevuteSelectErr: null as { code: string; message: string } | null,
  settingsRow: {} as Record<string, unknown>,
  parentReg: null as Record<string, unknown> | null,
  inserts: [] as { table: string; row: Record<string, unknown> }[],
  updates: [] as { table: string; row: Record<string, unknown> }[],
  rpc: vi.fn(),
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff, requireUser: h.requireUser }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    rpc: h.rpc,
    from: (table: string) => {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = () => b
      b.is = () => b
      b.order = () => b
      b.maybeSingle = async () => {
        if (table === 'ricevute_emesse') {
          if (h.ricevuteSelectErr) return { data: null, error: h.ricevuteSelectErr }
          return { data: h.ricevutaAttiva, error: null }
        }
        const map: Record<string, unknown> = {
          pagamenti: h.pag,
          legame_genitori_alunni: h.legame,
          alunni: h.alunno,
          admin_settings: h.settingsRow,
          parents: h.parentReg,
          divise_ordini: null,
          incassi: { id: IID, pagamento_id: PID, importo: 150, metodo: 'bonifico' },
        }
        return { data: map[table] ?? null, error: null }
      }
      b.insert = (row: Record<string, unknown>) => {
        if (table !== 'registro_modifiche') h.inserts.push({ table, row })
        return {
          select: () => ({ single: async () => ({ data: { id: 'ric-1', ...row }, error: null }) }),
          then: (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null }),
        }
      }
      b.update = (row: Record<string, unknown>) => {
        h.updates.push({ table, row })
        return b
      }
      b.delete = () => b
      b.single = async () => ({ data: {}, error: null })
      b.then = (resolve: (v: unknown) => unknown) =>
        resolve({ data: table === 'incassi' ? h.incassi : [], error: null })
      return b
    },
  }),
}))

import { GET } from '@/app/api/pagamenti/ricevuta/route'
import { DELETE } from '@/app/api/pagamenti/incassi/[id]/route'

const PID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const IID = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1'
const req = () => new Request(`http://localhost/api/pagamenti/ricevuta?pagamento_id=${PID}`)

beforeEach(() => {
  vi.clearAllMocks()
  h.inserts = []
  h.updates = []
  h.ricevutaAttiva = null
  h.ricevuteSelectErr = null
  h.requireUser.mockResolvedValue({ user: { id: 'staff-1', role: 'segreteria' } })
  h.requireStaff.mockResolvedValue({ user: { id: 'staff-1', role: 'segreteria' } })
  h.rpc.mockResolvedValue({ data: 7, error: null })
  h.pag = {
    id: PID, descrizione: 'Retta Settembre 2026', importo: 150, importo_pagato: 150,
    stato: 'pagato', scadenza: '2026-09-05', periodo_competenza: '2026-09-01',
    alunno_id: 'al-1', scuola_id: 'sc-1', alunni: { nome: 'Mario', cognome: 'Rossi' },
  }
  h.alunno = { id: 'al-1', nome: 'Mario', cognome: 'Rossi', genitori_separati: false, retta_split_config: null, intestatario_fatture: { tipo: 'adult', adult_id: 'p-1' } }
  h.parentReg = { id: 'p-1', first_name: 'Giulia', last_name: 'Farina', fiscal_code: 'FRNGLI80A41F839K', residence_address: null, residence_city: null, zip_code: null }
  h.incassi = [{ id: 'i1', importo: 150, data_incasso: '2026-09-03', metodo: 'bonifico' }]
  h.settingsRow = { fiscale_config: { denominazione: 'Kidville Giugliano', piva: '01234567890' }, aruba_config: {} }
})

describe('GET /api/pagamenti/ricevuta — emissione numerata', () => {
  it('emette la ricevuta n. dal contatore e la registra (snapshot + tracciabile)', async () => {
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/pdf')
    expect(h.rpc).toHaveBeenCalledWith('prossimo_numero_ricevuta', expect.objectContaining({ p_scuola: 'sc-1' }))
    const ins = h.inserts.find((i) => i.table === 'ricevute_emesse')
    expect(ins).toBeTruthy()
    expect(ins!.row.numero).toBe(7)
    expect(ins!.row.tracciabile).toBe(true)
    expect(ins!.row.metodi).toEqual(['bonifico'])
  })

  it('è idempotente: con ricevuta attiva NON assegna un nuovo numero né inserisce', async () => {
    h.ricevutaAttiva = {
      id: 'ric-old', pagamento_id: PID, scuola_id: 'sc-1', numero: 3, anno: 2026, importo: 150,
      metodi: ['bonifico'], tracciabile: true, bollo: false,
      intestatario: { nome: 'Giulia Farina' }, dati_struttura: { denominazione: 'Kidville' }, creato_il: '2026-09-04T10:00:00Z',
    }
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(h.rpc).not.toHaveBeenCalled()
    expect(h.inserts).toHaveLength(0)
  })

  it('409 se il pagamento non è saldato', async () => {
    h.pag = { ...h.pag!, stato: 'parziale' }
    expect((await GET(req())).status).toBe(409)
  })

  it('403 per il genitore senza legame', async () => {
    h.requireUser.mockResolvedValue({ user: { id: 'g-1', role: 'genitore' } })
    h.legame = null
    expect((await GET(req())).status).toBe(403)
  })

  it('fallback legacy: se il registro non esiste (42P01) serve comunque il PDF di cortesia', async () => {
    h.ricevuteSelectErr = { code: '42P01', message: 'relation "ricevute_emesse" does not exist' }
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/pdf')
    expect(h.rpc).not.toHaveBeenCalled()
    expect(h.inserts).toHaveLength(0)
  })
})

describe('DELETE /api/pagamenti/incassi/[id] — annullo ricevuta su storno', () => {
  it('lo storno annulla (best-effort) la ricevuta attiva del pagamento', async () => {
    h.incassi = [] // non usato qui
    // maybeSingle su incassi: il mock generico ritorna null per tabelle ignote → serve la riga old
    // Contratto Contabilità v2: lo storno esige il motivo (query o body, min 3)
    const res = await DELETE(
      new Request(`http://localhost/api/pagamenti/incassi/${IID}?motivo=storno%20di%20prova`, { method: 'DELETE' }),
      { params: Promise.resolve({ id: IID }) }
    )
    expect(res.status).toBe(200)
    const upd = h.updates.find((u) => u.table === 'ricevute_emesse')
    expect(upd).toBeTruthy()
    expect(upd!.row.annullata_il).toBeTruthy()
    expect(upd!.row.annullo_motivo).toContain('storno')
  })
})
