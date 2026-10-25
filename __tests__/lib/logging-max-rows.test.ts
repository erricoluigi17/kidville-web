import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { maxRowsRaggiunto } from '@/lib/logging/supabase-fetch'

/**
 * `max-rows-raggiunto` (robustezza 2, sessione 11).
 *
 * PostgREST taglia ogni risposta a `max_rows` (1000, `supabase/config.toml:18`) e non lo dice:
 * nessun errore, nessuno status diverso. L'unica traccia è `Content-Range`, che il client legge
 * solo per il conteggio. Qui si prova la regola che la trasforma in un `warn` persistito, con la
 * tabella e la route — e soprattutto i casi in cui NON deve scattare: le pagine di
 * `leggiABlocchi` (`.range(0, 999)` chiede `limit=1000` e riceve `0-999/*`) sono piene per
 * scelta, non per taglio. Se scattassero, il segnale non andrebbe mai a zero.
 */

type Riga = {
  livello: string
  evento: string
  messaggio: string
  statoHttp?: number
  bersaglio?: string
  contestoExtra?: { campi?: Record<string, unknown> }
}

/**
 * `SILENZIOSO` si valuta al caricamento di `logger.ts`: si ricarica il registro con `VITEST`
 * vuota. `app-log` è mockato perché `.env.local` punta alla produzione. Il mock annota la route
 * del contesto nel momento della scrittura: è ciò che `app-log.ts` mette nella colonna `route`.
 */
async function carica() {
  const percorsi: (string | undefined)[] = []
  const appLog = vi.fn<(riga: Riga) => Promise<void>>(async () => {})
  vi.resetModules()
  vi.doMock('@/lib/logging/app-log', () => ({ appLog }))
  const strumento = await import('@/lib/logging/supabase-fetch')
  const context = await import('@/lib/logging/context')
  appLog.mockImplementation(async () => {
    percorsi.push(context.contesto()?.path)
  })
  return { ...strumento, ...context, appLog, percorsi }
}

const TABELLA = 'https://x.supabase.co/rest/v1/alunni?select=id%2Cscuola_id&scuola_id=in.%28a%29'
const RPC = 'https://x.supabase.co/rest/v1/rpc/conta_cose'

function ok(contentRange?: string): Response {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (contentRange) headers['content-range'] = contentRange
  return new Response('[]', { status: 200, headers })
}

describe('maxRowsRaggiunto — la regola, con intestazioni finte', () => {
  const base = { verbo: 'GET', area: 'db' as const, url: TABELLA }

  it.each([
    ['0-999/*', TABELLA, { righe: 1000, limite: undefined }],
    ['0-999/1500', TABELLA, { righe: 1000, limite: undefined }],
    ['0-999/*', `${TABELLA}&limit=5000`, { righe: 1000, limite: 5000 }],
    ['1000-1999/*', `${TABELLA}&offset=1000&limit=2000`, { righe: 1000, limite: 2000 }],
  ])('%s su %s → scatta', (contentRange, url, atteso) => {
    expect(maxRowsRaggiunto({ ...base, url, contentRange })).toEqual(atteso)
  })

  it('anche una funzione chiamata in GET (`rpc`) può essere tagliata', () => {
    expect(maxRowsRaggiunto({ ...base, area: 'rpc', url: RPC, contentRange: '0-999/*' })).toEqual({
      righe: 1000,
      limite: undefined,
    })
  })

  it.each([
    ['0-998/999', TABELLA, 'meno di max_rows'],
    // Senza il totale a dirlo: 999 righe sono sotto il tetto da sole. È il caso che distingue
    // la soglia `>= 1000` da una `>= 999` (con `0-998/999` lo maschererebbe il totale).
    ['0-998/*', TABELLA, 'una riga sotto il tetto, totale ignoto'],
    ['0-999/1000', TABELLA, 'il totale dice che è arrivato tutto'],
    ['0-999/*', `${TABELLA}&offset=0&limit=1000`, 'la prima pagina di leggiABlocchi'],
    ['1000-1999/*', `${TABELLA}&offset=1000&limit=1000`, 'la seconda pagina di leggiABlocchi'],
    ['*/0', TABELLA, 'risposta vuota'],
    [null, TABELLA, 'intestazione assente'],
    ['0-999', TABELLA, 'intestazione fuori forma'],
  ])('%s su %s → non scatta (%s)', (contentRange, url, motivo) => {
    expect(maxRowsRaggiunto({ ...base, url, contentRange }), motivo).toBeNull()
  })

  // Fino al 25/10 qui si fissava il contrario («POST non scatta»), e il ramo `rpc` della regola
  // era morto: `rpc()` di postgrest-js chiama in POST salvo `{ get: true }`.
  it('una funzione chiamata in POST (`rpc()` di postgrest-js) che riceve 0-999/* scatta, come in GET', () => {
    expect(maxRowsRaggiunto({ ...base, verbo: 'POST', area: 'rpc', url: RPC, contentRange: '0-999/*' })).toEqual({
      righe: 1000,
      limite: undefined,
    })
    expect(maxRowsRaggiunto({ ...base, verbo: 'POST', area: 'rpc', url: `${RPC}?limit=5000`, contentRange: '0-999/1500' })).toEqual({
      righe: 1000,
      limite: 5000,
    })
  })

  it.each([
    ['0-998/*', RPC, 'meno di max_rows'],
    ['0-999/1000', RPC, 'il totale dice che è arrivato tutto'],
    ['0-999/*', `${RPC}?offset=0&limit=1000`, 'la pagina di leggiABlocchi su una funzione'],
    [null, RPC, 'intestazione assente (PostgREST potrebbe non mandarla su una POST)'],
  ])('POST rpc con %s su %s → non scatta (%s)', (contentRange, url, motivo) => {
    expect(maxRowsRaggiunto({ ...base, verbo: 'POST', area: 'rpc', url, contentRange }), motivo).toBeNull()
  })

  it('una POST a una TABELLA è un INSERT: non scatta, nemmeno con 0-999/*', () => {
    expect(maxRowsRaggiunto({ ...base, verbo: 'POST', area: 'db', contentRange: '0-999/*' })).toBeNull()
  })

  it.each(['PATCH', 'PUT', 'DELETE', 'HEAD'])('%s non scatta, né su una tabella né su una funzione, nemmeno con 0-999/*', (verbo) => {
    expect(maxRowsRaggiunto({ ...base, verbo, contentRange: '0-999/*' })).toBeNull()
    expect(maxRowsRaggiunto({ ...base, verbo, area: 'rpc', url: RPC, contentRange: '0-999/*' })).toBeNull()
  })

  it('una POST verso storage o auth non scatta', () => {
    expect(maxRowsRaggiunto({ ...base, verbo: 'POST', area: 'storage', contentRange: '0-999/*' })).toBeNull()
    expect(maxRowsRaggiunto({ ...base, verbo: 'POST', area: 'auth', contentRange: '0-999/*' })).toBeNull()
  })

  it('storage e auth non scattano: max_rows è di PostgREST', () => {
    expect(maxRowsRaggiunto({ ...base, area: 'storage', contentRange: '0-999/*' })).toBeNull()
    expect(maxRowsRaggiunto({ ...base, area: 'auth', contentRange: '0-999/*' })).toBeNull()
  })
})

describe('supabase-fetch — la riga `max-rows-raggiunto`', () => {
  let err: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.stubEnv('VITEST', '')
    vi.stubEnv('KV_LOG_LEVEL', '')
    vi.spyOn(console, 'log').mockImplementation(() => {})
    err = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.doUnmock('@/lib/logging/app-log')
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('una GET senza `limit` che riceve 0-999/*: un warn persistito, con la tabella e la route', async () => {
    const { creaFetchStrumentato, conContesto, appLog, percorsi } = await carica()
    const f = creaFetchStrumentato(async () => ok('0-999/*'))

    const res = await conContesto({ requestId: 'r1', path: '/api/admin/parents' }, () => f(TABELLA))

    // La risposta arriva intatta: il segnale osserva, non cambia niente.
    expect(res.status).toBe(200)
    // …e il corpo non è stato toccato: postgrest-js lo deve ancora leggere.
    expect(res.bodyUsed).toBe(false)
    expect(await res.text()).toBe('[]')
    expect(appLog).toHaveBeenCalledTimes(1)
    const riga = appLog.mock.calls[0][0]
    expect(riga).toMatchObject({ livello: 'warn', evento: 'db', messaggio: 'max-rows-raggiunto', statoHttp: 200 })
    expect(riga.contestoExtra?.campi).toMatchObject({ operazione: 'alunni', righe: 1000, esito: 'max-rows-raggiunto' })
    // Una riga per tabella: due letture troncate sulla stessa route non si sommano in una.
    expect(riga.bersaglio).toBe('operazione=alunni')
    expect(percorsi).toEqual(['/api/admin/parents'])
    // Niente della query string (i filtri di PostgREST, dove stanno i valori) entra nella riga.
    expect(JSON.stringify(riga)).not.toContain('scuola_id')
    // Su Vercel esce come KV_WARN, sul canale degli errori (console.warn non si usa).
    const testo = err.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')
    expect(testo).toContain('KV_WARN')
    expect(testo).toContain('esito=max-rows-raggiunto')
    expect(testo).not.toContain('scuola_id')
  })

  it('la pagina di leggiABlocchi (offset=0&limit=1000, 0-999/*) non scrive niente', async () => {
    const { creaFetchStrumentato, appLog } = await carica()
    const f = creaFetchStrumentato(async () => ok('0-999/*'))
    await f(`${TABELLA}&offset=0&limit=1000`)
    expect(appLog).not.toHaveBeenCalled()
  })

  it('0-998/999 non scrive niente', async () => {
    const { creaFetchStrumentato, appLog } = await carica()
    const f = creaFetchStrumentato(async () => ok('0-998/999'))
    await f(TABELLA)
    expect(appLog).not.toHaveBeenCalled()
  })

  it('una POST a una funzione (rpc) con 0-999/*: un warn persistito, col nome della funzione e solo numeri', async () => {
    const { creaFetchStrumentato, conContesto, appLog, percorsi } = await carica()
    const f = creaFetchStrumentato(async () => ok('0-999/*'))
    const res = await conContesto({ requestId: 'r2', path: '/api/admin/dashboard' }, () =>
      f(RPC, { method: 'POST', body: '{"p_scuola_id":"a"}' }),
    )
    expect(res.status).toBe(200)
    expect(res.bodyUsed).toBe(false)
    expect(appLog).toHaveBeenCalledTimes(1)
    const riga = appLog.mock.calls[0][0]
    expect(riga).toMatchObject({ livello: 'warn', evento: 'rpc', messaggio: 'max-rows-raggiunto', statoHttp: 200 })
    expect(riga.contestoExtra?.campi).toMatchObject({ operazione: 'conta_cose', righe: 1000, esito: 'max-rows-raggiunto' })
    expect(riga.bersaglio).toBe('operazione=conta_cose')
    expect(percorsi).toEqual(['/api/admin/dashboard'])
    // Il corpo della richiesta (gli argomenti della funzione) non entra nella riga.
    expect(JSON.stringify(riga)).not.toContain('p_scuola_id')
  })

  it('una POST a una funzione con meno di 1000 righe (0-998/*) non scrive niente', async () => {
    const { creaFetchStrumentato, appLog } = await carica()
    const f = creaFetchStrumentato(async () => ok('0-998/*'))
    await f(RPC, { method: 'POST', body: '{}' })
    expect(appLog).not.toHaveBeenCalled()
  })

  it('una POST a una tabella (INSERT) con 0-999/* non scrive niente', async () => {
    const { creaFetchStrumentato, appLog } = await carica()
    const f = creaFetchStrumentato(async () => ok('0-999/*'))
    await f(TABELLA, { method: 'POST', body: '[]' })
    expect(appLog).not.toHaveBeenCalled()
  })

  it('FAIL-OPEN: intestazioni che lanciano non tolgono la risposta al chiamante', async () => {
    const { creaFetchStrumentato, appLog } = await carica()
    const ostile = ok('0-999/*')
    Object.defineProperty(ostile, 'headers', {
      get() {
        throw new Error('getter ostile')
      },
    })
    const f = creaFetchStrumentato(async () => ostile)
    await expect(f(TABELLA)).resolves.toBe(ostile)
    expect(appLog).not.toHaveBeenCalled()
  })

  it('FAIL-OPEN: un guasto nella lettura del tetto non spegne la riga della risposta lenta', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { creaFetchStrumentato, appLog } = await carica()
    const ostile = ok('0-999/*')
    Object.defineProperty(ostile, 'headers', {
      get() {
        throw new Error('getter ostile')
      },
    })
    // Oltre `LENTA_MS` (500): la riga `lenta=true` deve uscire anche se `registraMaxRows` è saltata.
    const f = creaFetchStrumentato(async () => {
      await new Promise((r) => setTimeout(r, 520))
      return ostile
    })
    await expect(f(TABELLA)).resolves.toBe(ostile)
    expect(appLog).not.toHaveBeenCalled()
    const testo = log.mock.calls.map((c) => String(c[0])).join('\n')
    expect(testo).toContain('lenta=true')
  })

  it.each([
    ['abc'],
    ['999-0/*'],
    ['0-99999999999999999999/*'],
    ['-1-999/*'],
    ['0-999/abc'],
  ])('FAIL-OPEN: Content-Range malformato (%s) → risposta intatta, corpo intatto, nessuna riga', async (cr) => {
    const { creaFetchStrumentato, appLog } = await carica()
    const risposta = ok(cr)
    const f = creaFetchStrumentato(async () => risposta)
    const res = await f(TABELLA)
    expect(res).toBe(risposta)
    expect(res.bodyUsed).toBe(false)
    expect(await res.text()).toBe('[]')
    expect(appLog).not.toHaveBeenCalled()
  })

  it('FAIL-OPEN: una «Response» senza intestazioni arriva al chiamante così com\'è', async () => {
    const { creaFetchStrumentato, appLog } = await carica()
    const strana = { ok: true, status: 200 } as unknown as Response
    const f = creaFetchStrumentato(async () => strana)
    await expect(f(TABELLA)).resolves.toBe(strana)
    expect(appLog).not.toHaveBeenCalled()
  })
})
