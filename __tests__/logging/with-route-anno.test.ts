import { describe, it, expect, vi, beforeEach } from 'vitest'

// La rete di `withRoute` (Compito 3.4, D4): un `ANNO_CHIUSO` del database diventa 409 su ogni
// route senza toccarla. Il `fetch` finto sta SOTTO il vero `fetch` strumentato: passa da
// `registraFallimento`, che legge il corpo e alza il campo nel contesto. Solo il logger è finto,
// per contare le righe.
vi.mock('@/lib/logging/logger', async (orig) => {
  const reale = await orig<typeof import('@/lib/logging/logger')>()
  return { ...reale, logEvento: vi.fn(), logErrore: vi.fn(), logOk: vi.fn() }
})

import { logEvento } from '@/lib/logging/logger'
import { creaFetchStrumentato } from '@/lib/logging/supabase-fetch'
import { conContesto, erroreAnnoDellaRichiesta, segnalaErroreAnno } from '@/lib/logging/context'
import { withRoute } from '@/lib/logging/with-route'

const URL_DB = 'https://x.supabase.co/rest/v1/sections'

function corpoDb(message: string, code = 'P0001', status = 400): () => Promise<Response> {
  return async () =>
    new Response(JSON.stringify({ code, message, details: null, hint: null }), {
      status,
      headers: { 'content-type': 'application/json' },
    })
}

function fetchDb(risposta: () => Promise<Response>) {
  return creaFetchStrumentato(risposta)
}

const req = () => new Request('http://l/api/x', { method: 'POST' })
const risposta500 = () => Response.json({ error: 'guasto' }, { status: 500 })
const pausa = (ms: number) => new Promise((r) => setTimeout(r, ms))

function warnIngoiati() {
  return vi.mocked(logEvento).mock.calls.filter((c) => (c[2] as { tipo?: string } | undefined)?.tipo === 'anno-scrittura-ingoiata')
}

beforeEach(() => {
  vi.mocked(logEvento).mockClear()
})

describe('withRoute: la rete dell\'anno', () => {
  it('handler che risponde 500 dopo un ANNO_CHIUSO del database -> 409 ANNO_CHIUSO', async () => {
    const f = fetchDb(corpoDb('ANNO_CHIUSO'))
    const route = withRoute('t/chiuso:POST', async () => {
      await f(URL_DB, { method: 'PATCH' })
      return risposta500()
    })
    const res = await route(req())
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('ANNO_CHIUSO')
    expect(res.headers.get('x-request-id')).toBeTruthy()
  })

  it('handler che risponde 200 (errore ingoiato) resta 200, con il warn anno-scrittura-ingoiata', async () => {
    const f = fetchDb(corpoDb('ANNO_CHIUSO'))
    const route = withRoute('t/ingoiata:POST', async () => {
      await f(URL_DB, { method: 'PATCH' })
      return Response.json({ ok: true })
    })
    const res = await route(req())
    expect(res.status).toBe(200)
    const warn = warnIngoiati()
    expect(warn).toHaveLength(1)
    expect(warn[0][0]).toBe('anno-scolastico')
    expect(warn[0][1]).toBe('warn')
    expect(warn[0][2]).toEqual({ tipo: 'anno-scrittura-ingoiata', error_code: 'ANNO_CHIUSO', operazione: 't/ingoiata:POST' })
  })

  it('un 4xx della route passa com\'è, senza il warn', async () => {
    const f = fetchDb(corpoDb('ANNO_CHIUSO'))
    const route = withRoute('t/quattro:POST', async () => {
      await f(URL_DB, { method: 'PATCH' })
      return Response.json({ error: 'no' }, { status: 403 })
    })
    const res = await route(req())
    expect(res.status).toBe(403)
    expect(warnIngoiati()).toHaveLength(0)
  })

  it('502/503/504 passano invariati', async () => {
    for (const stato of [502, 503, 504]) {
      const f = fetchDb(corpoDb('ANNO_CHIUSO'))
      const route = withRoute('t/gw:POST', async () => {
        await f(URL_DB, { method: 'PATCH' })
        return Response.json({ error: 'gw' }, { status: stato })
      })
      expect((await route(req())).status).toBe(stato)
    }
  })

  it('500 per un altro motivo e nessun errore anno -> 500 invariato', async () => {
    const f = fetchDb(corpoDb('duplicate key value violates unique constraint', '23505', 409))
    const route = withRoute('t/altro:POST', async () => {
      await f(URL_DB, { method: 'POST' })
      return risposta500()
    })
    const res = await route(req())
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe('guasto')
  })

  it('due richieste concorrenti con contesti diversi non si mescolano', async () => {
    const fChiuso = fetchDb(corpoDb('ANNO_CHIUSO'))
    const fOk = fetchDb(async () => new Response('{}', { status: 200 }))
    const a = withRoute('t/a:POST', async () => {
      await pausa(5)
      await fChiuso(URL_DB, { method: 'PATCH' })
      await pausa(5)
      return risposta500()
    })
    const b = withRoute('t/b:POST', async () => {
      await fOk(URL_DB, { method: 'PATCH' })
      await pausa(15)
      return risposta500()
    })
    const [ra, rb] = await Promise.all([a(req()), b(req())])
    expect(ra.status).toBe(409)
    expect(rb.status).toBe(500)
  })

  it('un fetch che solleva (rete) non rompe niente: il flag resta vuoto', async () => {
    const f = creaFetchStrumentato(async () => {
      throw new TypeError('fetch failed')
    })
    let visto: unknown = 'non-letto'
    const route = withRoute('t/rete:POST', async () => {
      await f(URL_DB, { method: 'PATCH' }).catch(() => undefined)
      visto = erroreAnnoDellaRichiesta()
      return risposta500()
    })
    const res = await route(req())
    expect(visto).toBeUndefined()
    expect(res.status).toBe(500)
  })

  it('l\'handler che LANCIA dopo il fetch rifiutato -> 409', async () => {
    const f = fetchDb(corpoDb('ANNO_CHIUSO'))
    const route = withRoute('t/lancia:POST', async () => {
      await f(URL_DB, { method: 'PATCH' })
      throw new Error('boom')
    })
    const res = await route(req())
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('ANNO_CHIUSO')
  })

  it('l\'handler che lancia senza errore anno rilancia com\'è', async () => {
    const route = withRoute('t/lancia2:POST', async () => {
      throw new Error('boom')
    })
    await expect(route(req())).rejects.toThrow('boom')
  })

  it('il set-cookie dell\'originale c\'è anche nella risposta tradotta', async () => {
    const f = fetchDb(corpoDb('ANNO_CHIUSO'))
    const route = withRoute('t/cookie:POST', async () => {
      await f(URL_DB, { method: 'PATCH' })
      const r = risposta500()
      r.headers.append('set-cookie', 'sb-a=1; Path=/')
      r.headers.append('set-cookie', 'sb-b=2; Path=/')
      return r
    })
    const res = await route(req())
    expect(res.status).toBe(409)
    expect(res.headers.getSetCookie()).toEqual(['sb-a=1; Path=/', 'sb-b=2; Path=/'])
  })

  it('con due errori anno nella stessa richiesta vince il PRIMO', async () => {
    let n = 0
    const f = creaFetchStrumentato(async () => corpoDb(n++ === 0 ? 'ANNO_CHIUSO' : 'PASSAGGIO_DA_FARE')())
    const route = withRoute('t/primo:POST', async () => {
      await f(URL_DB, { method: 'PATCH' })
      await f(URL_DB, { method: 'PATCH' })
      return risposta500()
    })
    const res = await route(req())
    expect((await res.json()).codice).toBe('ANNO_CHIUSO')
  })

  it('un message che non è un codice dell\'anno non alza il campo', async () => {
    const f = fetchDb(corpoDb('PERMESSO_NEGATO'))
    const route = withRoute('t/estraneo:POST', async () => {
      await f(URL_DB, { method: 'PATCH' })
      return risposta500()
    })
    expect((await route(req())).status).toBe(500)
  })
})

describe('contesto: erroreAnno', () => {
  it('tiene il primo e fuori da una richiesta non fa niente e non lancia', async () => {
    expect(() => segnalaErroreAnno('P0001', 'ANNO_CHIUSO')).not.toThrow()
    expect(erroreAnnoDellaRichiesta()).toBeUndefined()
    await conContesto({ requestId: 'r', path: '/x' }, async () => {
      segnalaErroreAnno('P0001', 'ANNO_CHIUSO')
      segnalaErroreAnno('P0001', 'PASSAGGIO_DA_FARE')
      expect(erroreAnnoDellaRichiesta()).toEqual({ code: 'P0001', message: 'ANNO_CHIUSO' })
    })
  })
})
