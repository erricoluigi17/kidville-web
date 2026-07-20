import { it, expect, vi, beforeEach, describe } from 'vitest'
import { NextResponse, NextRequest } from 'next/server'
import type { SaldoCassa } from '@/lib/cassa/tipi'

// ── Saldo cassa (E2.3) ────────────────────────────────────────────────────────
// Gate SOLO admin (requireStaff(request, ['admin']) — NON esiste requireAdmin):
// 403 per la segreteria, 401 senza identità. Legge il fondo da cassa_config,
// delega a caricaSaldoCassa (che degrada a { disponibile:false } su schema assente)
// e verifica la soglia best-effort a valle.

const SC = 'd53b0fbc-a9eb-4073-b302-73d1d5abd529'

const h = vi.hoisted(() => ({
  authenticated: true,
  role: 'admin' as string,
  scuola: vi.fn(),
  config: {} as Record<string, unknown>,
  saldo: null as unknown,
  verificaSoglia: vi.fn(),
  logErrore: vi.fn(),
  logEvento: vi.fn(),
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireStaff: (_req: unknown, allowed: string[] = ['admin', 'coordinator', 'segreteria']) => {
    if (!h.authenticated) return Promise.resolve({ response: NextResponse.json({ error: 'x' }, { status: 401 }) })
    if (!allowed.includes(h.role)) return Promise.resolve({ response: NextResponse.json({ error: 'x' }, { status: 403 }) })
    return Promise.resolve({ user: { id: 'a1', role: h.role, scuola_id: SC } })
  },
}))
vi.mock('@/lib/auth/scope', () => ({ resolveScuolaScrittura: (...a: unknown[]) => h.scuola(...a) }))
vi.mock('@/lib/settings/module-config', () => ({ getModuleConfig: () => Promise.resolve(h.config) }))
vi.mock('@/lib/cassa/saldo', () => ({
  caricaSaldoCassa: () => Promise.resolve(h.saldo),
  CASSA_SCHEMA_ASSENTE: new Set(['42P01', '42703', 'PGRST202', 'PGRST204', 'PGRST205']),
  caricaEntratoOggi: () => Promise.resolve([]),
}))
vi.mock('@/lib/cassa/notifiche', () => ({ verificaSogliaCassa: (...a: unknown[]) => h.verificaSoglia(...a) }))
vi.mock('@/lib/logging/logger', () => ({
  logErrore: (...a: unknown[]) => h.logErrore(...a),
  logEvento: (...a: unknown[]) => h.logEvento(...a),
  logOk: () => {},
}))
vi.mock('@/lib/supabase/server-client', () => ({ createAdminClient: async () => ({}) }))

import { GET } from '@/app/api/pagamenti/cassa/saldo/route'

const get = () => new NextRequest(`http://localhost/api/pagamenti/cassa/saldo?scuola_id=${SC}`, { headers: { 'x-user-id': 'a1' } })

const saldoPieno: SaldoCassa = {
  disponibile: true,
  fondo: 100,
  saldo_atteso: 130,
  entrate_contanti: 50,
  uscite_contanti: 20,
  prelievi: 0,
  rettifiche: 0,
  entrato_oggi: [{ metodo: 'contanti', totale: 50 }],
}

beforeEach(() => {
  vi.clearAllMocks()
  h.authenticated = true
  h.role = 'admin'
  h.scuola.mockResolvedValue({ scuolaId: SC })
  h.config = { fondo: 100 }
  h.saldo = saldoPieno
})

describe('GET /api/pagamenti/cassa/saldo', () => {
  it('403 per la segreteria (gate solo admin)', async () => {
    h.role = 'segreteria'
    const res = await GET(get())
    expect(res.status).toBe(403)
  })

  it('401 senza identità', async () => {
    h.authenticated = false
    const res = await GET(get())
    expect(res.status).toBe(401)
  })

  it('schema assente → 200 { disponibile:false }', async () => {
    h.saldo = { disponibile: false }
    const res = await GET(get())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.disponibile).toBe(false)
  })

  it('con dati → shape SaldoCassa completa di entrato_oggi', async () => {
    const res = await GET(get())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.disponibile).toBe(true)
    expect(body.saldo_atteso).toBe(130)
    expect(body.fondo).toBe(100)
    expect(Array.isArray(body.entrato_oggi)).toBe(true)
    expect(body.entrato_oggi[0]).toEqual({ metodo: 'contanti', totale: 50 })
  })

  it('verifica la soglia best-effort a valle', async () => {
    await GET(get())
    expect(h.verificaSoglia).toHaveBeenCalledWith(expect.anything(), SC)
  })
})
