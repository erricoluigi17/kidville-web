import { describe, it, expect, vi, beforeEach } from 'vitest'

// Trigger "assenza all'appello" (primaria): notifica SOLO chi DIVENTA assente
// senza assenza comunicata (giustificata/giustificata_da); i ri-salvataggi non
// duplicano; la correzione assente→presente revoca le notifiche pending.

const h = vi.hoisted(() => ({
  presenzePrima: [] as Array<Record<string, unknown>>,
  inserts: [] as Array<Record<string, unknown>>,
  deletes: [] as Array<Record<string, unknown>>,
  /** Guasto sulla sola lettura dei NOMI degli assenti (`select('id, nome')` su `alunni`). */
  nomiInGuasto: false,
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireDocente: vi.fn(async () => ({ user: { id: 'doc-1', role: 'educator', scuola_id: 's1' } })),
}))
vi.mock('@/lib/auth/scope', () => ({
  assertSezioneInScope: vi.fn(async () => null),
  assertAlunniInSezione: vi.fn(async () => null),
}))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: vi.fn(async () => undefined) }))
vi.mock('@/lib/primaria/notifiche', () => ({ notificaTitolariScrittura: vi.fn(async () => undefined) }))

function chain(table: string) {
  const filtri: Record<string, unknown> = {}
  let colonne = ''
  const risolvi = () => {
    if (table === 'presenze') return { data: h.presenzePrima, error: null }
    if (table === 'sections') return { data: { scuola_id: 's1' }, error: null }
    if (table === 'admin_settings') return { data: { notifiche_config: { toggles: {} } }, error: null }
    if (table === 'alunni' && h.nomiInGuasto && colonne === 'id, nome') {
      return { data: null, error: { code: '08006', message: 'connection failure' } }
    }
    if (table === 'alunni') return { data: [{ id: 'a1', nome: 'Sofia' }], error: null }
    // `alunno_id` presente: i genitori si risolvono ora sull'unione
    // runtime+anagrafica, che mappa alunno → genitori.
    if (table === 'legame_genitori_alunni') {
      return { data: [{ alunno_id: 'a1', genitore_id: 'p1' }, ...(h.nomiInGuasto ? [{ alunno_id: A1, genitore_id: 'p1' }] : [])], error: null }
    }
    return { data: [], error: null }
  }
  const b: Record<string, unknown> = {}
  for (const m of ['eq', 'in', 'order', 'limit']) b[m] = () => b
  b.select = (c?: string) => { colonne = c ?? ''; return b }
  b.upsert = () => ({ select: async () => ({ data: [], error: null }) })
  b.insert = async (rows: Record<string, unknown>[]) => { h.inserts.push(...rows); return { error: null } }
  b.delete = () => {
    const d: Record<string, unknown> = {}
    d.eq = (col: string, val: unknown) => { filtri[col] = val; return d }
    d.is = async (col: string, val: unknown) => { filtri[col] = val; h.deletes.push({ table, ...filtri }); return { error: null } }
    return d
  }
  b.maybeSingle = async () => risolvi()
  b.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(risolvi()).then(ok, ko)
  return b
}

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: vi.fn(async () => ({ from: (t: string) => chain(t) })),
}))

import { POST } from '@/app/api/primaria/appello/route'
import { invalidateNotificheConfigCache } from '@/lib/notifiche/config'
import { NextRequest } from 'next/server'

function req(records: Array<Record<string, unknown>>) {
  return new NextRequest('http://test/api/primaria/appello?userId=doc-1', {
    method: 'POST',
    body: JSON.stringify({ sectionId: '11111111-1111-4111-8111-111111111111', data: '2026-07-12', records }),
    headers: { 'Content-Type': 'application/json' },
  })
}

beforeEach(() => {
  h.presenzePrima = []
  h.inserts = []
  h.deletes = []
  h.nomiInGuasto = false
  invalidateNotificheConfigCache()
})

const A1 = '22222222-2222-4222-8222-222222222222'

describe('POST /api/primaria/appello — trigger assenza', () => {
  it('nuovo assente senza comunicazione → notifica al genitore', async () => {
    const res = await POST(req([{ alunnoId: A1, stato: 'assente' }]))
    expect(res.status).toBe(200)
    const notifica = h.inserts.find((r) => r.tipo === 'assenza_non_comunicata')
    expect(notifica).toBeTruthy()
    expect(notifica).toMatchObject({ utente_id: 'p1', entita_tipo: 'presenza' })
  })

  it('assenza già comunicata dal genitore (giustificata) → nessuna notifica', async () => {
    h.presenzePrima = [{ alunno_id: A1, stato: null, giustificata: true, giustificata_da: 'p1' }]
    await POST(req([{ alunnoId: A1, stato: 'assente' }]))
    expect(h.inserts.filter((r) => r.tipo === 'assenza_non_comunicata')).toHaveLength(0)
  })

  it('già assente prima (ri-salvataggio) → nessuna nuova notifica', async () => {
    h.presenzePrima = [{ alunno_id: A1, stato: 'assente' }]
    await POST(req([{ alunnoId: A1, stato: 'assente' }]))
    expect(h.inserts.filter((r) => r.tipo === 'assenza_non_comunicata')).toHaveLength(0)
  })

  // Fase 11 (errori non ignorati): prima un guasto sulla lettura dei NOMI
  // (`{ data: null }`) faceva saltare in silenzio TUTTI gli avvisi di assenza
  // non comunicata — il ciclo girava su `anagrafiche ?? []`. Il nome serve solo
  // al testo: l'avviso parte lo stesso, col ripiego «Tuo figlio».
  it('i nomi non letti (guasto) NON fermano l’avviso: parte per l’assente, col ripiego', async () => {
    h.nomiInGuasto = true
    const res = await POST(req([{ alunnoId: A1, stato: 'assente' }]))
    expect(res.status).toBe(200)
    const notifica = h.inserts.find((r) => r.tipo === 'assenza_non_comunicata')
    expect(notifica).toMatchObject({ utente_id: 'p1', entita_tipo: 'presenza', entita_id: A1 })
    expect(String(notifica?.corpo)).toContain('Tuo figlio')
  })

  it('correzione assente → presente: revoca le notifiche pending', async () => {
    h.presenzePrima = [{ alunno_id: A1, stato: 'assente' }]
    await POST(req([{ alunnoId: A1, stato: 'presente' }]))
    expect(h.inserts.filter((r) => r.tipo === 'assenza_non_comunicata')).toHaveLength(0)
    const revoca = h.deletes.find((d) => d.tipo === 'assenza_non_comunicata')
    expect(revoca).toMatchObject({ entita_id: A1, push_inviata_il: null })
  })
})
