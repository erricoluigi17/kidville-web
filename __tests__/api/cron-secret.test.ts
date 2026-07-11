import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

// ── M1.9 — Gate service-to-service (x-cron-secret). ──
// Le route invocate dal cron pg_net (migrazioni 20260606/20260611b/20260733/20260741:
// push_dispatch_url, mensa_allergie_url, fattura_sync_url) devono rifiutare con 401
// qualunque chiamata senza header `x-cron-secret` corretto. Regression-lock del gate.

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: vi.fn().mockResolvedValue({}),
  createClient: vi.fn().mockResolvedValue({}),
}))
const auth = vi.hoisted(() => ({ requireStaff: vi.fn() }))
vi.mock('@/lib/auth/require-staff', () => auth)
vi.mock('@/lib/push/web-push', () => ({ sendPush: vi.fn() }))
vi.mock('@/lib/push/enqueue', () => ({ enqueueNotifiche: vi.fn() }))
vi.mock('@/lib/aruba/client', () => ({
  arubaSignin: vi.fn(),
  arubaGetByFilename: vi.fn(),
  resolveArubaCredentials: vi.fn(),
}))
vi.mock('@/lib/aruba/stato', () => ({ mapStatoAruba: vi.fn() }))
vi.mock('@/lib/mensa/server', () => ({ loadResolveOptions: vi.fn(), DEFAULT_SCUOLA: 'kidville' }))
vi.mock('@/lib/mensa/allergie-check', () => ({ controllaAllergie: vi.fn() }))

import { POST as dispatchPOST } from '@/app/api/push/dispatch/route'
import { POST as fatturaSyncPOST } from '@/app/api/pagamenti/fattura/sync/route'
import { POST as allergiePOST } from '@/app/api/mensa/allergie-check/route'
import { POST as sollecitiRunPOST } from '@/app/api/pagamenti/solleciti/run/route'

function req(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { method: 'POST', headers })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('CRON_SECRET', 'test-secret')
  // Senza secret, allergie-check ripiega sul gate staff: qui simuliamo il rifiuto.
  auth.requireStaff.mockResolvedValue({
    response: NextResponse.json({ error: 'Non autenticato' }, { status: 401 }),
  })
})

describe('x-cron-secret — route service-to-service', () => {
  it('push/dispatch: 401 senza header', async () => {
    const res = await dispatchPOST(req('http://localhost/api/push/dispatch'))
    expect(res.status).toBe(401)
  })

  it('push/dispatch: 401 con secret sbagliato', async () => {
    const res = await dispatchPOST(req('http://localhost/api/push/dispatch', { 'x-cron-secret': 'sbagliato' }))
    expect(res.status).toBe(401)
  })

  it('pagamenti/fattura/sync: 401 senza header', async () => {
    const res = await fatturaSyncPOST(req('http://localhost/api/pagamenti/fattura/sync'))
    expect(res.status).toBe(401)
  })

  it('pagamenti/fattura/sync: 401 con secret sbagliato', async () => {
    const res = await fatturaSyncPOST(req('http://localhost/api/pagamenti/fattura/sync', { 'x-cron-secret': 'sbagliato' }))
    expect(res.status).toBe(401)
  })

  it('pagamenti/solleciti/run: 401 senza header', async () => {
    const res = await sollecitiRunPOST(req('http://localhost/api/pagamenti/solleciti/run'))
    expect(res.status).toBe(401)
  })

  it('pagamenti/solleciti/run: 401 con secret sbagliato', async () => {
    const res = await sollecitiRunPOST(req('http://localhost/api/pagamenti/solleciti/run', { 'x-cron-secret': 'sbagliato' }))
    expect(res.status).toBe(401)
  })

  it('mensa/allergie-check: 401 senza secret e senza staff', async () => {
    const res = await allergiePOST(req('http://localhost/api/mensa/allergie-check'))
    expect(res.status).toBe(401)
    expect(auth.requireStaff).toHaveBeenCalled()
  })

  it('mensa/allergie-check: un secret sbagliato NON bypassa il gate staff', async () => {
    const res = await allergiePOST(req('http://localhost/api/mensa/allergie-check', { 'x-cron-secret': 'sbagliato' }))
    expect(res.status).toBe(401)
    expect(auth.requireStaff).toHaveBeenCalled()
  })
})
