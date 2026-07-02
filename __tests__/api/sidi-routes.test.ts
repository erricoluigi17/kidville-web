import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  logScrittura: vi.fn(),
  single: {} as Record<string, unknown>,
  list: {} as Record<string, unknown[]>,
  upserts: [] as { table: string; payload: any }[],
}))
vi.mock('@/lib/auth/require-staff', async (orig) => ({ ...(await orig() as object), requireStaff: h.requireStaff }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from(table: string) {
      const q: any = {}
      q.select = () => q
      q.eq = () => q
      q.order = () => q
      q.maybeSingle = async () => ({ data: h.single[table] ?? null, error: null })
      q.then = (r: any) => r({ data: h.list[table] ?? [], error: null })
      q.upsert = async (payload: any) => { h.upserts.push({ table, payload }); return { data: null, error: null } }
      q.update = () => ({ eq: async () => ({ data: null, error: null }) })
      return q
    },
  }),
}))

import { POST as FASE_A } from '@/app/api/admin/sidi/fase-a/route'
import { POST as FREQ } from '@/app/api/admin/sidi/frequentanti/route'
import { GET as SIDI_SETTINGS_GET, PATCH as SIDI_SETTINGS_PATCH } from '@/app/api/admin/settings/sidi/route'

const denied = () => ({ response: NextResponse.json({ error: 'denied' }, { status: 403 }) }) as never
const post = (url: string, body: unknown = {}) => new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

beforeEach(() => {
  vi.clearAllMocks()
  h.single = {}
  h.list = {}
  h.upserts = []
  h.requireStaff.mockResolvedValue({ user: { id: 'dir1', role: 'admin', scuola_id: 'sc1' } })
})

describe('POST /api/admin/sidi/frequentanti', () => {
  it('403 per la segreteria (riservato dirigenza)', async () => {
    h.requireStaff.mockResolvedValue(denied())
    const res = await FREQ(post('http://localhost/api/admin/sidi/frequentanti') as never)
    expect(res.status).toBe(403)
  })

  it('409 se Fase A non è stata inviata', async () => {
    h.single['sidi_sync_state'] = { scuola_id: 'sc1', fase_a_stato: 'non_inviato', frequentanti_stato: 'non_inviato' }
    const res = await FREQ(post('http://localhost/api/admin/sidi/frequentanti') as never)
    expect(res.status).toBe(409)
  })
})

describe('POST /api/admin/sidi/fase-a — boundary gated', () => {
  it('ritorna 503 (accreditamento assente) e persiste lo stato', async () => {
    h.list['sections'] = [{ id: 's1', name: '5A', school_type: 'primaria' }]
    h.list['tempo_scuola'] = []
    h.single['admin_settings'] = { sidi_config: {} }
    const res = await FASE_A(post('http://localhost/api/admin/sidi/fase-a') as never)
    expect(res.status).toBe(503)
    const upsert = h.upserts.find((u) => u.table === 'sidi_sync_state')
    expect(upsert?.payload.fase_a_stato).toBe('errore')
  })
})

describe('/api/admin/settings/sidi — masking', () => {
  it('GET maschera password_ref', async () => {
    h.single['admin_settings'] = { sidi_config: { username: 'u', password_ref: 'SIDI_PW', abilitato: true } }
    const res = await SIDI_SETTINGS_GET(new Request('http://localhost/api/admin/settings/sidi') as never)
    const body = await res.json()
    expect(body.data.password_ref).toBe('••••••')
    expect(body.data.has_password).toBe(true)
  })

  it('PATCH non salva il sentinel mascherato come password_ref', async () => {
    h.single['admin_settings'] = { sidi_config: { password_ref: 'REAL_ENV' } }
    await SIDI_SETTINGS_PATCH(new Request('http://localhost/api/admin/settings/sidi', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password_ref: '••••••', abilitato: true }) }) as never)
    const upsert = h.upserts.find((u) => u.table === 'admin_settings')
    expect(upsert?.payload.sidi_config.password_ref).toBe('REAL_ENV')
    expect(upsert?.payload.sidi_config.abilitato).toBe(true)
  })
})
