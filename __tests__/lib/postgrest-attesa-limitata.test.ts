import { describe, it, expect, vi, afterEach } from 'vitest'

// =============================================================================
// IL TETTO SULL'ATTESA FRA I TENTATIVI DI POSTGREST (fase 11 della robustezza, S6).
//
// postgrest-js ritenta una GET su 503/520 e fra un tentativo e l'altro dorme quanto dice
// `Retry-After`, senza tetto. Qui si prova sul pacchetto VERO (non su una copia della sua
// politica) che, passando dal fetch strumentato, un 503 con `Retry-After: 120` non tiene più
// appesa la query sei minuti: con il tetto a 2 s i tre ritentativi finiscono in 6 s.
// =============================================================================

vi.mock('@/lib/logging/logger', () => ({
  logEvento: vi.fn(),
  logErrore: vi.fn(),
  logOk: vi.fn(),
}))

import { PostgrestClient } from '@supabase/postgrest-js'
import { conAttesaLimitata, creaFetchStrumentato } from '@/lib/logging/supabase-fetch'
import { fetchConAttesaLimitata } from '@/lib/supabase/attesa-ritentativi'

const URL_REST = 'https://esempio.supabase.co/rest/v1'

function risposta(stato: number, retryAfter?: string): Response {
  const headers = new Headers({ 'content-type': 'application/json' })
  if (retryAfter !== undefined) headers.set('retry-after', retryAfter)
  return new Response(stato === 200 ? '[{"id":1}]' : '{"message":"schema cache"}', { status: stato, headers })
}

afterEach(() => {
  vi.useRealTimers()
})

describe('conAttesaLimitata', () => {
  const get = { area: 'db' as const, metodo: 'GET', tentativo: 0 }

  it('accorcia a 2 s un Retry-After lungo, su una risposta che postgrest ritenterà', () => {
    const r = conAttesaLimitata(get, risposta(503, '120'))
    expect(r.status).toBe(503)
    expect(r.headers.get('retry-after')).toBe('2')
  })

  it('lascia stare quello che non c’entra', () => {
    const corta = risposta(503, '1')
    expect(conAttesaLimitata(get, corta)).toBe(corta)
    const senza = risposta(503)
    expect(conAttesaLimitata(get, senza)).toBe(senza)
    const data = risposta(503, 'Wed, 21 Oct 2026 07:28:00 GMT')
    expect(conAttesaLimitata(get, data)).toBe(data)
    // L'ultimo tentativo non verrà ritentato: l'header non conta più.
    const ultima = risposta(503, '120')
    expect(conAttesaLimitata({ ...get, tentativo: 3 }, ultima)).toBe(ultima)
    // postgrest ritenta solo GET/HEAD/OPTIONS, e solo sul database.
    const scrittura = risposta(503, '120')
    expect(conAttesaLimitata({ ...get, metodo: 'POST' }, scrittura)).toBe(scrittura)
    const storage = risposta(503, '120')
    expect(conAttesaLimitata({ ...get, area: 'storage' }, storage)).toBe(storage)
    const ok = risposta(200, '120')
    expect(conAttesaLimitata(get, ok)).toBe(ok)
  })

  it('il corpo arriva intatto', async () => {
    const r = conAttesaLimitata(get, risposta(503, '120'))
    expect(await r.text()).toBe('{"message":"schema cache"}')
  })
})

describe('sul postgrest-js vero, dal fetch strumentato', () => {
  it('tre 503 con Retry-After: 120 e poi un 200: la query finisce entro 6 s, non sei minuti', async () => {
    vi.useFakeTimers()
    let colpi = 0
    const base = vi.fn(async () => {
      colpi += 1
      return colpi <= 3 ? risposta(503, '120') : risposta(200)
    })
    const client = new PostgrestClient(URL_REST, { fetch: creaFetchStrumentato(base) })

    let finito: { data: unknown; error: unknown } | null = null
    void client
      .from('alunni')
      .select('id')
      .then((r) => {
        finito = r
      })

    await vi.advanceTimersByTimeAsync(6_100)
    expect(colpi).toBe(4)
    expect(finito).not.toBeNull()
    expect(finito!.error).toBeNull()
    expect(finito!.data).toEqual([{ id: 1 }])
  })

  it('senza il tetto la stessa query sarebbe ancora appesa: la prova che il test morde', async () => {
    vi.useFakeTimers()
    let colpi = 0
    const base = vi.fn(async () => {
      colpi += 1
      return colpi <= 3 ? risposta(503, '120') : risposta(200)
    })
    // Lo stesso client SENZA il fetch strumentato: è il comportamento di prima.
    const client = new PostgrestClient(URL_REST, { fetch: base })

    let finito = false
    void client
      .from('alunni')
      .select('id')
      .then(() => {
        finito = true
      })

    await vi.advanceTimersByTimeAsync(6_100)
    expect(colpi).toBe(1)
    expect(finito).toBe(false)
    await vi.advanceTimersByTimeAsync(360_000)
    expect(finito).toBe(true)
  })
})

describe('nel browser: fetchConAttesaLimitata', () => {
  it('accorcia il Retry-After di una GET al database, e lascia stare il resto', async () => {
    const base = vi.fn(async () => risposta(503, '120'))
    const f = fetchConAttesaLimitata(base as unknown as typeof fetch)
    expect((await f(`${URL_REST}/alunni?select=id`)).headers.get('retry-after')).toBe('2')
    expect((await f(`${URL_REST}/alunni`, { method: 'POST' })).headers.get('retry-after')).toBe('120')
    expect((await f('https://esempio.supabase.co/auth/v1/user')).headers.get('retry-after')).toBe('120')
    expect((await f(new URL(`${URL_REST}/alunni`))).headers.get('retry-after')).toBe('2')
  })

  it('sul postgrest-js vero la query finisce entro 6 s', async () => {
    vi.useFakeTimers()
    let colpi = 0
    const base = vi.fn(async () => {
      colpi += 1
      return colpi <= 3 ? risposta(503, '120') : risposta(200)
    })
    const client = new PostgrestClient(URL_REST, { fetch: fetchConAttesaLimitata(base as unknown as typeof fetch) })
    let finito = false
    void client.from('alunni').select('id').then(() => {
      finito = true
    })
    await vi.advanceTimersByTimeAsync(6_100)
    expect(colpi).toBe(4)
    expect(finito).toBe(true)
  })
})
