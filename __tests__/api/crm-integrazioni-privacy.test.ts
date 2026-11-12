// @vitest-environment node
import { inspect } from 'node:util'
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { ADMIN_AI as ADMIN, INTEGRAZIONE_A } from '../fixtures/crm-ai'
import { SEDE_A } from '../fixtures/sedi'

const h = vi.hoisted(() => ({
  rpc: vi.fn<(nome: string, args: { righe: RigaLog[] }) => Promise<{ error: null }>>().mockResolvedValue({ error: null }),
  getUser: vi.fn(),
  code: 'XX000',
  risorsaIdentita: null as 'utenti' | 'parents' | null,
}))

type RigaLog = {
  evento: string
  livello: string
  codice?: string
  stato_http?: number
  request_id: string
  route: string
  messaggio: string
  contesto?: Record<string, unknown>
}

// Il client che interroga PostgREST e il logger sono reali. Si simulano la sessione
// GoTrue, il trasporto HTTP e la RPC che riceve le righe di app_log.
vi.mock('@/lib/supabase/server-client', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/supabase/server-client')>()),
  createClient: async () => ({ auth: { getUser: h.getUser } }),
  createLogClient: async () => ({ rpc: h.rpc }),
}))
vi.mock('@/lib/supabase/public-config', () => ({
  SUPABASE_URL: 'http://crm-db.invalid',
  SUPABASE_ANON_KEY: 'anon-finta',
}))

const BASE = '/api/admin/crm/integrazioni'
const ORIGINE = 'http://crm-web.invalid'
const ID_ESTERNO = '40000000-0000-4000-8000-000000000001'
const TESTO = 'MessaggioSinteticoPostgrest'
const DETTAGLI = 'DettagliSinteticiPostgrest'
const SUGGERIMENTO = 'SuggerimentoSinteticoPostgrest'
const COOKIE = 'sb-crm-prova-auth-token=sessione-finta'
const UUID = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i

let rete: MockInstance<typeof fetch>
let info: ReturnType<typeof vi.spyOn>
let errori: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('VITEST', '')
  vi.stubEnv('KV_LOG_LEVEL', '')
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'servizio-finto')
  h.getUser.mockResolvedValue({ data: { user: { id: ADMIN } }, error: null })
  h.code = 'XX000'
  h.risorsaIdentita = null
  info = vi.spyOn(console, 'log').mockImplementation(() => {})
  errori = vi.spyOn(console, 'error').mockImplementation(() => {})
  rete = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input))
    const metodo = init?.method ?? 'GET'
    if (url.origin !== 'http://crm-db.invalid' || metodo !== 'GET') throw new Error('Chiamata imprevista nella rete finta')
    if (h.risorsaIdentita && url.pathname === '/rest/v1/' + h.risorsaIdentita) {
      return Response.json({ code: h.code, message: TESTO, details: DETTAGLI, hint: SUGGERIMENTO }, { status: 400 })
    }
    switch (url.pathname) {
      case '/rest/v1/utenti':
        return Response.json([{ id: ADMIN, role: 'admin', scuola_id: null, archiviato_il: null }])
      case '/rest/v1/parents':
        return Response.json([])
      case '/rest/v1/utenti_scuole':
        return Response.json({ code: h.code, message: TESTO, details: DETTAGLI, hint: SUGGERIMENTO }, { status: 400 })
      case '/rest/v1/crm_integrazioni':
        return Response.json([{ id: INTEGRAZIONE_A, scuola_id: SEDE_A, revocata_il: null }])
      default:
        throw new Error('Risorsa imprevista nella rete finta')
    }
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

function richiesta(
  metodo: 'GET' | 'POST' | 'DELETE',
  percorso = BASE,
  corpo?: object,
  rid = ID_ESTERNO,
): NextRequest {
  return new NextRequest(ORIGINE + percorso, {
    method: metodo,
    headers: { 'content-type': 'application/json', cookie: COOKIE, 'x-request-id': rid },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  })
}

function righeLog(): RigaLog[] {
  return h.rpc.mock.calls.flatMap(([nome, args]) => {
    expect(nome).toBe('app_log_registra')
    return args.righe
  })
}

function consoleLog(): string {
  return inspect([info.mock.calls, errori.mock.calls], { depth: 12 })
}

function nessunDato(righe: RigaLog[], console: string, segreti: string[]) {
  const emissioni = inspect(righe, { depth: 12 }) + console
  for (const dato of segreti) expect(emissioni).not.toContain(dato)
}

function ridProtetto(r: Response): string {
  const rid = r.headers.get('x-request-id') ?? ''
  expect(rid).toMatch(UUID)
  expect(rid).not.toBe(ID_ESTERNO)
  return rid
}

async function chiama(metodo: 'GET' | 'POST' | 'DELETE', percorso?: string) {
  const { GET, POST } = await import('@/app/api/admin/crm/integrazioni/route')
  const { DELETE } = await import('@/app/api/admin/crm/integrazioni/[id]/route')
  if (metodo === 'GET') return GET(richiesta('GET', percorso ?? BASE + '?scuolaId=' + SEDE_A))
  if (metodo === 'POST') return POST(richiesta('POST', percorso, { scuolaId: SEDE_A, nome: 'Assistente' }))
  return DELETE(richiesta('DELETE', percorso ?? BASE + '/' + INTEGRAZIONE_A), { params: Promise.resolve({ id: INTEGRAZIONE_A }) })
}

describe('Privacy del registro · gestione chiavi CRM', () => {
  it.each([
    ['GET', 'XX000', 'error', '/api/admin/crm/integrazioni'],
    ['POST', 'XX000', 'error', '/api/admin/crm/integrazioni'],
    ['DELETE', 'XX000', 'error', '/api/admin/crm/integrazioni/[id]'],
    ['GET', '42P01', 'warn', '/api/admin/crm/integrazioni'],
  ] as const)('%s con errore di scope %s conserva solo il codice nei due log', async (metodo, code, livello, path) => {
    h.code = code
    const r = await chiama(metodo)
    expect(r.status).toBe(403)
    expect(await r.json()).toMatchObject({ codice: 'SEDE_NON_ACCESSIBILE' })
    expect(h.getUser).toHaveBeenCalledOnce()
    expect(rete.mock.calls.some(([url]) => new URL(String(url)).pathname === '/rest/v1/utenti_scuole')).toBe(true)

    await vi.waitFor(() => {
      expect(righeLog().filter((riga) => riga.codice === code).map(({ evento }) => evento).sort()).toEqual(['auth', 'db'])
    })
    const righe = righeLog()
    nessunDato(righe, consoleLog(), [TESTO, DETTAGLI, SUGGERIMENTO, ID_ESTERNO])
    const rid = ridProtetto(r)
    expect(righe).toEqual(expect.arrayContaining([
      expect.objectContaining({ evento: 'auth', codice: code, route: path, request_id: rid, livello }),
      expect.objectContaining({ evento: 'db', codice: code, route: path, request_id: rid, stato_http: 400 }),
    ]))
    expect(consoleLog()).toContain('rid=' + rid)
    expect(righe.every((riga) => riga.contesto?.payload === undefined)).toBe(true)
  })

  it.each([
    ['utenti', 'XX000', 'XX000'],
    ['parents', 'P0001:codice-sintetico-non-valido', undefined],
  ] as const)('il gate reale protegge anche un errore della risorsa identità %s', async (risorsa, code, codiceAtteso) => {
    h.risorsaIdentita = risorsa
    h.code = code
    const r = await chiama('GET')
    expect(r.status).toBe(403)
    await vi.waitFor(() => expect(righeLog()).toContainEqual(expect.objectContaining({
      evento: 'auth', livello: 'warn', codice: codiceAtteso,
      contesto: expect.objectContaining({ campi: expect.objectContaining({ esito: risorsa + '-non-letti' }) }),
    })))
    const rid = ridProtetto(r)
    expect(righeLog().every((riga) => riga.request_id === rid)).toBe(true)
    nessunDato(righeLog(), consoleLog(), [TESTO, DETTAGLI, SUGGERIMENTO, ID_ESTERNO, 'codice-sintetico-non-valido'])
  })

  it.each([
    ['errore restituito', 'auth_sessione_non_verificata', true],
    ['eccezione', 'auth_sessione_non_leggibile', false],
  ] as const)('il gate restituisce 401 e protegge il guasto di sessione: %s', async (_caso, codice, restituito) => {
    const guasto = Object.assign(new Error(TESTO, { cause: new Error(DETTAGLI) }), {
      code: SUGGERIMENTO, status: 500,
    })
    if (restituito) h.getUser.mockResolvedValue({ data: { user: null }, error: guasto })
    else h.getUser.mockRejectedValue(guasto)
    const r = await chiama('GET')
    expect(r.status).toBe(401)
    expect(rete).not.toHaveBeenCalled()
    expect(consoleLog()).toContain('code=' + codice)
    if (restituito) {
      await vi.waitFor(() => expect(righeLog()).toContainEqual(expect.objectContaining({
        evento: 'auth', livello: 'error', codice, request_id: r.headers.get('x-request-id'),
      })))
    }
    ridProtetto(r)
    nessunDato(righeLog(), consoleLog(), [TESTO, DETTAGLI, SUGGERIMENTO, ID_ESTERNO])
  })

  it('il 400 con sessione resta nel registro con il RID della risposta e senza il corpo rifiutato', async () => {
    const { POST } = await import('@/app/api/admin/crm/integrazioni/route')
    const r = await POST(richiesta('POST', BASE, { scuolaId: SEDE_A, nome: 'Assistente', estraneo: ID_ESTERNO }))
    expect(r.status).toBe(400)
    expect(h.getUser).toHaveBeenCalledOnce()
    expect(rete.mock.calls.map(([url]) => new URL(String(url)).pathname).sort()).toEqual(['/rest/v1/parents', '/rest/v1/utenti'])
    await vi.waitFor(() => {
      expect(righeLog()).toContainEqual(expect.objectContaining({ evento: 'route', livello: 'warn', stato_http: 400 }))
    })
    const righe = righeLog()
    expect(righe.every((riga) => riga.contesto?.payload === undefined)).toBe(true)
    nessunDato(righe, consoleLog(), [ID_ESTERNO, SEDE_A])
    expect(righe[0].request_id).toBe(ridProtetto(r))
  })

  it('riconosce il nome tecnico delle chiavi in una delega con URL differente', async () => {
    const { withRoute } = await import('@/lib/logging/with-route')
    const { POST } = await import('@/app/api/admin/crm/integrazioni/route')
    const r = await withRoute('prova/delega:POST', POST)(
      richiesta('POST', '/api/prova', { scuolaId: SEDE_A, nome: 'Assistente', estraneo: ID_ESTERNO }),
    )
    expect(r.status).toBe(400)
    await vi.waitFor(() => expect(righeLog()).toHaveLength(2))
    const rid = ridProtetto(r)
    expect(righeLog().map((riga) => riga.request_id)).toEqual([rid, rid])
    nessunDato(righeLog(), consoleLog(), [ID_ESTERNO, SEDE_A])
  })

  it('protegge dal path del singolo id anche con un nome tecnico generico', async () => {
    const { withRoute } = await import('@/lib/logging/with-route')
    const { parseData } = await import('@/lib/validation/http')
    const { zUuid } = await import('@/lib/validation/common')
    const r = await withRoute('prova/path:DELETE', async () => {
      parseData(zUuid, ID_ESTERNO)
      return new Response(null, { status: 409 })
    })(richiesta('DELETE', BASE + '/' + ID_ESTERNO))
    await vi.waitFor(() => expect(righeLog()).toHaveLength(1))
    expect(righeLog()[0]).toMatchObject({ request_id: ridProtetto(r), route: BASE + '/[id]' })
    nessunDato(righeLog(), consoleLog(), [ID_ESTERNO])
  })

  it.each([
    ['admin/crm/integrazioni:GET', '/api/altro', BASE],
    [undefined, BASE + '/' + INTEGRAZIONE_A, BASE + '/[id]'],
  ])('il fetch riconosce la gestione chiavi anche da un contesto ordinario: %s %s', async (route, path, pathTecnico) => {
    const { conContesto } = await import('@/lib/logging/context')
    const { createAdminClient } = await import('@/lib/supabase/server-client')
    const iniziale = { route, path, requestId: ID_ESTERNO, payload: { body: { estraneo: ID_ESTERNO } } }
    await conContesto(iniziale, async () => {
      const db = await createAdminClient()
      const { error } = await db.from('utenti_scuole').select('scuola_id')
      expect(error).toMatchObject({ code: 'XX000', message: TESTO, details: DETTAGLI, hint: SUGGERIMENTO })
    })
    await vi.waitFor(() => expect(righeLog()).toHaveLength(1))
    const [riga] = righeLog()
    expect(riga).toMatchObject({ evento: 'db', codice: 'XX000', route: pathTecnico, request_id: expect.stringMatching(UUID) })
    expect(riga.contesto).not.toHaveProperty('payload')
    nessunDato([riga], consoleLog(), [TESTO, DETTAGLI, SUGGERIMENTO, ID_ESTERNO])
  })

  it.each([
    ['admin/crm/integrazioni-extra:POST', BASE + '-extra'],
    ['admin/crm/integrazioni/[id]/altro:POST', BASE + '/' + INTEGRAZIONE_A + '/altro'],
  ])('le rotte ordinarie %s conservano i log esistenti mentre una richiesta protetta è in corso', async (nome, percorso) => {
    const [{ withRoute }, { parseBody }, { z }, { createAdminClient }, { scuoleDiUtente }] = await Promise.all([
      import('@/lib/logging/with-route'), import('@/lib/validation/http'), import('zod'),
      import('@/lib/supabase/server-client'), import('@/lib/auth/scope'),
    ])
    const ridOrdinario = 'trace-ordinaria'
    const extraOrdinario = '40000000-0000-4000-8000-000000000002'
    const ordinaria = withRoute(nome, async (req: Request) => {
      await scuoleDiUtente(await createAdminClient(), { id: ADMIN, role: 'admin', scuola_id: null })
      const b = await parseBody(req, z.object({}).strict())
      return 'response' in b ? b.response : new Response(null, { status: 204 })
    })
    const [rOrdinaria, rProtetta] = await Promise.all([
      ordinaria(richiesta('POST', percorso, { estraneo: extraOrdinario }, ridOrdinario)),
      chiama('GET'),
    ])
    expect(rOrdinaria.status).toBe(400)
    expect(rOrdinaria.headers.get('x-request-id')).toBe(ridOrdinario)
    const rid = ridProtetto(rProtetta)
    await vi.waitFor(() => {
      const normali = righeLog().filter((riga) => riga.request_id === ridOrdinario)
      expect(normali).toEqual(expect.arrayContaining([
        expect.objectContaining({ evento: 'db', messaggio: TESTO }),
        expect.objectContaining({ evento: 'auth', messaggio: TESTO }),
        expect.objectContaining({ evento: 'route', contesto: expect.objectContaining({ payload: { body: { estraneo: extraOrdinario } } }) }),
      ]))
      expect(righeLog().filter((riga) => riga.request_id === rid && riga.codice === 'XX000').map(({ evento }) => evento).sort())
        .toEqual(['auth', 'db'])
    })
    nessunDato(righeLog().filter((riga) => riga.request_id === rid), '', [TESTO, DETTAGLI, SUGGERIMENTO, ID_ESTERNO, extraOrdinario])
  })
})
