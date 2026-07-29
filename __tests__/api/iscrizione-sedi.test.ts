// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * `GET /api/iscrizione/sedi` — elenco pubblico delle sedi per il selettore del
 * wizard d'iscrizione. È ANONIMA (il prefisso /api/iscrizione è già nell'allowlist
 * del middleware): perciò espone il minimo indispensabile (id + nome) ed è dietro
 * un rate-limit.
 */

const h = vi.hoisted(() => ({
  schools: { data: [] as unknown, error: null as unknown },
  scuole: { data: [] as unknown, error: null as unknown },
  rl: { ok: true, remaining: 29, retryAfterMs: 0 },
}))

vi.mock('@/lib/security/rate-limit', () => ({
  rateLimit: vi.fn(() => h.rl),
  clientIp: vi.fn(() => 'ip'),
}))

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from(table: string) {
      const risultato = table === 'schools' ? h.schools : h.scuole
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.order = () => b
      b.in = () => b
      b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve(risultato).then(res, rej)
      return b
    },
  }),
}))

import { GET } from '@/app/api/iscrizione/sedi/route'

const GIUGLIANO = { id: 'd53b0fbc-a9eb-4073-b302-73d1d5abd529', nome: 'Kidville Giugliano' }
const AVERSA = { id: '11111111-1111-4111-8111-111111111111', nome: 'Kidville Aversa' }
const CESA = { id: '22222222-2222-4222-8222-222222222222', nome: 'Kidville Cesa' }
const E2E = { id: 'e2e00000-0000-4000-8000-000000000001', nome: 'Kidville E2E' }

const req = (url = 'http://localhost/api/iscrizione/sedi') =>
  new Request(url) as unknown as import('next/server').NextRequest

type Corpo = { success?: boolean; data?: { id: string; nome: string }[]; error?: string }

beforeEach(() => {
  vi.clearAllMocks()
  h.schools = { data: [], error: null }
  h.scuole = { data: [], error: null }
  h.rl = { ok: true, remaining: 29, retryAfterMs: 0 }
})

describe('GET /api/iscrizione/sedi', () => {
  it('da anonimo: 200 con le sedi reali, la sede E2E esclusa', async () => {
    h.schools = { data: [AVERSA, CESA, GIUGLIANO, E2E], error: null }
    const res = await GET(req())
    expect(res.status).toBe(200)
    const json = (await res.json()) as Corpo
    expect(json.success).toBe(true)
    expect(json.data?.map((s) => s.id)).toEqual([AVERSA.id, CESA.id, GIUGLIANO.id])
    expect(json.data?.some((s) => s.id === E2E.id)).toBe(false)
  })

  it('espone SOLO id e nome (niente indirizzo, città o config)', async () => {
    h.schools = {
      data: [{ ...GIUGLIANO, citta: 'Giugliano', indirizzo: 'Via Test 1', config: { x: 1 } }],
      error: null,
    }
    const res = await GET(req())
    const json = (await res.json()) as Corpo
    expect(json.data).toEqual([{ id: GIUGLIANO.id, nome: GIUGLIANO.nome }])
  })

  it('la sede disattivata (scuole.attiva = false) non compare', async () => {
    h.schools = { data: [AVERSA, CESA, GIUGLIANO], error: null }
    h.scuole = { data: [{ id: CESA.id, attiva: false }], error: null }
    const res = await GET(req())
    const json = (await res.json()) as Corpo
    expect(json.data?.map((s) => s.id)).toEqual([AVERSA.id, GIUGLIANO.id])
  })

  it('DB E2E della CI (solo la sede di test) → 200 con elenco vuoto, non 500', async () => {
    h.schools = { data: [E2E], error: null }
    const res = await GET(req())
    expect(res.status).toBe(200)
    const json = (await res.json()) as Corpo
    expect(json.data).toEqual([])
  })

  it('errore PostgREST sulla lettura di schools → 500 (non un elenco vuoto silenzioso)', async () => {
    h.schools = { data: null, error: { code: '42P01', message: 'relation "schools" does not exist' } }
    const res = await GET(req())
    expect(res.status).toBe(500)
    const json = (await res.json()) as Corpo
    expect(json.error).toBeTruthy()
  })

  it('rate-limit superato → 429 con Retry-After', async () => {
    h.rl = { ok: false, remaining: 0, retryAfterMs: 30_000 }
    const res = await GET(req())
    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBe('30')
  })

  it('query param inatteso → non manda in 500 (schema zod vuoto e permissivo)', async () => {
    h.schools = { data: [GIUGLIANO], error: null }
    const res = await GET(req('http://localhost/api/iscrizione/sedi?foo=bar'))
    expect(res.status).toBe(200)
  })
})
