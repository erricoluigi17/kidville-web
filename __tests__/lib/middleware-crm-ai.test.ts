// @vitest-environment node
import { inspect } from 'node:util'
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import catalogoIt from '../../messages/it/shared.json'

vi.mock('@supabase/ssr', async (originale) => {
  const ssr = await originale<typeof import('@supabase/ssr')>()
  return { ...ssr, createServerClient: vi.fn(ssr.createServerClient) }
})

const ORIGINE_SUPABASE = 'https://progetto.invalid'
const COOKIE = 'sb-progetto-auth-token'
const COOKIE_SENTINELLA = 'cookie-sentinella-crm-ai'
const BEARER_SENTINELLA = 'bearer-sentinella-crm-ai'
const RID_SENTINELLA = 'rid-sentinella-crm-ai'
const QUERY_SENTINELLA = 'query-sentinella-crm-ai'
const ERRORE_SENTINELLA = 'errore-sentinella-crm-ai'
const TOKEN_FALSO = 'kvai_' + 'A'.repeat(43)
const JWT_FALSO = [
  Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
  Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url'),
  Buffer.from('firma-sintetica').toString('base64url'),
].join('.')
const UUID_V4 = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i

function richiesta(percorso: string, cookie?: string, bearer = BEARER_SENTINELLA) {
  const headers = new Headers({
    authorization: 'Bearer ' + bearer,
    'x-request-id': RID_SENTINELLA,
    'x-vercel-id': RID_SENTINELLA,
  })
  if (cookie) headers.set('cookie', cookie)
  return new NextRequest('https://app.invalid' + percorso + '?prova=' + QUERY_SENTINELLA, { headers })
}

function sessioneScaduta() {
  const sessione = {
    access_token: JWT_FALSO,
    refresh_token: COOKIE_SENTINELLA,
    expires_at: Math.floor(Date.now() / 1000) - 3600,
  }
  return COOKIE + '=base64-' + Buffer.from(JSON.stringify(sessione)).toString('base64url')
}

function reteFinta() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input))
    if (url.origin !== ORIGINE_SUPABASE) throw new Error('Origine inattesa nel test')
    switch (url.pathname) {
      case '/auth/v1/.well-known/jwks.json':
        return Response.json({ keys: [] })
      case '/auth/v1/token':
        return Response.json({
          access_token: JWT_FALSO,
          refresh_token: 'refresh-rinnovato-di-prova',
          expires_in: 3600,
          token_type: 'bearer',
        })
      case '/auth/v1/user':
        return Response.json({ id: '11111111-2222-3333-4444-555555555555' })
      case '/rest/v1/crm_integrazioni':
        return Response.json({ code: 'PGRST205', message: ERRORE_SENTINELLA, details: TOKEN_FALSO }, { status: 404 })
      case '/rest/v1/rpc/app_log_registra':
        expect(init?.method).toBe('POST')
        return Response.json(null)
      default:
        throw new Error('Percorso inatteso nel test')
    }
  })
}

function consoleFinta() {
  return (['log', 'error', 'warn'] as const).map(livello =>
    vi.spyOn(console, livello).mockImplementation(() => {}))
}

let rete: ReturnType<typeof reteFinta>
let consoleSpie: ReturnType<typeof consoleFinta>

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  vi.stubEnv('CRM_AI_ATTIVO', '')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', ORIGINE_SUPABASE)
  vi.stubEnv('VITEST', '')
  vi.stubEnv('KV_LOG_LEVEL', '')
  rete = reteFinta()
  consoleSpie = consoleFinta()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

function chiamateRete() {
  return rete.mock.calls.map(([input]) => new URL(String(input)).pathname)
}

function logEmessi() {
  return consoleSpie.flatMap(spia => spia.mock.calls)
}

function logPersistiti() {
  return rete.mock.calls.flatMap(([input, init]) => {
    if (new URL(String(input)).pathname !== '/rest/v1/rpc/app_log_registra') return []
    const { righe } = JSON.parse(String(init?.body)) as { righe: { request_id: string }[] }
    return righe
  })
}

// Riproduce il passaggio degli header interni di Next verso la route in questo test Node.
function richiestaInoltrata(req: NextRequest, passaggio: Response): NextRequest {
  const nomi = passaggio.headers.get('x-middleware-override-headers')?.split(',') ?? []
  const headers = new Headers(req.headers)
  for (const nome of nomi) {
    const valore = passaggio.headers.get('x-middleware-request-' + nome)
    if (valore === null) headers.delete(nome)
    else headers.set(nome, valore)
  }
  return new NextRequest(req.url, { headers })
}

describe('Middleware CRM AI', () => {
  it.each([
    { percorso: '/api/crm/ai', cookie: undefined },
    { percorso: '/api/crm/ai/slot', cookie: sessioneScaduta() },
  ])('a interruttore spento inoltra $percorso senza client, auth o log Edge', async ({ percorso, cookie }) => {
    const { middleware } = await import('@/middleware')
    const { createServerClient } = await import('@supabase/ssr')
    const req = richiesta(percorso, cookie)
    const passaggio = await middleware(req)

    expect.soft(chiamateRete()).toEqual([])
    expect.soft(createServerClient).not.toHaveBeenCalled()
    expect(logEmessi()).toEqual([])
    expect(passaggio.headers.get('x-middleware-next')).toBe('1')
    expect(passaggio.headers.has('x-request-id')).toBe(false)
    expect(passaggio.headers.has('set-cookie')).toBe(false)
    const inoltrata = richiestaInoltrata(req, passaggio)
    expect(inoltrata.headers.get('authorization')).toBe(req.headers.get('authorization'))
    expect(inoltrata.headers.get('x-request-id')).toMatch(UUID_V4)
  })

  it.each(['/api/crm/aix', '/api/admin/crm', '/api/avvisi'])(
    'sulla API ordinaria %s rinnova ancora la sessione e propaga il cookie e il rid',
    async (percorso) => {
      const { middleware } = await import('@/middleware')
      const req = richiesta(percorso, sessioneScaduta())
      const passaggio = await middleware(req)

      expect(chiamateRete()).toEqual(['/auth/v1/.well-known/jwks.json', '/auth/v1/token', '/auth/v1/user'])
      expect(passaggio.headers.get('x-middleware-next')).toBe('1')
      const rid = passaggio.headers.get('x-request-id')
      expect(rid).toMatch(UUID_V4)
      const inoltrata = richiestaInoltrata(req, passaggio)
      expect(inoltrata.headers.get('x-request-id')).toBe(rid)
      const cookie = passaggio.headers.get('set-cookie')
      const valore = cookie?.match(/base64-([^;]+)/)?.[1] ?? ''
      const sessione = Buffer.from(valore, 'base64url').toString('utf8')
      expect(sessione).toContain('refresh-rinnovato-di-prova')
      expect(inoltrata.headers.get('cookie')).toContain(valore)
    },
  )

  it('una pagina anonima passa dal controllo e torna ancora al login', async () => {
    const { middleware } = await import('@/middleware')
    const passaggio = await middleware(richiesta('/admin/crm'))
    expect(chiamateRete()).toEqual(['/auth/v1/.well-known/jwks.json'])
    expect(passaggio.status).toBe(307)
    const login = new URL(passaggio.headers.get('location')!)
    expect(login.pathname).toBe('/auth/login')
    expect(login.searchParams.get('next')).toBe('/admin/crm?prova=' + QUERY_SENTINELLA)
    expect(passaggio.headers.get('x-request-id')).toMatch(UUID_V4)
  })

  it.each([
    { attivo: '', bearer: BEARER_SENTINELLA, stato: 404, codice: 'CRM_AI_SPENTO', errore: catalogoIt.erroreCrmAiSpento, evento: 'error_code=CRM_AI_SPENTO' },
    { attivo: '1', bearer: BEARER_SENTINELLA, stato: 401, codice: 'TOKEN_NON_VALIDO', errore: catalogoIt.erroreCrmAiTokenNonValido, evento: 'error_code=TOKEN_NON_VALIDO' },
    { attivo: '1', bearer: TOKEN_FALSO, stato: 503, codice: 'CRM_NON_INSTALLATO', errore: 'Il CRM non è ancora disponibile su questo ambiente.', evento: 'esito=schema-crm-assente' },
  ])('il GET slot reale restituisce $stato con il rid tecnico dell’evento del gate', async ({
    attivo, bearer, stato, codice, errore, evento,
  }) => {
    vi.stubEnv('CRM_AI_ATTIVO', attivo)
    const [{ middleware }, { GET }] = await Promise.all([
      import('@/middleware'),
      import('@/app/api/crm/ai/slot/route'),
    ])
    const req = richiesta('/api/crm/ai/slot', sessioneScaduta(), bearer)
    const passaggio = await middleware(req)
    expect(chiamateRete()).toEqual([])
    expect(logEmessi()).toEqual([])
    expect(passaggio.headers.has('x-request-id')).toBe(false)
    const inoltrata = richiestaInoltrata(req, passaggio)

    const risposta = await GET(inoltrata)
    expect(risposta.status).toBe(stato)
    const json: unknown = await risposta.json()
    expect(json).toEqual({ error: errore, codice })
    expect(risposta.headers.get('www-authenticate')).toBe(stato === 401 ? 'Bearer' : null)
    const rid = risposta.headers.get('x-request-id')
    expect(rid).toMatch(UUID_V4)
    expect(rid).not.toBe(inoltrata.headers.get('x-request-id'))
    expect(logEmessi().flat()).toContainEqual(expect.stringMatching(new RegExp('rid=' + rid + ' .*' + evento)))

    expect(chiamateRete().filter(path => !path.endsWith('/app_log_registra')))
      .toEqual(stato === 503 ? ['/rest/v1/crm_integrazioni'] : [])
    if (stato === 404) {
      expect(chiamateRete()).toEqual([])
    } else {
      await vi.waitFor(() => {
        expect(logPersistiti()).toContainEqual(expect.objectContaining({ request_id: rid }))
      })
    }
    const emissioni = inspect([logEmessi(), logPersistiti(), json, [...risposta.headers]], { depth: null })
    for (const sentinella of [COOKIE_SENTINELLA, BEARER_SENTINELLA, RID_SENTINELLA,
      QUERY_SENTINELLA, ERRORE_SENTINELLA, TOKEN_FALSO, JWT_FALSO]) {
      expect(emissioni).not.toContain(sentinella)
    }
  })
})
