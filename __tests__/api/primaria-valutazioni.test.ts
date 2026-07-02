import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── P2/Slice 1 — Valutazione in itinere legata a ≥1 obiettivo (DL-015). ──
// Enforcement CONDIZIONALE: se la scuola ha obiettivi configurati per
// (materia, livello) il docente deve collegarne ≥1; altrimenti fallback su
// `argomento` (testo libero) — non rompe le scuole senza obiettivi seminati.

const h = vi.hoisted(() => {
  const state = {
    queues: {} as Record<string, Array<{ data: unknown; error: unknown }>>,
    used: {} as Record<string, number>,
    captured: { insert: [] as unknown[], update: [] as unknown[], upsert: [] as unknown[] },
  }
  function take(table: string) {
    const q = state.queues[table] || []
    const i = state.used[table] ?? 0
    state.used[table] = i + 1
    return q[i] ?? { data: null, error: null }
  }
  function makeClient() {
    return {
      from(table: string) {
        const qb: Record<string, unknown> = {}
        for (const m of ['select', 'eq', 'order', 'limit', 'in', 'not', 'gte', 'lte', 'is', 'neq']) qb[m] = () => qb
        qb.insert = (v: unknown) => { state.captured.insert.push({ table, v }); return qb }
        qb.update = (v: unknown) => { state.captured.update.push({ table, v }); return qb }
        qb.upsert = (v: unknown) => { state.captured.upsert.push({ table, v }); return qb }
        qb.single = () => Promise.resolve(take(table))
        qb.maybeSingle = () => Promise.resolve(take(table))
        qb.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
          Promise.resolve(take(table)).then(res, rej)
        return qb
      },
    }
  }
  return { state, makeClient }
})

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: vi.fn().mockResolvedValue(h.makeClient()),
}))

const authMock = vi.hoisted(() => ({ requireDocente: vi.fn() }))
vi.mock('@/lib/auth/require-staff', () => ({ requireDocente: authMock.requireDocente }))
vi.mock('@/lib/auth/scope', () => ({
  assertSezioneInScope: vi.fn().mockResolvedValue(null),
  assertAlunnoInScope: vi.fn().mockResolvedValue(null),
  assertAlunniInSezione: vi.fn().mockResolvedValue(null),
}))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/lib/audit/valutatore', () => ({
  risolviValutatore: vi.fn().mockResolvedValue({ valutatoreId: 'maestra-1', response: null }),
}))
vi.mock('@/lib/primaria/timelock', () => ({ isOltreScadenza: vi.fn().mockResolvedValue({ locked: false }) }))
vi.mock('@/lib/primaria/giudizio', () => ({ renderGiudizioDescrittivo: vi.fn().mockResolvedValue('Giudizio auto') }))
vi.mock('@/lib/primaria/notifiche', () => ({
  enqueueNotifichePerAlunni: vi.fn().mockResolvedValue(undefined),
  notificaTitolariScrittura: vi.fn().mockResolvedValue(undefined),
}))

import { POST } from '@/app/api/primaria/valutazioni/route'
import { NextRequest } from 'next/server'

function req(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/primaria/valutazioni?userId=doc-1', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

const BASE = {
  alunnoId: 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1', sectionId: '0e20e2e2-0e2e-40e2-8e2e-0e2e2e2e2e21', materiaId: '3a73a73a-3a7a-43a7-8a73-a73a73a73a71',
  modalita: 'sintetico', giudizioSintetico: 'Buono', argomento: 'Le tabelline',
}

beforeEach(() => {
  vi.clearAllMocks()
  h.state.queues = {}
  h.state.used = {}
  h.state.captured = { insert: [], update: [], upsert: [] }
  authMock.requireDocente.mockResolvedValue({
    user: { id: 'doc-1', role: 'educator', scuola_id: 'sc-1' }, response: null,
  })
})

// Materia configurata + valutazione inserita con successo.
function seedMateriaAndInsert() {
  h.state.queues.materie = [{ data: { nome: 'Matematica', codice: 'matematica', scuola_id: 'sc-1', section_id: '0e20e2e2-0e2e-40e2-8e2e-0e2e2e2e2e21' }, error: null }]
  h.state.queues.sections = [{ data: { name: '1A' }, error: null }]
  h.state.queues.valutazioni = [{ data: { id: 'v-1', alunno_id: 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1' }, error: null }]
  h.state.queues.admin_settings = [{ data: { notif_buffer_valutazioni_min: 10 }, error: null }]
}

describe('POST /api/primaria/valutazioni — collegamento obiettivo (DL-015)', () => {
  it('400 se la scuola ha obiettivi per la materia/livello ma non ne colleghi nessuno', async () => {
    seedMateriaAndInsert()
    h.state.queues.obiettivi_apprendimento = [{ data: [{ id: 'o-1' }, { id: 'o-2' }], error: null }]
    const res = await POST(req({ ...BASE })) // niente obiettiviIds
    expect(res.status).toBe(400)
    // Nessuna valutazione inserita (enforcement prima dell'insert).
    expect((h.state.captured.insert as Array<{ table: string }>).some((c) => c.table === 'valutazioni')).toBe(false)
  })

  it('400 se colleghi un obiettivo non configurato per quella materia/livello', async () => {
    seedMateriaAndInsert()
    h.state.queues.obiettivi_apprendimento = [{ data: [{ id: 'o-1' }, { id: 'o-2' }], error: null }]
    const res = await POST(req({ ...BASE, obiettiviIds: ['o-XX'] }))
    expect(res.status).toBe(400)
  })

  it('201 con ≥1 obiettivo valido + righe in valutazione_obiettivi', async () => {
    seedMateriaAndInsert()
    h.state.queues.obiettivi_apprendimento = [{ data: [{ id: 'o-1' }, { id: 'o-2' }], error: null }]
    const res = await POST(req({ ...BASE, obiettiviIds: ['o-1'] }))
    expect(res.status).toBe(201)
    const link = (h.state.captured.insert as Array<{ table: string; v: unknown }>).find((c) => c.table === 'valutazione_obiettivi')
    expect(link).toBeTruthy()
    const rows = link!.v as Array<{ valutazione_id: string; obiettivo_id: string }>
    expect(rows).toEqual(expect.arrayContaining([{ valutazione_id: 'v-1', obiettivo_id: 'o-1' }]))
  })

  it('201 fallback su argomento quando la scuola NON ha obiettivi per quella materia/livello', async () => {
    seedMateriaAndInsert()
    h.state.queues.obiettivi_apprendimento = [{ data: [], error: null }]
    const res = await POST(req({ ...BASE })) // niente obiettiviIds, ma nessun obiettivo configurato
    expect(res.status).toBe(201)
    expect((h.state.captured.insert as Array<{ table: string }>).some((c) => c.table === 'valutazione_obiettivi')).toBe(false)
  })
})
