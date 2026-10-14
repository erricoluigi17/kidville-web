// @vitest-environment node

import { NextRequest, NextResponse } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { haUnRuolo, RUOLI_DIREZIONE, type AppUser, type StaffRole } from '@/lib/auth/predicati-ruolo'

const h = vi.hoisted(() => ({
  user: null as AppUser | null,
  requireStaff: vi.fn(),
  scope: vi.fn(),
  rpc: vi.fn(),
  scuole: vi.fn(),
  createAdminClient: vi.fn(),
  logEvento: vi.fn(),
  logErrore: vi.fn(),
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
// I/O finto; i predicati sui ruoli e la restrizione di sede restano reali.
vi.mock('@/lib/auth/scope', async (importActual) => ({
  restringiSedi: (await importActual<typeof import('@/lib/auth/scope')>()).restringiSedi,
  resolveScuoleAttive: h.scope,
}))
vi.mock('@/lib/logging/logger', () => ({ logEvento: h.logEvento, logErrore: h.logErrore, logOk: vi.fn() }))
vi.mock('@/lib/supabase/server-client', () => ({ createAdminClient: h.createAdminClient }))

import { GET } from '@/app/api/pagamenti/cassa/dettaglio/route'

const SEDE = 'a0000000-0000-4000-8000-000000000001'
const SEDE_B = 'a0000000-0000-4000-8000-000000000002'
const CAT = 'c0000000-0000-4000-8000-000000000001'
const righe = [{
  id: 'e0000000-0000-4000-8000-000000000001', origine: 'cassa', scuola_id: SEDE, scuola_nome: null,
  data: '2026-10-14', categoria_id: null, categoria_nome: null, metodo: 'contanti', importo: 12.50,
  descrizione: 'Testo privato fittizio', note: 'Nota privata fittizia', allegato_path: null,
  storno_di: null, stornato_il: null, pagamento_id: null,
}]

const request = (query = 'tipo=uscita') => new NextRequest(`http://localhost/api/pagamenti/cassa/dettaglio?${query}`)
const controllaCache = (response: Response) => expect(response.headers.get('Cache-Control')).toBe('no-store')

beforeEach(() => {
  vi.resetAllMocks()
  h.user = { id: 'd0000000-0000-4000-8000-000000000001', role: 'admin' }
  h.requireStaff.mockImplementation(async (_request: Request, allowed: readonly StaffRole[] = ['admin', 'coordinator', 'segreteria']) => {
    if (!h.user) return { response: NextResponse.json({ error: 'Non autenticato' }, { status: 401 }) }
    if (!haUnRuolo(h.user, allowed)) return { response: NextResponse.json({ error: 'Accesso negato' }, { status: 403 }) }
    return { user: h.user }
  })
  h.scope.mockResolvedValue([SEDE, SEDE_B])
  h.rpc.mockResolvedValue({ data: { righe, conteggio: 1206, totale: 1507.50, contanti: 1000, altri: 507.50 }, error: null })
  h.scuole.mockResolvedValue({ data: [{ id: SEDE, nome: 'Sede prova' }, { id: SEDE_B, nome: 'Seconda sede' }], error: null })
  h.createAdminClient.mockResolvedValue({ rpc: h.rpc, from: (tabella: string) => {
    if (tabella !== 'schools') throw new Error(`lettura inattesa ${tabella}`)
    return { select: () => ({ in: (_colonna: string, sedi: string[]) => h.scuole(sedi) }) }
  } })
})

describe('dettaglio cassa · gates, filtri, osservabilità e schema assente', () => {
  it('Direzione: restituisce righe con sedi, tutti i totali e default di pagina', async () => {
    const response = await GET(request())
    expect(response.status).toBe(200)
    controllaCache(response)
    expect(await response.json()).toEqual({ disponibile: true, righe: [{ ...righe[0], scuola_nome: 'Sede prova' }], conteggio: 1206, pagina: 1, limite: 50, totali: { totale: 1507.50, contanti: 1000, altri: 507.50 } })
    expect(h.rpc).toHaveBeenCalledWith('report_cassa_dettaglio', {
      p_scuola_ids: [SEDE, SEDE_B], p_tipo: 'uscita', p_da: null, p_a: null, p_categoria: null,
      p_senza_categoria: false, p_metodo: null, p_limite: 50, p_offset: 0,
    })
    expect(h.logEvento).toHaveBeenCalledWith('cassa', 'info', expect.objectContaining({ operazione: 'dettaglio:GET', esito: 'letto', conteggio: 1206, pagina: 1 }))
    expect(JSON.stringify(h.logEvento.mock.calls)).not.toContain('Testo privato')
    expect(JSON.stringify(h.logEvento.mock.calls)).not.toContain('Nota privata')
  })

  it('Segreteria: elenco uscite e conteggio senza alcun totale', async () => {
    h.user = { id: 'staff', role: 'segreteria' }
    const response = await GET(request())
    const body = await response.json()
    expect(response.status).toBe(200)
    controllaCache(response)
    expect(body.righe).toHaveLength(1)
    expect(body.conteggio).toBe(1206)
    for (const chiave of ['totali', 'totale', 'contanti', 'altri']) expect(body).not.toHaveProperty(chiave)
  })

  it.each(['admin', 'coordinator'] as const)('entrate: autorizza %s attraverso RUOLI_DIREZIONE', async (role) => {
    h.user = { id: 'direzione', role }
    const response = await GET(request('tipo=entrata'))
    expect(response.status).toBe(200)
    controllaCache(response)
    expect(h.requireStaff).toHaveBeenCalledWith(expect.anything(), RUOLI_DIREZIONE)
    expect((await response.json()).totali).toBeDefined()
  })

  it('ruolo attivo genitore con ruolo reale Direzione mantiene l’autorizzazione', async () => {
    h.user = { id: 'direzione', role: 'genitore', ruoli: ['coordinator', 'genitore'] }
    const response = await GET(request('tipo=entrata'))
    expect(response.status).toBe(200)
    expect((await response.json()).totali).toBeDefined()
    controllaCache(response)
  })

  it('ruolo attivo admin forgiato non concede i totali a uno staff reale operativo', async () => {
    h.user = { id: 'staff', role: 'admin', ruoli: ['segreteria'] }
    const response = await GET(request())
    expect(response.status).toBe(200)
    expect(await response.json()).not.toHaveProperty('totali')
    const entrate = await GET(request('tipo=entrata'))
    expect(entrate.status).toBe(403)
    controllaCache(entrate)
  })

  for (const role of ['segreteria', 'educator', 'genitore', 'cuoca'] as const) {
    it(`entrate negate a ${role} prima di qualsiasi RPC`, async () => {
      h.user = { id: 'utente', role }
      const response = await GET(request('tipo=entrata'))
      expect(response.status).toBe(403)
      controllaCache(response)
      expect(h.rpc).not.toHaveBeenCalled()
      expect(h.createAdminClient).not.toHaveBeenCalled()
    })
  }

  it.each(['educator', 'genitore', 'cuoca'] as const)('uscite negate a %s', async (role) => {
    h.user = { id: 'utente', role }
    const response = await GET(request())
    expect(response.status).toBe(403)
    controllaCache(response)
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('non autenticato: 401 no-store senza RPC', async () => {
    h.user = null
    const response = await GET(request())
    expect(response.status).toBe(401)
    controllaCache(response)
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('filtri sede/categoria/date/metodo e offset sono passati alla singola RPC', async () => {
    const response = await GET(request(`tipo=uscita&scuola_id=${SEDE}&categoria_id=${CAT}&da=2026-10-01&a=2026-10-14&metodo=carta&pagina=3&limite=100`))
    expect(response.status).toBe(200)
    expect(h.rpc).toHaveBeenCalledWith('report_cassa_dettaglio', {
      p_scuola_ids: [SEDE], p_tipo: 'uscita', p_da: '2026-10-01', p_a: '2026-10-14', p_categoria: CAT,
      p_senza_categoria: false, p_metodo: 'carta', p_limite: 100, p_offset: 200,
    })
    expect(await response.json()).toMatchObject({ pagina: 3, limite: 100 })
  })

  it('categoria_id=senza diventa il filtro esplicito NULL', async () => {
    await GET(request('tipo=entrata&categoria_id=senza&metodo=pos'))
    expect(h.rpc).toHaveBeenCalledWith('report_cassa_dettaglio', expect.objectContaining({ p_categoria: null, p_senza_categoria: true, p_metodo: 'pos' }))
  })

  it('scope vuoto resta array vuoto e una sede fuori scope è negata e loggata', async () => {
    h.scope.mockResolvedValue([])
    h.rpc.mockResolvedValue({ data: { righe: [], conteggio: 0, totale: 0, contanti: 0, altri: 0 }, error: null })
    const vuota = await GET(request())
    expect(await vuota.json()).toMatchObject({ righe: [], conteggio: 0 })
    expect(h.rpc).toHaveBeenCalledWith('report_cassa_dettaglio', expect.objectContaining({ p_scuola_ids: [] }))
    controllaCache(vuota)
    h.rpc.mockClear()
    const negata = await GET(request(`tipo=uscita&scuola_id=${SEDE}`))
    expect(negata.status).toBe(403)
    controllaCache(negata)
    expect(h.rpc).not.toHaveBeenCalled()
    expect(h.logEvento).toHaveBeenCalledWith('multi_sede', 'warn', expect.objectContaining({ esito: 'sede-filtro-fuori-scope' }))
  })

  it.each([
    '', 'tipo=prelievo', 'tipo=uscita&categoria_id=errata', 'tipo=uscita&scuola_id=errata',
    'tipo=uscita&da=2026-02-30', 'tipo=uscita&da=2026-10-15&a=2026-10-01', 'tipo=uscita&metodo=credito_famiglia',
    'tipo=uscita&pagina=0', 'tipo=uscita&pagina=1.5', 'tipo=uscita&pagina=999999999999999999999',
    'tipo=uscita&pagina=2147483647&limite=100', 'tipo=uscita&limite=101', 'tipo=uscita&limite=0',
  ])('query non valida %s: 400 no-store senza query DB', async (query) => {
    const response = await GET(request(query))
    expect(response.status).toBe(400)
    controllaCache(response)
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it.each(['42P01', '42703', 'PGRST202', 'PGRST204', 'PGRST205'])('schema assente %s: degradazione completa e log, nessun fallback', async (code) => {
    h.rpc.mockResolvedValue({ data: null, error: { code, message: 'Schema non disponibile' } })
    const response = await GET(request())
    expect(response.status).toBe(200)
    controllaCache(response)
    expect(await response.json()).toEqual({ disponibile: false, righe: [], conteggio: 0, pagina: 1, limite: 50 })
    expect(h.scuole).not.toHaveBeenCalled()
    expect(h.logEvento).toHaveBeenCalledWith('cassa', 'info', expect.objectContaining({ esito: 'schema-assente' }))
  })

  it('PostgREST error: 500 loggato, no-store e niente aggregati parziali', async () => {
    const error = { code: 'XX000', message: 'Errore SQL' }
    h.rpc.mockResolvedValue({ data: null, error })
    const response = await GET(request())
    expect(response.status).toBe(500)
    controllaCache(response)
    expect(await response.json()).toMatchObject({ codice: 'LETTURA_FALLITA' })
    expect(h.logErrore).toHaveBeenCalledWith(expect.objectContaining({ evento: 'db', stato: 500 }), error)
    expect(h.scuole).not.toHaveBeenCalled()
  })

  it('eccezione: 500 e log di errore senza dati personali', async () => {
    const error = new Error('Connessione interrotta')
    h.rpc.mockRejectedValue(error)
    const response = await GET(request())
    expect(response.status).toBe(500)
    controllaCache(response)
    expect(h.logErrore).toHaveBeenCalledWith(expect.objectContaining({ stato: 500 }), error)
  })

  it('risposta RPC invalida: fallisce con log invece di pubblicare dettagli incompleti', async () => {
    h.rpc.mockResolvedValue({ data: null, error: null })
    const response = await GET(request())
    expect(response.status).toBe(500)
    controllaCache(response)
    expect(h.logErrore).toHaveBeenCalled()
    expect(await response.json()).not.toHaveProperty('totali')
  })

  it('nomi sede non disponibili: nome nullable e warning, dettaglio comunque completo', async () => {
    h.scuole.mockResolvedValue({ data: null, error: { code: 'XX000' } })
    const response = await GET(request())
    expect(response.status).toBe(200)
    controllaCache(response)
    expect((await response.json()).righe[0].scuola_nome).toBeNull()
    expect(h.logEvento).toHaveBeenCalledWith('cassa', 'warn', expect.objectContaining({ esito: 'nomi-sedi-non-letti' }), expect.anything())
  })
})
