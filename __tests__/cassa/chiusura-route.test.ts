import { it, expect, vi, beforeEach, describe } from 'vitest'
import { NextResponse, NextRequest } from 'next/server'
import type { SaldoCassa } from '@/lib/cassa/tipi'

// ── Chiusura / svuotamento cassa (E2.4) ───────────────────────────────────────
// Gate SOLO admin su GET e POST. La POST calcola il saldo atteso SERVER-side (il
// client manda solo il contato) e chiama rpc('registra_chiusura_cassa', …). RPC
// assente (PGRST202) → 503 { disponibile:false }. Contato 128 su atteso 130 e
// fondo 100 → differenza −2, prelievo 28, fondo lasciato 100.

const SC = 'd53b0fbc-a9eb-4073-b302-73d1d5abd529'

const h = vi.hoisted(() => ({
  role: 'admin' as string,
  scuola: vi.fn(),
  config: {} as Record<string, unknown>,
  saldo: null as unknown,
  rpc: { data: null as unknown, error: null as unknown },
  rpcCalls: [] as { name: string; args: unknown }[],
  chiusure: { data: null as unknown, error: null as unknown },
  audits: [] as unknown[],
  verificaSoglia: vi.fn(),
  logErrore: vi.fn(),
  logEvento: vi.fn(),
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireStaff: (_req: unknown, allowed: string[] = ['admin', 'coordinator', 'segreteria']) => {
    if (!allowed.includes(h.role)) return Promise.resolve({ response: NextResponse.json({ error: 'x' }, { status: 403 }) })
    return Promise.resolve({ user: { id: 'a1', role: h.role, scuola_id: SC } })
  },
}))
vi.mock('@/lib/auth/scope', () => ({ resolveScuolaScrittura: (...a: unknown[]) => h.scuola(...a) }))
vi.mock('@/lib/settings/module-config', () => ({ getModuleConfig: () => Promise.resolve(h.config) }))
vi.mock('@/lib/cassa/saldo', () => ({
  caricaSaldoCassa: () => Promise.resolve(h.saldo),
  CASSA_SCHEMA_ASSENTE: new Set(['42P01', '42703', 'PGRST202', 'PGRST204', 'PGRST205']),
}))
vi.mock('@/lib/cassa/notifiche', () => ({ verificaSogliaCassa: (...a: unknown[]) => h.verificaSoglia(...a) }))
vi.mock('@/lib/logging/logger', () => ({
  logErrore: (...a: unknown[]) => h.logErrore(...a),
  logEvento: (...a: unknown[]) => h.logEvento(...a),
  logOk: () => {},
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    rpc: (name: string, args: unknown) => {
      h.rpcCalls.push({ name, args })
      return Promise.resolve(h.rpc)
    },
    from: (table: string) => {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = () => b
      b.order = () => b
      b.insert = (row: unknown) => { h.audits.push(row); return b }
      b.then = (resolve: (v: unknown) => unknown) =>
        resolve(table === 'cassa_chiusure' ? h.chiusure : { data: null, error: null })
      return b
    },
  }),
}))

import { GET, POST } from '@/app/api/pagamenti/cassa/chiusura/route'

const saldoPieno: SaldoCassa = {
  disponibile: true, fondo: 100, saldo_atteso: 130, entrate_contanti: 50,
  uscite_contanti: 20, prelievi: 0, rettifiche: 0, entrato_oggi: [],
}

const get = () => new NextRequest(`http://localhost/api/pagamenti/cassa/chiusura?scuola_id=${SC}`, { headers: { 'x-user-id': 'a1' } })
const post = (body: unknown) => new NextRequest('http://localhost/api/pagamenti/cassa/chiusura', { method: 'POST', headers: { 'content-type': 'application/json', 'x-user-id': 'a1' }, body: JSON.stringify(body) })

beforeEach(() => {
  vi.clearAllMocks()
  h.role = 'admin'
  h.scuola.mockResolvedValue({ scuolaId: SC })
  h.config = { fondo: 100 }
  h.saldo = saldoPieno
  h.rpc = { data: { chiusura_id: 'ch-1', differenza: -2, prelevato: 28 }, error: null }
  h.rpcCalls = []
  h.chiusure = { data: [], error: null }
  h.audits = []
})

describe('gate solo admin', () => {
  it('GET come segreteria → 403', async () => {
    h.role = 'segreteria'
    const res = await GET(get())
    expect(res.status).toBe(403)
  })
  it('POST come segreteria → 403', async () => {
    h.role = 'segreteria'
    const res = await POST(post({ scuola_id: SC, contato: 128 }))
    expect(res.status).toBe(403)
  })
})

describe('POST — chiusura', () => {
  it('calcola il saldo atteso SERVER-side e chiama la RPC (mai fidarsi del client)', async () => {
    const res = await POST(post({ scuola_id: SC, contato: 128, saldo_atteso: 999 }))
    expect(res.status).toBe(201)
    const call = h.rpcCalls.find((c) => c.name === 'registra_chiusura_cassa')!
    const args = call.args as Record<string, number>
    // Il saldo atteso è quello calcolato dal server (130), NON i 999 spediti dal client.
    expect(args.p_saldo_atteso).toBe(130)
    expect(args.p_contato).toBe(128)
    expect(args.p_fondo).toBe(100)
  })

  it('risposta 201 con differenza/prelevato/fondo_lasciato coerenti', async () => {
    const res = await POST(post({ scuola_id: SC, contato: 128 }))
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.chiusura_id).toBe('ch-1')
    expect(body.saldo_atteso).toBe(130)
    expect(body.contato).toBe(128)
    expect(body.differenza).toBe(-2)
    expect(body.prelevato).toBe(28)
    expect(body.fondo_lasciato).toBe(100)
  })

  it('saldo non disponibile (schema assente) → 503 { disponibile:false }', async () => {
    h.saldo = { disponibile: false }
    const res = await POST(post({ scuola_id: SC, contato: 128 }))
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.disponibile).toBe(false)
  })

  it('RPC assente (PGRST202) → 503 { disponibile:false }', async () => {
    h.rpc = { data: null, error: { code: 'PGRST202', message: 'function not found' } }
    const res = await POST(post({ scuola_id: SC, contato: 128 }))
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.disponibile).toBe(false)
  })

  it('logga il successo e verifica la soglia a valle', async () => {
    await POST(post({ scuola_id: SC, contato: 128 }))
    expect(h.logEvento).toHaveBeenCalledWith('cassa', 'info', expect.objectContaining({ esito: 'eseguita' }))
    expect(h.verificaSoglia).toHaveBeenCalledWith(expect.anything(), SC)
  })
})

describe('GET — storico chiusure', () => {
  it('ritorna { disponibile:true, chiusure }', async () => {
    h.chiusure = { data: [{ id: 'ch-1', saldo_atteso: 130, contato: 128 }], error: null }
    const res = await GET(get())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.disponibile).toBe(true)
    expect(body.chiusure).toHaveLength(1)
  })
  it('schema assente (42P01) → 200 { disponibile:false, chiusure:[] }', async () => {
    h.chiusure = { data: null, error: { code: '42P01', message: 'relation does not exist' } }
    const res = await GET(get())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.disponibile).toBe(false)
    expect(body.chiusure).toEqual([])
  })
})
