import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { VERSIONE_TERMINI } from '@/lib/legal/versioni'

// P4/DL-045 — POST /api/parent/onboarding: consensi GDPR obbligatori + (opzionale)
// set password Supabase Auth; marca onboarded_at sul genitore.
// C5 — i Termini di servizio sono ora obbligatori e ogni consenso accettato viene
// registrato (append-only) in consensi_accettazioni con VERSIONE decisa server-side.

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  parent: { id: 'p1', auth_user_id: 'auth-1' } as Record<string, unknown> | null,
  parentNotFound: false,
  updates: [] as Array<Record<string, unknown>>,
  eqCalls: [] as Array<[string, unknown]>,
  pwUpdates: [] as Array<{ uid: string; attrs: unknown }>,
  consensiInserts: [] as Array<Record<string, unknown>>,
  consensiInsertErr: null as unknown,
  parentUpdateErr: null as unknown,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireUser: h.requireUser }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    auth: { admin: { updateUserById: async (uid: string, attrs: unknown) => { h.pwUpdates.push({ uid, attrs }); return { data: {}, error: null } } } },
    from: (table: string) => {
      const b: Record<string, unknown> = {}
      b.update = (row: Record<string, unknown>) => { h.updates.push(row); return b }
      b.eq = (col: string, val: unknown) => { if (table === 'parents') h.eqCalls.push([col, val]); return b }
      b.select = () => b
      b.maybeSingle = async () => ({
        data: h.parentUpdateErr || h.parentNotFound ? null : h.parent,
        error: h.parentUpdateErr,
      })
      b.insert = (rows: Record<string, unknown> | Record<string, unknown>[]) => {
        const arr = Array.isArray(rows) ? rows : [rows]
        if (table === 'consensi_accettazioni') h.consensiInserts.push(...arr)
        return Promise.resolve({ data: null, error: h.consensiInsertErr })
      }
      return b
    },
  }),
}))

import { POST } from '@/app/api/parent/onboarding/route'

const req = (body: unknown) =>
  new Request('http://localhost/api/parent/onboarding', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

beforeEach(() => {
  vi.clearAllMocks()
  h.requireUser.mockResolvedValue({ user: { id: 'p1', role: 'genitore' } })
  h.parent = { id: 'p1', auth_user_id: 'auth-1' }
  h.updates = []; h.eqCalls = []; h.pwUpdates = []; h.consensiInserts = []; h.consensiInsertErr = null; h.parentUpdateErr = null; h.parentNotFound = false
})

describe('POST /api/parent/onboarding', () => {
  it('401 senza identità', async () => {
    h.requireUser.mockResolvedValue({ response: NextResponse.json({}, { status: 401 }) })
    expect((await POST(req({ consensi: { privacy: true, termini: true } }))).status).toBe(401)
  })

  it('422 se manca il consenso privacy', async () => {
    const res = await POST(req({ consensi: { privacy: false, termini: true } }))
    expect(res.status).toBe(422)
    expect((await res.json()).mancanti).toContain('privacy')
  })

  it('422 se mancano i Termini (C5)', async () => {
    const res = await POST(req({ consensi: { privacy: true } }))
    expect(res.status).toBe(422)
    expect((await res.json()).mancanti).toContain('termini')
    // Nessuna prova di consenso registrata se l'onboarding non passa.
    expect(h.consensiInserts).toHaveLength(0)
  })

  it('400 se la password è troppo corta', async () => {
    expect((await POST(req({ consensi: { privacy: true, termini: true }, password: 'abc' }))).status).toBe(400)
  })

  it('200 con consensi: marca onboarded_at + salva consensi_gdpr', async () => {
    const res = await POST(req({ consensi: { privacy: true, termini: true } }))
    expect(res.status).toBe(200)
    expect(h.updates[0]).toHaveProperty('onboarded_at')
    expect(h.updates[0]).toMatchObject({ consensi_gdpr: { privacy: true, termini: true } })
    expect(h.pwUpdates).toHaveLength(0)
  })

  it('registra una riga consensi_accettazioni per ogni consenso, versione SERVER-side non spoofabile', async () => {
    // Il client tenta di iniettare una versione arbitraria: deve essere IGNORATA.
    const res = await POST(req({ consensi: { privacy: true, termini: true }, versione: 'HACKED', accettato_il: '1999-01-01' }))
    expect(res.status).toBe(200)
    const termini = h.consensiInserts.find((r) => r.tipo === 'termini')
    expect(termini).toBeTruthy()
    expect(termini!.versione).toBe(VERSIONE_TERMINI)
    expect(termini!.versione).not.toBe('HACKED')
    expect(termini!.parent_id).toBe('p1')
    // Anche la privacy viene registrata.
    expect(h.consensiInserts.some((r) => r.tipo === 'privacy')).toBe(true)
  })

  it('un consenso a false non viene registrato in consensi_accettazioni', async () => {
    // termini obbligatorio → deve restare true; privacy a false blocca comunque (422),
    // quindi si testa il filtro con un consenso EXTRA facoltativo a false.
    const res = await POST(req({ consensi: { privacy: true, termini: true, marketing: false } }))
    expect(res.status).toBe(200)
    expect(h.consensiInserts.some((r) => r.tipo === 'marketing')).toBe(false)
    expect(h.consensiInserts).toHaveLength(2) // solo privacy + termini
  })

  it('il fallimento dell INSERT prova-consenso NON fa fallire l onboarding', async () => {
    h.consensiInsertErr = { code: 'PGRST205', message: 'table not found' }
    const res = await POST(req({ consensi: { privacy: true, termini: true } }))
    expect(res.status).toBe(200)
    expect((await res.json()).onboarded).toBe(true)
  })

  it('aggiorna parents per auth_user_id, MAI per id (auth.user.id è utenti.id, non parents.id — verificato in produzione: 0 genitori su 46 coincidevano, onboarding non ha mai scritto nulla)', async () => {
    await POST(req({ consensi: { privacy: true, termini: true } }))
    expect(h.eqCalls).toEqual([['auth_user_id', 'p1']])
  })

  it('404 se nessuna riga parents ha questo auth_user_id — non dichiara successo su un update che non ha aggiornato nulla', async () => {
    h.parentNotFound = true
    const res = await POST(req({ consensi: { privacy: true, termini: true } }))
    expect(res.status).toBe(404)
    expect(h.consensiInserts).toHaveLength(0)
  })

  it('500 se l update di parents fallisce (PostgREST {error}) — non dichiara successo (segnalato dal tester log C5)', async () => {
    h.parentUpdateErr = { code: '23505', message: 'conflitto inatteso' }
    const res = await POST(req({ consensi: { privacy: true, termini: true } }))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBeTruthy()
    // Senza il genitore aggiornato non si registra nessuna prova di consenso:
    // altrimenti si avrebbe una riga in consensi_accettazioni senza che
    // consensi_gdpr.termini sia mai stato scritto (403 permanente in chat).
    expect(h.consensiInserts).toHaveLength(0)
  })

  it('aggiorna la password Supabase Auth se fornita e il genitore è bindato', async () => {
    const res = await POST(req({ consensi: { privacy: true, termini: true }, password: 'unaPasswordLunga' }))
    expect(res.status).toBe(200)
    expect(h.pwUpdates[0]).toMatchObject({ uid: 'auth-1' })
  })
})
