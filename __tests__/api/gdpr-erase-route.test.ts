import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  logScrittura: vi.fn(),
  alunno: null as Record<string, unknown> | null,
  links: [] as { parent_id: string }[],
  parentChildren: {} as Record<string, { stato: string; anonimizzato_il: string | null }[]>,
  updates: [] as Record<string, unknown>[],
  removed: [] as string[],
  // Bonifica riconciliazione/incassi (D1): pagamenti dell'alunno + righe collegate.
  pagamenti: [] as { id: string }[],
  movConfermati: [] as Record<string, unknown>[],
  movCfMatch: [] as { id: string; suggerimenti?: unknown }[],
  incassiBonificati: [] as { id: string }[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: (table: string) => {
      // Ogni `from()` è un nuovo builder con stato filtri proprio.
      const state: { stato?: string; neqStato?: string } = {}
      const dataFor = () => {
        if (table === 'student_parents') return h.links
        if (table === 'pagamenti') return h.pagamenti
        if (table === 'incassi') return h.incassiBonificati
        if (table === 'riconciliazione_movimenti') {
          if (state.stato === 'confermato') return h.movConfermati
          if (state.neqStato === 'confermato') return h.movCfMatch
          return []
        }
        return []
      }
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = (col: string, val: unknown) => { if (col === 'stato') state.stato = String(val); return b }
      b.is = () => b
      b.neq = (col: string, val: unknown) => { if (col === 'stato') state.neqStato = String(val); return b }
      b.in = () => b
      b.ilike = () => b
      b.maybeSingle = async () => ({ data: table === 'alunni' ? h.alunno : null, error: null })
      b.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: dataFor(), error: null }).then(res)
      b.update = (row: Record<string, unknown>) => { h.updates.push({ table, ...row }); return b }
      return b
    },
    storage: { from: () => ({ remove: async (paths: string[]) => { h.removed.push(...paths); return { error: null } } }) },
  }),
}))

// Conta i figli iscritti di un parent (per la regola "orfano").
vi.mock('@/lib/gdpr/orfano', () => ({
  parentHaAltriFigliIscritti: vi.fn(async (_s: unknown, parentId: string) => {
    const kids = h.parentChildren[parentId] ?? []
    return kids.some((k) => k.stato === 'iscritto' && !k.anonimizzato_il)
  }),
}))

import { POST } from '@/app/api/admin/gdpr/erase/route'

const req = (body: unknown) =>
  new Request('http://localhost/api/admin/gdpr/erase', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })

beforeEach(() => {
  vi.clearAllMocks()
  h.requireStaff.mockResolvedValue({ user: { id: 'dir-1', role: 'admin', scuola_id: 'sc-1' } })
  h.alunno = { id: 'al-1', nome: 'Marco', cognome: 'Rossi', stato: 'non_iscritto', anonimizzato_il: null, documento_path: null, codice_fiscale: null, fiscal_code: null }
  h.links = [{ parent_id: 'p-1' }]
  h.parentChildren = { 'p-1': [] } // orfano
  h.updates = []; h.removed = []
  h.pagamenti = []; h.movConfermati = []; h.movCfMatch = []; h.incassiBonificati = []
})

describe('POST /api/admin/gdpr/erase', () => {
  it('403 senza Direzione', async () => {
    h.requireStaff.mockResolvedValue({ response: NextResponse.json({}, { status: 403 }) })
    expect((await POST(req({ alunno_id: 'al-1', mode: 'dryrun' }))).status).toBe(403)
  })

  it('404 se alunno assente', async () => {
    h.alunno = null
    expect((await POST(req({ alunno_id: 'nope', mode: 'dryrun' }))).status).toBe(404)
  })

  it('rifiuta un alunno ISCRITTO (409)', async () => {
    h.alunno = { ...h.alunno, stato: 'iscritto' }
    expect((await POST(req({ alunno_id: 'al-1', mode: 'dryrun' }))).status).toBe(409)
  })

  it('dryrun: ritorna conteggi senza scrivere', async () => {
    const res = await POST(req({ alunno_id: 'al-1', mode: 'dryrun' }))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.dryrun).toBe(true)
    expect(json.alunno).toBe(1)
    expect(json.parents).toBe(1)
    expect(h.updates).toHaveLength(0)
  })

  it('execute con conferma errata → 400', async () => {
    const res = await POST(req({ alunno_id: 'al-1', mode: 'execute', confirm: 'Rossi Luca' }))
    expect(res.status).toBe(400)
    expect(h.updates).toHaveLength(0)
  })

  it('execute ok: anonimizza alunno + parent orfano + audit', async () => {
    const res = await POST(req({ alunno_id: 'al-1', mode: 'execute', confirm: 'rossi marco' }))
    expect(res.status).toBe(200)
    const upd = h.updates
    expect(upd.some((u) => u.table === 'alunni' && typeof u.nome === 'string' && (u.nome as string).startsWith('CANCELLATO-'))).toBe(true)
    expect(upd.some((u) => u.table === 'parents' && (u.first_name as string)?.startsWith('CANCELLATO-'))).toBe(true)
    expect(h.logScrittura).toHaveBeenCalled()
  })

  it('parent con altro figlio iscritto → NON anonimizzato', async () => {
    h.parentChildren = { 'p-1': [{ stato: 'iscritto', anonimizzato_il: null }] }
    await POST(req({ alunno_id: 'al-1', mode: 'execute', confirm: 'ROSSI MARCO' }))
    expect(h.updates.some((u) => u.table === 'parents')).toBe(false)
    // l'alunno viene comunque anonimizzato
    expect(h.updates.some((u) => u.table === 'alunni')).toBe(true)
  })

  // D1 — l'oblio deve bonificare anche i dati di riconciliazione/incassi collegati:
  // la causale consigliata porta il CF/nome del minore, persistito nei movimenti
  // confermati (causale/controparte/suggerimenti.label) e nella nota dell'incasso.
  it('execute: bonifica movimenti confermati + nota incasso dei pagamenti dell\'alunno', async () => {
    h.pagamenti = [{ id: 'pag-1' }]
    h.movConfermati = [{ id: 'mov-1', suggerimenti: [{ pagamento_id: 'pag-1', score: 1050, label: 'Marco Rossi' }] }]
    h.incassiBonificati = [{ id: 'inc-1' }]
    const res = await POST(req({ alunno_id: 'al-1', mode: 'execute', confirm: 'rossi marco' }))
    expect(res.status).toBe(200)
    // movimento confermato: causale/controparte azzerate + label rimosso dai suggerimenti
    const movUpd = h.updates.find((u) => u.table === 'riconciliazione_movimenti')
    expect(movUpd).toBeTruthy()
    expect(movUpd!.causale).toBeNull()
    expect(movUpd!.controparte).toBeNull()
    const sugg = movUpd!.suggerimenti as Record<string, unknown>[]
    expect('label' in sugg[0]).toBe(false)
    expect(sugg[0]).toMatchObject({ pagamento_id: 'pag-1', score: 1050 })
    // incasso da riconciliazione: nota azzerata
    const incUpd = h.updates.find((u) => u.table === 'incassi')
    expect(incUpd).toBeTruthy()
    expect(incUpd!.note).toBeNull()
    // conteggi riportati nella risposta
    const json = await res.json()
    expect(json.riconciliazione_bonificati).toBe(1)
    expect(json.incassi_bonificati).toBe(1)
  })

  // D1 best-effort — movimenti NON confermati la cui causale contiene il CF dell'alunno.
  it('execute: bonifica best-effort dei movimenti non confermati che citano il CF', async () => {
    h.alunno = { ...h.alunno!, codice_fiscale: 'TSTTST00T00T000T' }
    h.movCfMatch = [{ id: 'mov-2' }, { id: 'mov-3' }]
    const res = await POST(req({ alunno_id: 'al-1', mode: 'execute', confirm: 'rossi marco' }))
    expect(res.status).toBe(200)
    const json = await res.json()
    // 2 movimenti non confermati agganciati per CF → azzerati
    expect(json.riconciliazione_bonificati).toBe(2)
    const movUpd = h.updates.filter((u) => u.table === 'riconciliazione_movimenti')
    expect(movUpd.length).toBeGreaterThanOrEqual(1)
    expect(movUpd.every((u) => u.causale === null && u.controparte === null)).toBe(true)
  })

  // D1 (3d) — movimenti NON confermati agganciati all'alunno tramite i suggerimenti
  // (match per CF/nome all'import): il `label` col nome del minore va rimosso dal JSON.
  it('execute: bonifica i movimenti non confermati agganciati per suggerimenti (scrub del label)', async () => {
    h.pagamenti = [{ id: 'pag-1' }]
    // non confermato, senza CF in causale (nessun 3c), ma i suggerimenti citano il pagamento dell'alunno
    h.movCfMatch = [{ id: 'mov-nc', suggerimenti: [{ pagamento_id: 'pag-1', score: 1000, label: 'Marco Rossi' }] }]
    const res = await POST(req({ alunno_id: 'al-1', mode: 'execute', confirm: 'rossi marco' }))
    expect(res.status).toBe(200)
    const movUpd = h.updates.find((u) => u.table === 'riconciliazione_movimenti')
    expect(movUpd).toBeTruthy()
    expect(movUpd!.causale).toBeNull()
    expect(movUpd!.controparte).toBeNull()
    const sugg = movUpd!.suggerimenti as Record<string, unknown>[]
    expect('label' in sugg[0]).toBe(false)
    expect(sugg[0]).toMatchObject({ pagamento_id: 'pag-1' })
    const json = await res.json()
    expect(json.riconciliazione_bonificati).toBe(1)
  })

  it('execute: nessun pagamento e nessun CF → niente bonifica riconciliazione', async () => {
    const res = await POST(req({ alunno_id: 'al-1', mode: 'execute', confirm: 'rossi marco' }))
    expect(res.status).toBe(200)
    expect(h.updates.some((u) => u.table === 'riconciliazione_movimenti' || u.table === 'incassi')).toBe(false)
    const json = await res.json()
    expect(json.riconciliazione_bonificati).toBe(0)
    expect(json.incassi_bonificati).toBe(0)
  })
})
