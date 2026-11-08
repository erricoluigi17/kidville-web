import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * `anno_attivo` (il cookie con cui Direzione e segreteria scelgono l'anno) segue la stessa regola
 * di `sedi_attive`: lo azzera il server, nella stessa risposta che cambia la veste, quando la
 * veste nuova non è di cockpit; non lo azzera la veste admin (il login passa di qui ogni mattina);
 * lo azzera il logout.
 */

const h = vi.hoisted(() => ({
  identity: { userId: 'u-1', source: 'session' } as { userId: string | null; source: string | null },
  profili: [
    { ruolo: 'segreteria', area: 'admin' },
    { ruolo: 'genitore', area: 'parent' },
  ] as { ruolo: string; area: string }[] | null,
  appUser: { id: 'u-1', role: 'segreteria' } as { id: string; role: string } | null,
}))

vi.mock('@/lib/auth/require-staff', () => ({
  resolveIdentity: vi.fn(async () => h.identity),
  loadAppUser: vi.fn(async () => h.appUser),
}))
vi.mock('@/lib/auth/profili', () => ({
  getSessionProfili: vi.fn(async () => (h.profili ? { authUid: 'u-1', profili: h.profili } : null)),
}))

import { POST } from '@/app/api/auth/active-role/route'
import { POST as logout } from '@/app/api/auth/logout/route'

const ANNO = 'a2222222-2222-4222-8222-222222222222'

function req(body: unknown, cookie?: string) {
  return new Request('http://localhost/api/auth/active-role', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  })
}

function cookies(res: Response): string[] {
  const getSet = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie
  if (typeof getSet === 'function') return getSet.call(res.headers)
  return (res.headers.get('set-cookie') ?? '').split(/,(?=[^;]+=)/).map((s) => s.trim())
}

function cancella(res: Response, nome: string): string | undefined {
  return cookies(res).find((c) => c.startsWith(`${nome}=`) && /max-age=0/i.test(c))
}

beforeEach(() => {
  h.identity = { userId: 'u-1', source: 'session' }
  h.profili = [
    { ruolo: 'segreteria', area: 'admin' },
    { ruolo: 'genitore', area: 'parent' },
    { ruolo: 'educator', area: 'teacher' },
  ]
  h.appUser = { id: 'u-1', role: 'segreteria' }
})

describe('POST /api/auth/active-role — anno_attivo', () => {
  it('veste di FAMIGLIA: azzera anno_attivo accanto a sedi_attive', async () => {
    const res = await POST(req({ ruolo: 'genitore' }, `anno_attivo=${ANNO}; sedi_attive=x`))
    expect(res.status).toBe(200)
    const riga = cancella(res, 'anno_attivo')
    expect(riga).toBeDefined()
    expect(riga).toMatch(/path=\//i)
    expect(cancella(res, 'sedi_attive')).toBeDefined()
  })

  it('veste di DOCENTE: lo azzera', async () => {
    const res = await POST(req({ ruolo: 'educator' }, `anno_attivo=${ANNO}`))
    expect(res.status).toBe(200)
    expect(cancella(res, 'anno_attivo')).toBeDefined()
  })

  it("veste di COCKPIT: NON lo azzera (o ogni login tornerebbe sull'anno attivo)", async () => {
    const res = await POST(req({ ruolo: 'segreteria' }, `anno_attivo=${ANNO}`))
    expect(res.status).toBe(200)
    expect(cancella(res, 'anno_attivo')).toBeUndefined()
  })

  it('403: non si tocca niente', async () => {
    h.profili = [{ ruolo: 'segreteria', area: 'admin' }]
    const res = await POST(req({ ruolo: 'genitore' }, `anno_attivo=${ANNO}`))
    expect(res.status).toBe(403)
    expect(cookies(res).filter(Boolean)).toEqual([])
  })
})

describe('POST /api/auth/logout — anno_attivo', () => {
  it('lo azzera', async () => {
    const res = await logout(new Request('http://localhost/api/auth/logout', { method: 'POST' }))
    expect(res.status).toBe(200)
    expect(cancella(res, 'anno_attivo')).toBeDefined()
  })
})
