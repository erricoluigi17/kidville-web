import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Caratterizzazione GIUSTIFICA assenza genitore (P1/S0). ──
// Due rami firma: OTP_EMAIL (default) e CONFERMA_APP (OTP disattivato).

const h = vi.hoisted(() => {
  const state = {
    queues: {} as Record<string, Array<{ data: unknown; error: unknown }>>,
    used: {} as Record<string, number>,
    captured: { update: [] as unknown[], insert: [] as unknown[] },
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
        for (const m of ['select', 'eq', 'order', 'limit', 'in']) qb[m] = () => qb
        qb.update = (v: unknown) => { state.captured.update.push(v); return qb }
        qb.insert = (v: unknown) => { state.captured.insert.push(v); return qb }
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
const auth = vi.hoisted(() => ({ getRequestUserId: vi.fn() }))
vi.mock('@/lib/auth/require-staff', () => ({ getRequestUserId: auth.getRequestUserId }))
const otp = vi.hoisted(() => ({ getUserEmail: vi.fn(), verifyTicket: vi.fn(), codeHash: vi.fn() }))
vi.mock('@/lib/auth/otp-ticket', () => otp)
const cfg = vi.hoisted(() => ({ getModuleConfig: vi.fn() }))
vi.mock('@/lib/settings/module-config', () => cfg)

import { POST } from '@/app/api/parent/presenze/giustifica/route'
import { NextRequest } from 'next/server'

const TODAY = new Date().toISOString().slice(0, 10)

function req(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/parent/presenze/giustifica?userId=u-1', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9' },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  h.state.queues = {}
  h.state.used = {}
  h.state.captured = { update: [], insert: [] }
  auth.getRequestUserId.mockReturnValue('u-1')
  otp.getUserEmail.mockResolvedValue('genitore@example.it')
  otp.verifyTicket.mockReturnValue({ ok: true })
  otp.codeHash.mockReturnValue('SHA256-MOCKEDHASH')
  cfg.getModuleConfig.mockResolvedValue({ giustifica_max_giorni_retroattivi: 5, giustifica_richiede_firma_otp: true })
})

describe('POST /api/parent/presenze/giustifica', () => {
  it('401 senza userId', async () => {
    auth.getRequestUserId.mockReturnValue(null)
    const res = await POST(req({ studentId: 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1', data: TODAY }))
    expect(res.status).toBe(401)
  })

  it('400 se mancano studentId/data', async () => {
    const res = await POST(req({ studentId: 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1' }))
    expect(res.status).toBe(400)
  })

  it('404 se alunno non trovato', async () => {
    h.state.queues = { alunni: [{ data: null, error: null }] }
    const res = await POST(req({ studentId: 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1', data: TODAY, code: '1', expiry: 1, ticket: 't' }))
    expect(res.status).toBe(404)
  })

  it('400 se OTP richiesto e non valido', async () => {
    h.state.queues = { alunni: [{ data: { id: 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1', section_id: 'sec-1', scuola_id: 'sc-1' }, error: null }] }
    otp.verifyTicket.mockReturnValue({ ok: false, error: 'Codice non valido' })
    const res = await POST(req({ studentId: 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1', data: TODAY, code: '1', expiry: 1, ticket: 't' }))
    expect(res.status).toBe(400)
  })

  it('403 se non primaria', async () => {
    h.state.queues = {
      alunni: [{ data: { id: 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1', section_id: 'sec-1', scuola_id: 'sc-1' }, error: null }],
      sections: [{ data: { school_type: 'infanzia' }, error: null }],
    }
    const res = await POST(req({ studentId: 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1', data: TODAY, code: '1', expiry: 1, ticket: 't' }))
    expect(res.status).toBe(403)
  })

  it('200 firma OTP_EMAIL con signature_log completo', async () => {
    h.state.queues = {
      alunni: [{ data: { id: 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1', section_id: 'sec-1', scuola_id: 'sc-1' }, error: null }],
      sections: [{ data: { school_type: 'primaria' }, error: null }],
      presenze: [{ data: { id: 'p-1', giustificata: true }, error: null }],
    }
    const res = await POST(req({ studentId: 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1', data: TODAY, motivo: 'malattia', code: '424242', expiry: 999, ticket: 't' }))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    const upd = h.state.captured.update[0] as { giustificazione_firma: Record<string, unknown> }
    expect(upd.giustificazione_firma).toMatchObject({
      method: 'OTP_EMAIL',
      provider: 'Firma OTP via email (FES)',
      email: 'genitore@example.it',
      ip: '203.0.113.9',
      hash: 'SHA256-MOCKEDHASH',
      compliance: 'CAD Art. 20 / DPR 445/2000',
    })
    const audits = h.state.captured.insert as Array<{ evento?: string }>
    expect(audits.some((a) => a.evento === 'signed')).toBe(true)
  })

  it('200 firma CONFERMA_APP quando OTP disattivato dalle impostazioni', async () => {
    cfg.getModuleConfig.mockResolvedValue({ giustifica_max_giorni_retroattivi: 5, giustifica_richiede_firma_otp: false })
    h.state.queues = {
      alunni: [{ data: { id: 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1', section_id: 'sec-1', scuola_id: 'sc-1' }, error: null }],
      sections: [{ data: { school_type: 'primaria' }, error: null }],
      presenze: [{ data: { id: 'p-1', giustificata: true }, error: null }],
    }
    const res = await POST(req({ studentId: 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1', data: TODAY, motivo: 'visita' }))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    const upd = h.state.captured.update[0] as { giustificazione_firma: Record<string, unknown> }
    expect(upd.giustificazione_firma).toMatchObject({ method: 'CONFERMA_APP' })
  })
})
