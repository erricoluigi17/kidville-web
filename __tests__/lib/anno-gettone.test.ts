import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// `conGettone` (Compito 3.2): un client service-role che porta i gettoni di correzione
// nell'header `x-kidville-correzione`. Qui NON si finge il client: passa dal vero supabase-js e
// dal vero `fetchStrumentato`, con il solo `fetch` globale sostituito.

const creati = vi.hoisted(() => ({ n: 0 }))
vi.mock('@supabase/ssr', async (originale) => {
  const m = await originale<typeof import('@supabase/ssr')>()
  return {
    ...m,
    createServerClient: ((...a: Parameters<typeof m.createServerClient>) => {
      creati.n += 1
      return m.createServerClient(...a)
    }) as typeof m.createServerClient,
  }
})
vi.mock('next/headers', () => ({ cookies: vi.fn() }))

import { conGettone } from '@/lib/anno/gettone'

const G1 = '11111111-aaaa-4aaa-8aaa-111111111111'
const G2 = '22222222-aaaa-4aaa-8aaa-222222222222'
const G3 = '33333333-aaaa-4aaa-8aaa-333333333333'

describe('conGettone', () => {
  const chiamate: Array<[unknown, RequestInit | undefined]> = []

  beforeEach(() => {
    creati.n = 0
    chiamate.length = 0
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'chiave-finta-di-prova'
    vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
      chiamate.push([input, init])
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  function headerDellUltima(nome: string): string | null {
    const init = chiamate[chiamate.length - 1][1]
    return new Headers(init?.headers as HeadersInit | undefined).get(nome)
  }

  it('un uuid → il fetch invia x-kidville-correzione: uuid', async () => {
    const client = await conGettone(G1)
    await client.from('sections').select('id')
    expect(chiamate.length).toBe(1)
    expect(headerDellUltima('x-kidville-correzione')).toBe(G1)
  })

  it('tre uuid → lista separata da virgole, nell\'ordine dato', async () => {
    const client = await conGettone([G1, G2, G3])
    await client.from('sections').select('id')
    expect(headerDellUltima('x-kidville-correzione')).toBe(`${G1},${G2},${G3}`)
  })

  it('il header viaggia su OGNI richiesta del client', async () => {
    const client = await conGettone(G1)
    await client.from('sections').select('id')
    await client.from('alunni').select('id')
    expect(chiamate.length).toBe(2)
    for (const [, init] of chiamate) {
      expect(new Headers(init?.headers as HeadersInit | undefined).get('x-kidville-correzione')).toBe(G1)
    }
  })

  it('un valore che non è un uuid lancia PRIMA di creare il client (mai un header inventato)', async () => {
    for (const cattivo of ['non-un-uuid', '', `${G1},x`, `${G1}\nx-altro: 1`, ' ' + G1]) {
      await expect(conGettone(cattivo), JSON.stringify(cattivo)).rejects.toThrow('GETTONE_NON_VALIDO')
    }
    await expect(conGettone([G1, 'no'])).rejects.toThrow('GETTONE_NON_VALIDO')
    await expect(conGettone([])).rejects.toThrow('GETTONE_NON_VALIDO')
    expect(creati.n).toBe(0)
    expect(chiamate.length).toBe(0)
  })
})
