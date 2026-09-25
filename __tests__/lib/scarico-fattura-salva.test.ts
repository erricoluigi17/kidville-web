import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const PAGAMENTO = '10000000-0000-4000-8000-000000000001'
const FATTURA = '20000000-0000-4000-8000-000000000002'
const UTENTE = '30000000-0000-4000-8000-000000000003'
const STORAGE = 'https://uimulkjyekgemjakmepp.supabase.co'

const h = vi.hoisted(() => ({
  nativo: false,
  filesystem: false,
  share: true,
  scaricaDocumento: vi.fn(),
  telemetria: vi.fn(async (input: { esito: string }) => {
    void input
  }),
  assign: vi.fn(),
  logClient: vi.fn(),
}))

vi.mock('@/lib/push/native-register', () => ({ isNativeApp: () => h.nativo }))
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isPluginAvailable: (nome: string) => nome === 'Filesystem' ? h.filesystem : nome === 'Share' ? h.share : false,
  },
  registerPlugin: vi.fn(),
}))
// `fileConsegnato` resta quello VERO dell'helper: è la regola che decide «ok» o avviso.
vi.mock('@/lib/native/scarica', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/native/scarica')>()),
  scaricaDocumento: h.scaricaDocumento,
}))
vi.mock('@/lib/pagamenti/esito-fattura', () => ({ registraEsitoFattura: h.telemetria }))
vi.mock('@/lib/supabase/public-config', () => ({
  SUPABASE_URL: 'https://uimulkjyekgemjakmepp.supabase.co',
}))
vi.mock('@/lib/logging/client', () => ({
  logClient: h.logClient,
  nomeErrore: (errore: unknown) => errore instanceof Error ? errore.name : 'ErroreSconosciuto',
}))

import {
  presentazioneSalvataggioFattura,
  salvaFattura,
} from '@/lib/pagamenti/scarico-fattura'

const input = (signal?: AbortSignal) => ({
  pagamentoId: PAGAMENTO,
  fatturaId: FATTURA,
  userId: UTENTE,
  numero: 1948,
  anno: 2026,
  signal,
})

function rispostaEsterna(
  scadeFraMs = 300_000,
  url = `${STORAGE}/storage/v1/object/sign/fatture/f.pdf?token=segreto`,
  dataRisposta?: string,
) {
  return new Response(JSON.stringify({
    success: true,
    data: { url, scade_il: new Date(Date.now() + scadeFraMs).toISOString() },
  }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      ...(dataRisposta === undefined ? {} : { date: dataRisposta }),
    },
  })
}

function differita<T>() {
  let resolve!: (valore: T) => void
  const promise = new Promise<T>((ok) => { resolve = ok })
  return { promise, resolve }
}

beforeEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
  h.nativo = false
  h.filesystem = false
  h.share = true
  h.scaricaDocumento.mockResolvedValue({ esito: 'nativo-file' })
  vi.stubGlobal('location', { origin: 'http://localhost', assign: h.assign })
  vi.stubGlobal('fetch', vi.fn())
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('salvaFattura', () => {
  it('sul web usa la stessa API in attachment e registra soltanto l’avvio', async () => {
    expect(presentazioneSalvataggioFattura()).toEqual({ modalita: 'download-web', etichetta: 'Salva' })

    const esito = await salvaFattura(input())

    expect(esito).toEqual({ ok: true, modalita: 'download-web', avviso: null })
    expect(h.assign).toHaveBeenCalledWith(
      `/api/pagamenti/fattura?pagamento_id=${PAGAMENTO}&userId=${UTENTE}&fattura_id=${FATTURA}&download=1`,
    )
    expect(h.telemetria).toHaveBeenCalledWith({
      pagamentoId: PAGAMENTO,
      fatturaId: FATTURA,
      esito: 'salvataggio_avviato',
    })
    expect(h.telemetria.mock.invocationCallOrder[0]).toBeLessThan(h.assign.mock.invocationCallOrder[0])
    expect(fetch).not.toHaveBeenCalled()
  })

  it('nell’app 1.1 passa da scaricaDocumento: PDF della route in attachment, nome fiscale, etichetta fattura', async () => {
    h.nativo = true
    h.filesystem = true
    expect(presentazioneSalvataggioFattura()).toEqual({ modalita: 'filesystem-nativo', etichetta: 'Salva' })

    const chiamante = new AbortController()
    const esito = await salvaFattura(input(chiamante.signal))

    expect(esito).toEqual({ ok: true, modalita: 'filesystem-nativo', avviso: null })
    expect(h.scaricaDocumento).toHaveBeenCalledOnce()
    // La sorgente è una FUNZIONE del modulo (il tetto ferma la lettura, non il foglio),
    // e all'helper arriva il segnale del CHIAMANTE, identico: mai quello del tetto.
    expect(h.scaricaDocumento).toHaveBeenCalledWith({
      sorgente: expect.any(Function),
      nomeFile: 'fattura-1948-2026.pdf',
      mime: 'application/pdf',
      etichetta: 'fattura',
      signal: chiamante.signal,
    })
    expect(h.telemetria).toHaveBeenCalledWith(expect.objectContaining({ esito: 'salvataggio_avviato' }))
    expect(h.telemetria.mock.invocationCallOrder[0]).toBeLessThan(h.scaricaDocumento.mock.invocationCallOrder[0])
    // Il verdetto lo logga l'helper: salvaFattura non rilogga.
    expect(h.logClient).not.toHaveBeenCalled()
    expect(h.assign).not.toHaveBeenCalled()
    // L'helper finto non l'ha chiamata: nessuna fetch finché la sorgente non è letta.
    expect(fetch).not.toHaveBeenCalled()

    // La sorgente legge la route in attachment, stessa origine e coi cookie.
    // ⚠️ Il corpo è un Uint8Array, MAI un `new Blob(...)`: in jsdom il Blob non ha
    // `stream()`, e `new Response(<Blob di jsdom>)` in Node 22 (la CI) lancia
    // `object.stream is not a function`, in Node 24 esce come il TESTO «[object Blob]».
    // Si asseriscono i BYTE e il tipo: è l'unica verifica vera in entrambi.
    const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]) // «%PDF-1.7»
    vi.mocked(fetch).mockResolvedValueOnce(new Response(PDF, {
      status: 200,
      headers: { 'content-type': 'application/pdf' },
    }))
    const { sorgente } = h.scaricaDocumento.mock.calls[0]?.[0] as { sorgente: () => Promise<Blob> }
    const letto = await sorgente()
    expect(letto.type).toBe('application/pdf')
    expect(Array.from(new Uint8Array(await letto.arrayBuffer()))).toEqual(Array.from(PDF))
    const [url, opzioni] = vi.mocked(fetch).mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`/api/pagamenti/fattura?pagamento_id=${PAGAMENTO}&userId=${UTENTE}&fattura_id=${FATTURA}&download=1`)
    expect(opzioni).toMatchObject({ credentials: 'same-origin' })
    expect(opzioni.signal).toBeInstanceOf(AbortSignal)
    expect(opzioni.signal).not.toBe(chiamante.signal)
  })

  it('la sorgente nativa rifiuta un HTTP non-2xx con `httpStatus`, senza URL nel messaggio', async () => {
    h.nativo = true
    h.filesystem = true
    await salvaFattura(input())
    // Senza segnale del chiamante l'helper non ne riceve nessuno (non quello del tetto).
    expect(h.scaricaDocumento.mock.calls[0]?.[0]).not.toHaveProperty('signal')

    vi.mocked(fetch).mockResolvedValueOnce(new Response('no', { status: 503 }))
    const { sorgente } = h.scaricaDocumento.mock.calls[0]?.[0] as { sorgente: () => Promise<Blob> }
    const errore = await sorgente().then(() => null, (e: unknown) => e)
    expect(errore).toMatchObject({ httpStatus: 503 })
    expect(String((errore as Error).message)).not.toContain('/api/')
  })

  it('il titolo del foglio arriva all’helper, e non è mai un nome di persona per costruzione', async () => {
    h.nativo = true
    h.filesystem = true

    await salvaFattura({ ...input(), titolo: 'Fattura' })

    expect(h.scaricaDocumento).toHaveBeenCalledWith(expect.objectContaining({ titolo: 'Fattura' }))
  })

  it('con Filesystem ma senza Share resta sul ripiego del browser: niente foglio senza il plugin', async () => {
    h.nativo = true
    h.filesystem = true
    h.share = false
    vi.mocked(fetch).mockResolvedValue(rispostaEsterna())

    expect(presentazioneSalvataggioFattura().modalita).toBe('browser-esterno')
    await expect(salvaFattura(input())).resolves.toEqual({ ok: true, modalita: 'browser-esterno', avviso: null })
    expect(h.scaricaDocumento).not.toHaveBeenCalled()
  })

  it.each([
    ['un 503 della route', { esito: 'non-riuscito', motivo: 'http-503' }, 'http-503', 'non-riuscito'],
    ['il foglio che non si apre', { esito: 'non-riuscito', motivo: 'foglio-file-non-aperto' }, 'foglio-file-non-aperto', 'non-riuscito'],
    ['un ripiego col link', { esito: 'ripiego-condivisione', motivo: 'x' }, 'x', 'non-consegnato'],
  ])('nell’app 1.1 %s non è un successo e parla all’utente', async (_caso, verdetto, motivo, avviso) => {
    h.nativo = true
    h.filesystem = true
    h.scaricaDocumento.mockResolvedValue(verdetto)

    await expect(salvaFattura(input())).resolves.toEqual({
      ok: false,
      modalita: 'filesystem-nativo',
      motivo,
      riprovabile: true,
      avviso,
    })
    expect(h.logClient).not.toHaveBeenCalled()
  })

  it('nell’app 1.1 un gesto annullato dall’helper non mostra avvisi', async () => {
    h.nativo = true
    h.filesystem = true
    h.scaricaDocumento.mockResolvedValue({ esito: 'non-riuscito', motivo: 'annullato' })

    await expect(salvaFattura(input())).resolves.toMatchObject({ ok: false, motivo: 'annullato', avviso: null })
  })

  it('un rifiuto inatteso dell’helper diventa un verdetto loggato, e libera il lucchetto', async () => {
    h.nativo = true
    h.filesystem = true
    h.scaricaDocumento.mockRejectedValueOnce(new TypeError('x'))

    await expect(salvaFattura(input())).resolves.toMatchObject({ ok: false, motivo: 'TypeError', avviso: 'non-riuscito' })
    expect(h.logClient).toHaveBeenCalledWith({
      livello: 'error',
      evento: 'fetch',
      messaggio: 'fattura-salvataggio-nativo:eccezione:TypeError',
    })
    await expect(salvaFattura(input())).resolves.toMatchObject({ ok: true })
  })

  it('il codice morto dello scarico vecchio non esiste più', async () => {
    const modulo = await import('@/lib/pagamenti/scarico-fattura')
    expect(Object.keys(modulo)).not.toContain('useScaricoFattura')
    expect(Object.keys(modulo)).not.toContain('apriOScaricaFattura')
  })

  it('senza Filesystem espone l’etichetta browser, chiede esterno senza download e valida il link', async () => {
    h.nativo = true
    h.filesystem = false
    vi.mocked(fetch).mockResolvedValue(rispostaEsterna())
    expect(presentazioneSalvataggioFattura()).toEqual({
      modalita: 'browser-esterno',
      etichetta: 'Apri nel browser per salvare',
    })

    const esito = await salvaFattura(input())

    expect(esito).toEqual({ ok: true, modalita: 'browser-esterno', avviso: null })
    const [url, opzioni] = vi.mocked(fetch).mock.calls[0]
    const richiesta = new URL(String(url), 'http://localhost')
    expect(richiesta.searchParams.get('esterno')).toBe('1')
    expect(richiesta.searchParams.has('download')).toBe(false)
    expect(opzioni).toMatchObject({ credentials: 'same-origin', cache: 'no-store' })
    expect(h.telemetria).toHaveBeenCalledWith({
      pagamentoId: PAGAMENTO,
      fatturaId: FATTURA,
      esito: 'browser_avviato',
    })
    expect(h.telemetria.mock.invocationCallOrder[0]).toBeLessThan(h.assign.mock.invocationCallOrder[0])
    expect(h.assign).toHaveBeenCalledWith(expect.stringMatching(/^https:\/\/uimulkjyekgemjakmepp\.supabase\.co\//))
  })

  it('accetta il TTL firmato dal server quando il server è avanti di 15 secondi', async () => {
    vi.useFakeTimers()
    const oraServer = new Date('2026-09-16T10:00:00.000Z')
    const oraClient = new Date(oraServer.getTime() - 15_000)
    vi.setSystemTime(oraClient)
    const scadeIl = Date.now() + 315_000
    expect(scadeIl - oraServer.getTime()).toBe(300_000)
    expect(scadeIl - oraClient.getTime()).toBeGreaterThan(310_000)
    h.nativo = true
    vi.mocked(fetch).mockResolvedValue(rispostaEsterna(
      315_000,
      `${STORAGE}/storage/v1/object/sign/fatture/f.pdf?token=segreto`,
      oraServer.toUTCString(),
    ))

    const esito = await salvaFattura(input())

    expect(esito).toEqual({ ok: true, modalita: 'browser-esterno', avviso: null })
    expect(h.assign).toHaveBeenCalledOnce()
    expect(h.telemetria).toHaveBeenCalledWith(expect.objectContaining({ esito: 'browser_avviato' }))
  })

  it.each([
    ['assente', undefined],
    ['non valida', 'non-una-data'],
  ])('senza Date %s ripiega sull’orologio locale', async (_caso, dataRisposta) => {
    h.nativo = true
    vi.mocked(fetch).mockResolvedValue(rispostaEsterna(300_000, undefined, dataRisposta))

    const esito = await salvaFattura(input())

    expect(esito).toEqual({ ok: true, modalita: 'browser-esterno', avviso: null })
    expect(h.assign).toHaveBeenCalledOnce()
  })

  it.each([
    ['TTL server oltre limite', 400_000],
    ['URL già scaduto', -1_000],
  ])('con Date valida rifiuta %s', async (_caso, ttl) => {
    const oraServer = new Date()
    h.nativo = true
    vi.mocked(fetch).mockResolvedValue(rispostaEsterna(ttl, undefined, oraServer.toUTCString()))

    const esito = await salvaFattura(input())

    expect(esito).toMatchObject({ ok: false, motivo: 'url-non-valido', riprovabile: true })
    expect(h.assign).not.toHaveBeenCalled()
    expect(h.telemetria).not.toHaveBeenCalled()
  })

  it.each([
    ['http non sicuro', 300_000, `http://uimulkjyekgemjakmepp.supabase.co/storage/v1/object/sign/fatture/f.pdf?token=x`],
    ['host estraneo', 300_000, 'https://evil.test/storage/v1/object/sign/fatture/f.pdf?token=x'],
    ['URL scaduto', -1, `${STORAGE}/storage/v1/object/sign/fatture/f.pdf?token=x`],
    ['TTL oltre quello server', 400_000, `${STORAGE}/storage/v1/object/sign/fatture/f.pdf?token=x`],
  ])('rifiuta %s senza loggare o aprire la capability', async (_caso, ttl, url) => {
    h.nativo = true
    vi.mocked(fetch).mockResolvedValue(rispostaEsterna(ttl, url))

    const esito = await salvaFattura(input())

    expect(esito).toMatchObject({ ok: false, motivo: 'url-non-valido', riprovabile: true })
    expect(h.assign).not.toHaveBeenCalled()
    expect(h.telemetria).not.toHaveBeenCalled()
    expect(JSON.stringify(h.logClient.mock.calls)).not.toContain('evil.test')
    expect(JSON.stringify(h.logClient.mock.calls)).not.toContain('token=')
  })

  it('un errore HTTP è esplicitamente riprovabile e non produce telemetria positiva', async () => {
    h.nativo = true
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 503 }))

    const esito = await salvaFattura(input())

    expect(esito).toEqual({
      ok: false,
      modalita: 'browser-esterno',
      motivo: 'http-503',
      riprovabile: true,
      avviso: 'non-riuscito',
    })
    expect(h.assign).not.toHaveBeenCalled()
    expect(h.telemetria).not.toHaveBeenCalled()
  })

  it('il mutex rifiuta un secondo salvataggio mentre il primo aspetta la firma', async () => {
    h.nativo = true
    const attesa = differita<Response>()
    vi.mocked(fetch).mockReturnValue(attesa.promise)
    const primo = salvaFattura(input())

    const secondo = await salvaFattura(input())
    expect(secondo).toMatchObject({ ok: false, motivo: 'gia-in-corso', avviso: 'in-corso' })
    expect(fetch).toHaveBeenCalledTimes(1)

    attesa.resolve(rispostaEsterna())
    await expect(primo).resolves.toMatchObject({ ok: true })
  })

  it('al timeout libera il mutex e ignora una risposta tardiva senza handoff', async () => {
    vi.useFakeTimers()
    h.nativo = true
    const attesa = differita<Response>()
    vi.mocked(fetch).mockReturnValue(attesa.promise)
    const primo = salvaFattura(input())

    await vi.advanceTimersByTimeAsync(30_000)
    await expect(primo).resolves.toMatchObject({ ok: false, motivo: 'tetto-tempo' })
    attesa.resolve(rispostaEsterna())
    await Promise.resolve()
    await Promise.resolve()

    expect(h.assign).not.toHaveBeenCalled()
    expect(h.telemetria).not.toHaveBeenCalled()
  })

  it('il tetto comprende anche la lettura del JSON e ignora il corpo arrivato tardi', async () => {
    vi.useFakeTimers()
    h.nativo = true
    const corpo = differita<unknown>()
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: () => corpo.promise,
    } as Response)
    const salvataggio = salvaFattura(input())

    await vi.advanceTimersByTimeAsync(30_000)
    await expect(salvataggio).resolves.toMatchObject({ ok: false, motivo: 'tetto-tempo' })
    corpo.resolve({
      success: true,
      data: {
        url: `${STORAGE}/storage/v1/object/sign/fatture/f.pdf?token=tardivo`,
        scade_il: new Date(Date.now() + 300_000).toISOString(),
      },
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(h.assign).not.toHaveBeenCalled()
    expect(h.telemetria).not.toHaveBeenCalled()
  })

  it('l’abort del chiamante impedisce l’handoff anche se la risposta arriva dopo', async () => {
    h.nativo = true
    const controller = new AbortController()
    const attesa = differita<Response>()
    vi.mocked(fetch).mockReturnValue(attesa.promise)
    const salvataggio = salvaFattura(input(controller.signal))

    controller.abort()
    await expect(salvataggio).resolves.toMatchObject({ ok: false, motivo: 'annullato', avviso: null })
    attesa.resolve(rispostaEsterna())
    await Promise.resolve()

    expect(h.assign).not.toHaveBeenCalled()
    expect(h.telemetria).not.toHaveBeenCalled()
  })

  it('un signal già annullato non avvia nessuna strada né telemetria', async () => {
    h.nativo = true
    h.filesystem = true
    const controller = new AbortController()
    controller.abort()

    await expect(salvaFattura(input(controller.signal))).resolves.toMatchObject({
      ok: false,
      motivo: 'annullato',
      avviso: null,
    })
    expect(h.scaricaDocumento).not.toHaveBeenCalled()
    expect(h.assign).not.toHaveBeenCalled()
    expect(h.telemetria).not.toHaveBeenCalled()
  })

  it('non registra mai un file come salvato: solo i due eventi di avvio ammessi', async () => {
    await salvaFattura(input())
    h.nativo = true
    h.filesystem = true
    await salvaFattura(input())

    const esiti = h.telemetria.mock.calls.map(([argomento]) => argomento.esito)
    expect(esiti).toEqual(['salvataggio_avviato', 'salvataggio_avviato'])
    expect(esiti).not.toContain('visualizzata')
    expect(esiti).not.toContain('annullata')
  })
})
