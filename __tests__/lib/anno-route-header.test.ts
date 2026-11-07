import { describe, it, expect, vi } from 'vitest'
import { creaFetchStrumentato } from '@/lib/logging/supabase-fetch'
import { conContesto } from '@/lib/logging/context'
import { withRoute } from '@/lib/logging/with-route'

// `x-kidville-route` (Compito 3.2, Ruling P11): il nome passato a `withRoute` viaggia su ogni
// richiesta PostgREST, così i contatori di osservazione dicono QUALE route ha scritto.

const URL_DB = 'https://x.supabase.co/rest/v1/sections'

function headerInviato(base: { mock: { calls: unknown[][] } }): string | null {
  const init = base.mock.calls[0][1] as RequestInit | undefined
  return new Headers(init?.headers as HeadersInit | undefined).get('x-kidville-route')
}

describe('x-kidville-route', () => {
  it('dentro un contesto con route, la richiesta PostgREST porta il nome della route', async () => {
    const base = vi.fn<(u: unknown, i?: RequestInit) => Promise<Response>>(async () => new Response('{}', { status: 200 }))
    const f = creaFetchStrumentato(base)
    await conContesto({ requestId: 'r1', path: '/api/admin/sections', route: 'admin/sections:POST' }, () =>
      f(URL_DB, { method: 'POST', headers: new Headers({ apikey: 'k' }) }),
    )
    expect(headerInviato(base)).toBe('admin/sections:POST')
  })

  it('anche con gli header come oggetto semplice o come array, senza perdere gli altri', async () => {
    for (const headers of [{ apikey: 'k' }, [['apikey', 'k']] as [string, string][]]) {
      const base = vi.fn<(u: unknown, i?: RequestInit) => Promise<Response>>(async () => new Response('{}', { status: 200 }))
      const f = creaFetchStrumentato(base)
      await conContesto({ requestId: 'r1', path: '/x', route: 'admin/sections:POST' }, () =>
        f(URL_DB, { method: 'POST', headers }),
      )
      const h = new Headers((base.mock.calls[0][1] as RequestInit).headers as HeadersInit)
      expect(h.get('x-kidville-route')).toBe('admin/sections:POST')
      expect(h.get('apikey')).toBe('k')
    }
  })

  it('anche una RPC lo porta; storage e auth no', async () => {
    const base = vi.fn<(u: unknown, i?: RequestInit) => Promise<Response>>(async () => new Response('{}', { status: 200 }))
    const f = creaFetchStrumentato(base)
    await conContesto({ requestId: 'r1', path: '/x', route: 'a/b:GET' }, async () => {
      await f('https://x.supabase.co/rest/v1/rpc/una_funzione', { method: 'POST' })
      await f('https://x.supabase.co/storage/v1/object/b/c.pdf', { method: 'GET' })
      await f('https://x.supabase.co/auth/v1/user', { method: 'GET' })
    })
    const viste = base.mock.calls.map((c) => new Headers((c[1] as RequestInit | undefined)?.headers).get('x-kidville-route'))
    expect(viste).toEqual(['a/b:GET', null, null])
  })

  it('fuori da un contesto non c\'è nessun header e l\'init arriva intatto', async () => {
    const base = vi.fn<(u: unknown, i?: RequestInit) => Promise<Response>>(async () => new Response('{}', { status: 200 }))
    const f = creaFetchStrumentato(base)
    const ac = new AbortController()
    const init = { method: 'POST', signal: ac.signal, headers: { apikey: 'k' } }
    await f(URL_DB, init)
    expect(base).toHaveBeenCalledWith(URL_DB, init)
  })

  it('un contesto senza route non manda l\'header', async () => {
    const base = vi.fn<(u: unknown, i?: RequestInit) => Promise<Response>>(async () => new Response('{}', { status: 200 }))
    const f = creaFetchStrumentato(base)
    await conContesto({ requestId: 'r1', path: '/x' }, () => f(URL_DB, { method: 'POST' }))
    expect(headerInviato(base)).toBeNull()
  })

  it('un nome con caratteri strani non diventa un header (mai un testo libero)', async () => {
    for (const strano of ['admin/sections POST', 'a\nb', 'rossi@example.com', 'a;b', 'è:POST']) {
      const base = vi.fn<(u: unknown, i?: RequestInit) => Promise<Response>>(async () => new Response('{}', { status: 200 }))
      const f = creaFetchStrumentato(base)
      await conContesto({ requestId: 'r1', path: '/x', route: strano }, () => f(URL_DB, { method: 'POST' }))
      expect(headerInviato(base), strano).toBeNull()
    }
  })

  it('un nome lungo si tronca a 120 caratteri', async () => {
    const base = vi.fn<(u: unknown, i?: RequestInit) => Promise<Response>>(async () => new Response('{}', { status: 200 }))
    const f = creaFetchStrumentato(base)
    await conContesto({ requestId: 'r1', path: '/x', route: 'a'.repeat(300) }, () => f(URL_DB, { method: 'POST' }))
    expect(headerInviato(base)).toBe('a'.repeat(120))
  })

  it('withRoute riempie il campo con il suo nome', async () => {
    const base = vi.fn<(u: unknown, i?: RequestInit) => Promise<Response>>(async () => new Response('{}', { status: 200 }))
    const f = creaFetchStrumentato(base)
    const handler = withRoute('admin/sections:POST', async () => {
      await f(URL_DB, { method: 'POST' })
      return new Response('{}', { status: 200 })
    })
    await handler(new Request('https://app.example/api/admin/sections', { method: 'POST' }))
    expect(headerInviato(base)).toBe('admin/sections:POST')
  })
})
