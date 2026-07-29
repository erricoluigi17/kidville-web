import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

// D1 — Provisioning multi-sede. `schools` è il tenant REALE (FK scuola_id →
// schools); `scuole` è il registry anagrafico. Creare la sede solo in `scuole`
// (comportamento storico) la lasciava fantasma. Il POST provisiona in ENTRAMBI
// con lo STESSO id via RPC `provisiona_sede`, con degrade a doppio insert quando
// la RPC non è deployata (DB E2E → PGRST202). Il PATCH propaga anche a schools.
// GET /api/admin/sedi esclude le sedi disattivate (scuole.attiva=false), fail-open.

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  logScrittura: vi.fn(),
  scuoleDiUtente: vi.fn(),
  rpc: vi.fn(),
  // Spie sul logger: il ramo degradato NON può tacere (AGENTS.md §6).
  logErrore: vi.fn(),
  logEvento: vi.fn(),
  // knobs (risultati per tabella/operazione)
  adminsResult: { data: [{ id: 'admin-1' }, { id: 'admin-2' }], error: null } as { data: unknown; error: unknown },
  schoolsSelect: { data: [] as unknown[], error: null } as { data: unknown; error: unknown },
  scuoleSelect: { data: [] as unknown[], error: null } as { data: unknown; error: unknown },
  scuoleExisting: { data: { id: 'sc-1', config: {} }, error: null } as { data: unknown; error: unknown },
  scuoleUpdate: { data: { id: 'sc-1', nome: 'X' }, error: null } as { data: unknown; error: unknown },
  schoolsInsertError: null as { message: string; code?: string } | null,
  scuoleInsertError: null as { message: string; code?: string } | null,
  adminSettingsInsertError: null as { message: string; code?: string } | null,
  schoolsDeleteError: null as { message: string; code?: string } | null,
  upsertError: null as { message: string; code?: string } | null,
  // recorders
  inserts: [] as { table: string; row: Record<string, unknown> }[],
  updates: [] as { table: string; row: Record<string, unknown> }[],
  upserts: [] as { table: string; row: Record<string, unknown> }[],
  deletes: [] as { table: string; id: unknown }[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@/lib/auth/scope', () => ({ scuoleDiUtente: h.scuoleDiUtente }))
vi.mock('@/lib/logging/logger', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/logging/logger')>()
  return { ...actual, logErrore: h.logErrore, logEvento: h.logEvento }
})
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    rpc: h.rpc,
    from(table: string) {
      const b: Record<string, unknown> = {}
      const self = () => b
      b.select = self; b.eq = self; b.in = self; b.order = self; b.gte = self; b.lte = self; b.limit = self
      // SELECT di lista (awaited direttamente): utenti / schools / scuole.
      b.then = (resolve: (v: { data: unknown; error: unknown }) => unknown) => {
        if (table === 'utenti') return resolve(h.adminsResult)
        if (table === 'schools') return resolve(h.schoolsSelect)
        if (table === 'scuole') return resolve(h.scuoleSelect)
        return resolve({ data: [], error: null })
      }
      b.maybeSingle = async () => (table === 'scuole' ? h.scuoleExisting : { data: null, error: null })
      b.single = async () => (table === 'scuole' ? h.scuoleUpdate : { data: { id: 'x' }, error: null })
      b.insert = async (row: Record<string, unknown>) => {
        h.inserts.push({ table, row })
        if (table === 'schools') return { error: h.schoolsInsertError }
        if (table === 'scuole') return { error: h.scuoleInsertError }
        if (table === 'admin_settings') return { error: h.adminSettingsInsertError }
        return { error: null }
      }
      b.update = (row: Record<string, unknown>) => { h.updates.push({ table, row }); return b }
      b.upsert = async (row: Record<string, unknown>) => { h.upserts.push({ table, row }); return { error: h.upsertError } }
      b.delete = () => ({ eq: async (_c: string, v: unknown) => { h.deletes.push({ table, id: v }); return { error: h.schoolsDeleteError } } })
      return b
    },
  }),
}))

import { POST, PATCH } from '@/app/api/admin/schools/route'
import { GET as GET_SEDI } from '@/app/api/admin/sedi/route'

const reqBody = (body: unknown, method: 'POST' | 'PATCH') =>
  new Request('http://localhost/api/admin/schools', {
    method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
const reqSedi = () => new Request('http://localhost/api/admin/sedi')

beforeEach(() => {
  vi.clearAllMocks()
  h.requireStaff.mockResolvedValue({ user: { id: 'dir-1', role: 'admin', scuola_id: 'sc-1' } })
  h.scuoleDiUtente.mockResolvedValue(['sc-1', 'sc-2'])
  h.rpc.mockResolvedValue({ data: 'sede-uuid-rpc', error: null })
  h.adminsResult = { data: [{ id: 'admin-1' }, { id: 'admin-2' }], error: null }
  h.schoolsSelect = { data: [], error: null }
  h.scuoleSelect = { data: [], error: null }
  h.scuoleExisting = { data: { id: 'sc-1', config: {} }, error: null }
  h.scuoleUpdate = { data: { id: 'sc-1', nome: 'X' }, error: null }
  h.schoolsInsertError = null
  h.scuoleInsertError = null
  h.adminSettingsInsertError = null
  h.schoolsDeleteError = null
  h.upsertError = null
  h.inserts = []; h.updates = []; h.upserts = []; h.deletes = []
})

describe('POST /api/admin/schools — provisioning', () => {
  it('201 via RPC provisiona_sede (crea in schools+scuole + collega admin)', async () => {
    const res = await POST(reqBody({ nome: '  Sede Test ', citta: ' Napoli ', indirizzo: 'Via X' }, 'POST'))
    expect(res.status).toBe(201)
    // La RPC è chiamata con i nomi normalizzati e TUTTI gli admin.
    expect(h.rpc).toHaveBeenCalledWith('provisiona_sede', expect.objectContaining({
      p_nome: 'Sede Test', p_citta: 'Napoli', p_admin_ids: ['admin-1', 'admin-2'],
    }))
    // Via RPC non c'è alcun insert client-side.
    expect(h.inserts).toHaveLength(0)
    expect(await res.json()).toMatchObject({ id: 'sede-uuid-rpc', nome: 'Sede Test', citta: 'Napoli', attiva: true })
    expect(h.logScrittura).toHaveBeenCalled()
  })

  it('degrade PGRST202 → doppio insert schools+scuole con lo STESSO id', async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'function not found' } })
    const res = await POST(reqBody({ nome: 'Sede Nord' }, 'POST'))
    expect(res.status).toBe(201)
    // schools per primo (FK utenti_scuole → schools), poi scuole, stesso id.
    expect(h.inserts[0]?.table).toBe('schools')
    expect(h.inserts[1]?.table).toBe('scuole')
    expect(h.inserts[0]?.row.id).toBe(h.inserts[1]?.row.id)
    const j = await res.json()
    expect(j.id).toBe(h.inserts[0]?.row.id)
    // Fallback collega comunque gli admin in utenti_scuole.
    expect(h.inserts.filter((i) => i.table === 'utenti_scuole')).toHaveLength(2)
  })

  // A3 — Senza la riga `admin_settings` la sede nasce col registro spento:
  // `loadGradoContext` legge `matrice = {}` e `requireFunzione` risponde 403 su
  // TUTTE le funzioni docente (require-grado.ts:36-44 e :64-86).
  it('degrade PGRST202 → crea ANCHE admin_settings, con la matrice funzioni della sede', async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'not found' } })
    const res = await POST(reqBody({ nome: 'Kidville Aversa' }, 'POST'))
    expect(res.status).toBe(201)
    const settings = h.inserts.find((i) => i.table === 'admin_settings')
    expect(settings, 'la riga admin_settings deve essere creata').toBeDefined()
    expect(settings?.row.scuola_id).toBe(h.inserts[0]?.row.id)
    const matrice = settings?.row.funzioni_matrice as Record<string, Record<string, boolean>>
    expect(matrice.primaria?.registro).toBe(true)
    expect(matrice.infanzia?.diario).toBe(true)
    expect(matrice.nido?.appello).toBe(true)
    // A4 — i solleciti automatici nascono SPENTI (scelta esplicita, opt-in dalla UI).
    expect(settings?.row.solleciti_config).toEqual({ enabled: false })
    // Evento critico → si logga anche il SUCCESSO.
    expect(h.logEvento).toHaveBeenCalledWith(
      'multi_sede',
      'info',
      expect.objectContaining({ operazione: 'admin/schools:POST', esito: 'admin-settings-creato' }),
    )
  })

  it.each(['PGRST204', '42703', 'PGRST205', '42P01'])(
    'DB non migrato (%s su admin_settings) → la sede si crea lo stesso, senza 500 e senza gridare',
    async (code) => {
      h.rpc.mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'not found' } })
      h.adminSettingsInsertError = { code, message: 'colonna/tabella assente' }
      const res = await POST(reqBody({ nome: 'Sede CI' }, 'POST'))
      expect(res.status).toBe(201)
      // Degrade previsto: si logga a `info` (spiegando perché è ignorabile), mai `error`.
      expect(h.logEvento).toHaveBeenCalledWith(
        'multi_sede',
        'info',
        expect.objectContaining({ esito: 'admin-settings-non-disponibile' }),
        expect.anything(),
      )
      expect(h.logErrore).not.toHaveBeenCalled()
    },
  )

  it('errore VERO su admin_settings → sede creata (201) ma il guasto è gridato a error', async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'not found' } })
    h.adminSettingsInsertError = { code: '23503', message: 'violates foreign key constraint' }
    const res = await POST(reqBody({ nome: 'Sede Rotta' }, 'POST'))
    // La sede esiste già in schools+scuole: un 500 qui inviterebbe a un retry che
    // creerebbe una SECONDA sede. Si risponde 201 e si grida nel log.
    expect(res.status).toBe(201)
    expect(h.logEvento).toHaveBeenCalledWith(
      'multi_sede',
      'error',
      expect.objectContaining({ esito: 'admin-settings-fallito' }),
      expect.anything(),
    )
  })

  it('degrade: insert scuole fallito → cleanup della riga schools + 500', async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'not found' } })
    h.scuoleInsertError = { message: 'boom', code: '23505' }
    const res = await POST(reqBody({ nome: 'Sede Rotta' }, 'POST'))
    expect(res.status).toBe(500)
    // La riga schools creata per prima va rimossa (non transazionale).
    expect(h.deletes).toHaveLength(1)
    expect(h.deletes[0]?.table).toBe('schools')
    expect(h.deletes[0]?.id).toBe(h.inserts[0]?.row.id)
  })

  it('403 senza Direzione', async () => {
    h.requireStaff.mockResolvedValue({ response: NextResponse.json({}, { status: 403 }) })
    expect((await POST(reqBody({ nome: 'X' }, 'POST'))).status).toBe(403)
  })
})

describe('PATCH /api/admin/schools — propagazione a schools', () => {
  it('200: propaga nome/citta/indirizzo anche su schools (upsert)', async () => {
    const res = await PATCH(reqBody({ id: 'sc-1', nome: 'Kidville Centro', citta: 'Napoli' }, 'PATCH'))
    expect(res.status).toBe(200)
    expect(h.upserts).toHaveLength(1)
    expect(h.upserts[0]?.table).toBe('schools')
    expect(h.upserts[0]?.row).toMatchObject({ id: 'sc-1', nome: 'Kidville Centro', citta: 'Napoli' })
    expect(h.logScrittura).toHaveBeenCalled()
  })

  it('200: senza campi anagrafici non tocca schools', async () => {
    const res = await PATCH(reqBody({ id: 'sc-1', attiva: false }, 'PATCH'))
    expect(res.status).toBe(200)
    expect(h.upserts).toHaveLength(0)
  })
})

describe('GET /api/admin/sedi — esclusione sedi disattivate', () => {
  it('esclude le sedi con scuole.attiva=false', async () => {
    h.schoolsSelect = { data: [{ id: 'sc-1', nome: 'A' }, { id: 'sc-2', nome: 'B' }], error: null }
    h.scuoleSelect = { data: [{ id: 'sc-1', attiva: true }, { id: 'sc-2', attiva: false }], error: null }
    const res = await GET_SEDI(reqSedi() as never)
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data).toHaveLength(1)
    expect(j.data[0].id).toBe('sc-1')
  })

  it('fail-open: se la lettura del flag attiva fallisce, NON filtra', async () => {
    h.schoolsSelect = { data: [{ id: 'sc-1', nome: 'A' }, { id: 'sc-2', nome: 'B' }], error: null }
    h.scuoleSelect = { data: null, error: { message: 'errore transitorio' } }
    const res = await GET_SEDI(reqSedi() as never)
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data).toHaveLength(2)
  })
})
