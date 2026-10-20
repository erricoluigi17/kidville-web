// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  SEDE_A,
  SEDE_B,
  SEDE_C,
  NOME_SEDE_A,
  NOME_SEDE_B,
  NOME_SEDE_C,
  SEDE_E2E,
  NOME_SEDE_E2E,
} from '../fixtures/sedi'

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

const ALFA = { id: SEDE_A, nome: NOME_SEDE_A }
const BETA = { id: SEDE_B, nome: NOME_SEDE_B }
const GAMMA = { id: SEDE_C, nome: NOME_SEDE_C }
const E2E = { id: SEDE_E2E, nome: NOME_SEDE_E2E }

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
    h.schools = { data: [ALFA, BETA, GAMMA, E2E], error: null }
    const res = await GET(req())
    expect(res.status).toBe(200)
    const json = (await res.json()) as Corpo
    expect(json.success).toBe(true)
    expect(json.data?.map((s) => s.id)).toEqual([ALFA.id, BETA.id, GAMMA.id])
    expect(json.data?.some((s) => s.id === E2E.id)).toBe(false)
  })

  it('espone SOLO id e nome (niente indirizzo, città o config)', async () => {
    h.schools = {
      data: [{ ...GAMMA, citta: 'Città di prova', indirizzo: 'Via Test 1', config: { x: 1 } }],
      error: null,
    }
    const res = await GET(req())
    const json = (await res.json()) as Corpo
    expect(json.data).toEqual([{ id: GAMMA.id, nome: GAMMA.nome }])
  })

  it('la sede disattivata (scuole.attiva = false) non compare', async () => {
    h.schools = { data: [ALFA, BETA, GAMMA], error: null }
    h.scuole = { data: [{ id: BETA.id, attiva: false }], error: null }
    const res = await GET(req())
    const json = (await res.json()) as Corpo
    expect(json.data?.map((s) => s.id)).toEqual([ALFA.id, GAMMA.id])
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

  // Fase 12: la CDN tiene la risposta buona per dieci minuti, ma SOLO senza sessione (con il
  // cookie il middleware può attaccare un Set-Cookie, che una cache condivisa riservirebbe a
  // tutti) e MAI su un errore, che resterebbe in cache a guasto finito.
  it('cache: anonimo → public con s-maxage; con il cookie di sessione → private, senza s-maxage', async () => {
    h.schools = { data: [ALFA], error: null }
    const anonimo = await GET(req())
    expect(anonimo.headers.get('Cache-Control')).toBe('public, max-age=600, s-maxage=600, stale-while-revalidate=3600')
    expect(anonimo.headers.get('Vary')).toBe('Cookie')
    const conSessione = await GET(
      new Request('http://localhost/api/iscrizione/sedi', {
        headers: { cookie: 'sb-progetto-auth-token=valore-finto' },
      }) as unknown as import('next/server').NextRequest,
    )
    expect(conSessione.headers.get('Cache-Control')).toBe('private, max-age=600, stale-while-revalidate=3600')
  })

  it('cache: né il 500 né il 429 portano intestazioni che una CDN conserverebbe', async () => {
    h.schools = { data: null, error: { code: '57014', message: 'timeout' } }
    const guasto = await GET(req())
    expect(guasto.status).toBe(500)
    expect(guasto.headers.get('Cache-Control') ?? '').not.toMatch(/public|s-maxage/)
    h.rl = { ok: false, remaining: 0, retryAfterMs: 30_000 }
    const tetto = await GET(req())
    expect(tetto.status).toBe(429)
    expect(tetto.headers.get('Cache-Control') ?? '').not.toMatch(/public|s-maxage/)
  })

  it('query param inatteso → non manda in 500 (schema zod vuoto e permissivo)', async () => {
    h.schools = { data: [GAMMA], error: null }
    const res = await GET(req('http://localhost/api/iscrizione/sedi?foo=bar'))
    expect(res.status).toBe(200)
  })
})
