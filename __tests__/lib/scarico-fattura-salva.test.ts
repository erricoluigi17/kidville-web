import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const PAGAMENTO = '10000000-0000-4000-8000-000000000001'
const FATTURA = '20000000-0000-4000-8000-000000000002'
const UTENTE = '30000000-0000-4000-8000-000000000003'
const STORAGE = 'https://uimulkjyekgemjakmepp.supabase.co'

const h = vi.hoisted(() => ({
  nativo: false,
  filesystem: false,
  scarica: vi.fn(),
  telemetria: vi.fn(async (input: { esito: string }) => {
    void input
  }),
  assign: vi.fn(),
  logClient: vi.fn(),
}))

vi.mock('@/lib/push/native-register', () => ({ isNativeApp: () => h.nativo }))
vi.mock('@capacitor/core', () => ({
  Capacitor: { isPluginAvailable: () => h.filesystem },
}))
vi.mock('@/lib/native/scarica', () => ({ scarica: h.scarica }))
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
  h.scarica.mockResolvedValue({ esito: 'nativo-file' })
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

  it('sul nativo col Filesystem riusa scarica con nome fiscale e URL attachment', async () => {
    h.nativo = true
    h.filesystem = true
    expect(presentazioneSalvataggioFattura()).toEqual({ modalita: 'filesystem-nativo', etichetta: 'Salva' })

    const esito = await salvaFattura(input())

    expect(esito).toEqual({ ok: true, modalita: 'filesystem-nativo', avviso: null })
    expect(h.scarica).toHaveBeenCalledWith({
      url: `/api/pagamenti/fattura?pagamento_id=${PAGAMENTO}&userId=${UTENTE}&fattura_id=${FATTURA}&download=1`,
      nomeFile: 'fattura-1948-2026.pdf',
      titolo: undefined,
      signal: expect.any(AbortSignal),
    })
    expect(h.telemetria).toHaveBeenCalledWith(expect.objectContaining({ esito: 'salvataggio_avviato' }))
    expect(h.telemetria.mock.invocationCallOrder[0]).toBeLessThan(h.scarica.mock.invocationCallOrder[0])
    expect(JSON.stringify(h.logClient.mock.calls)).not.toContain('fattura-scarico-riuscito')
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
    expect(h.scarica).not.toHaveBeenCalled()
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
