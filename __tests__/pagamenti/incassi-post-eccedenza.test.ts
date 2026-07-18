import { it, expect, vi, beforeEach, describe } from 'vitest'

// POST /api/pagamenti/incassi — regole Contabilità v2 (slice S3):
//  (d) incasso oltre il residuo effettivo → 409 con { eccedenza } (voce NON rata);
//  (e) con conferma_eccedenza=credito_famiglia + pagante → incassa il residuo e
//      accredita l'eccedenza in crediti_famiglia;
//  (f) abbuono → pagamenti.sconto = residuo − incassato (voce saldata);
//  (g) degradazione: PGRST204 sull'UPDATE sconto (abbuono) → warn e flusso invariato.
const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  spill: vi.fn(),
  notifica: vi.fn(),
  accredita: vi.fn(),
  disponibile: vi.fn(),
  saldo: vi.fn(),
  resolveParent: vi.fn(),
  pag: {} as Record<string, unknown>,
  pagSelectErr: null as { code: string } | null,
  inserts: [] as { table: string; row: unknown }[],
  updates: [] as { table: string; row: unknown }[],
  updateErr: {} as Record<string, { code: string } | undefined>,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/pagamenti/spill', () => ({ applyOverpaymentSpill: (...a: unknown[]) => h.spill(...a) }))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: (...a: unknown[]) => h.notifica(...a) }))
vi.mock('@/lib/pagamenti/credito', () => ({
  accreditaEccedenza: (...a: unknown[]) => h.accredita(...a),
  creditoDisponibile: (...a: unknown[]) => h.disponibile(...a),
  saldoCredito: (...a: unknown[]) => h.saldo(...a),
}))
vi.mock('@/lib/pagamenti/intestatari', () => ({ resolveParentRegistry: (...a: unknown[]) => h.resolveParent(...a) }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    rpc: async () => ({ data: null, error: null }),
    from: (table: string) => {
      const b: Record<string, unknown> & { _op?: string } = {}
      b.select = () => b
      b.eq = () => b
      b.order = () => b
      b.limit = () => b
      b.maybeSingle = async () => {
        if (table === 'pagamenti') return { data: h.pag, error: h.pagSelectErr }
        return { data: null, error: null }
      }
      b.single = async () => {
        if (h.updateErr[table]) return { data: null, error: h.updateErr[table] }
        return { data: { id: `${table}-new`, ...(b._op === 'insert' && !Array.isArray(b._row) ? (b._row as object) : {}) }, error: null }
      }
      b.insert = (row: unknown) => { h.inserts.push({ table, row }); b._op = 'insert'; ;(b as { _row?: unknown })._row = row; return b }
      b.update = (row: unknown) => { h.updates.push({ table, row }); b._op = 'update'; return b }
      b.then = (resolve: (v: unknown) => unknown) => resolve({ data: null, error: h.updateErr[table] ?? null })
      return b
    },
  }),
}))

import { POST } from '@/app/api/pagamenti/incassi/route'

const URL = 'http://localhost/api/pagamenti/incassi'
const PID = '11111111-1111-4111-8111-111111111111'
const PARENT = '33333333-3333-4333-8333-333333333333'
const post = (body: unknown) =>
  new Request(URL, { method: 'POST', headers: { 'content-type': 'application/json', 'x-user-id': 'seg-1' }, body: JSON.stringify(body) })

beforeEach(() => {
  vi.clearAllMocks()
  h.requireStaff.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: 'sc-1' } })
  h.spill.mockResolvedValue([])
  h.notifica.mockResolvedValue(undefined)
  h.disponibile.mockResolvedValue(true)
  h.accredita.mockResolvedValue({ ok: true, saldoDopo: 50, id: 'cf-1' })
  h.resolveParent.mockResolvedValue({ id: PARENT })
  // voce da 100€, nessun incasso, nessuno sconto, NON è una rata (parent_payment_id null)
  h.pag = { id: PID, importo: 100, importo_pagato: 0, sconto: 0, parent_payment_id: null, alunno_id: 'al-1', scuola_id: 'sc-1', descrizione: 'Retta' }
  h.pagSelectErr = null
  h.inserts = []; h.updates = []; h.updateErr = {}
})

describe('POST incassi — eccedenza e abbuono', () => {
  it('(d) incasso 150 su residuo 100 (voce non-rata) → 409 con eccedenza 50', async () => {
    const res = await POST(post({ pagamento_id: PID, importo: 150 }))
    expect(res.status).toBe(409)
    const j = await res.json()
    expect(j.eccedenza).toBe(50)
    // nessun incasso registrato: l'eccedenza non passa in silenzio
    expect(h.inserts.find((i) => i.table === 'incassi')).toBeUndefined()
  })

  it('(e) incasso 150 con conferma_eccedenza+pagante → incassa il residuo 100 e accredita 50', async () => {
    const res = await POST(post({ pagamento_id: PID, importo: 150, conferma_eccedenza: 'credito_famiglia', pagante_parent_id: PARENT }))
    expect(res.status).toBe(201)
    const inc = h.inserts.find((i) => i.table === 'incassi')!.row as { importo: number }
    expect(inc.importo).toBe(100) // solo il residuo
    expect(h.accredita).toHaveBeenCalledTimes(1)
    const arg = h.accredita.mock.calls[0][1] as { importo: number; parentId: string }
    expect(arg.importo).toBe(50)
    expect(arg.parentId).toBe(PARENT)
  })

  it('(e-bis) credito non disponibile su questo DB → 503 e NESSUN incasso scritto', async () => {
    h.disponibile.mockResolvedValue(false)
    const res = await POST(post({ pagamento_id: PID, importo: 150, conferma_eccedenza: 'credito_famiglia', pagante_parent_id: PARENT }))
    expect(res.status).toBe(503)
    expect(h.inserts.find((i) => i.table === 'incassi')).toBeUndefined()
    expect(h.accredita).not.toHaveBeenCalled()
  })

  it('(f) abbuono su incasso 70/residuo 100 → sconto = 30 e voce saldata', async () => {
    const res = await POST(post({ pagamento_id: PID, importo: 70, abbuono: { motivo: 'Sconto famiglia' } }))
    expect(res.status).toBe(201)
    const inc = h.inserts.find((i) => i.table === 'incassi')!.row as { importo: number }
    expect(inc.importo).toBe(70)
    const upd = h.updates.find((u) => u.table === 'pagamenti')!.row as { sconto: number; sconto_motivo: string }
    expect(upd.sconto).toBe(30)
    expect(upd.sconto_motivo).toBe('Sconto famiglia')
  })

  it('(g) abbuono su DB non migrato (PGRST204 sull\'update sconto) → 201, flusso base invariato', async () => {
    h.updateErr.pagamenti = { code: 'PGRST204' }
    const res = await POST(post({ pagamento_id: PID, importo: 70, abbuono: { motivo: 'Sconto famiglia' } }))
    expect(res.status).toBe(201)
    // l'incasso base c'è comunque
    const inc = h.inserts.find((i) => i.table === 'incassi')!.row as { importo: number }
    expect(inc.importo).toBe(70)
  })

  it('incasso entro il residuo (80/100) → 201 senza 409, nessun accredito', async () => {
    const res = await POST(post({ pagamento_id: PID, importo: 80 }))
    expect(res.status).toBe(201)
    expect(h.accredita).not.toHaveBeenCalled()
  })
})
