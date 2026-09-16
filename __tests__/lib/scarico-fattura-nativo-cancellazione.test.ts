import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const PAGAMENTO = '10000000-0000-4000-8000-000000000001'
const FATTURA = '20000000-0000-4000-8000-000000000002'
const UTENTE = '30000000-0000-4000-8000-000000000003'

const h = vi.hoisted(() => ({
  filesystem: {
    writeFile: vi.fn(),
    getUri: vi.fn(),
    deleteFile: vi.fn(),
  },
  condividiFile: vi.fn(),
  condividiLink: vi.fn(),
  telemetria: vi.fn(async () => {}),
  logClient: vi.fn(),
}))

vi.mock('@/lib/push/native-register', () => ({ isNativeApp: () => true }))
vi.mock('@capacitor/core', () => ({
  Capacitor: { isPluginAvailable: () => true },
  registerPlugin: () => h.filesystem,
}))
vi.mock('@/lib/native/share', () => ({
  condividiFileLocale: h.condividiFile,
  condividiLink: h.condividiLink,
}))
vi.mock('@/lib/pagamenti/esito-fattura', () => ({ registraEsitoFattura: h.telemetria }))
vi.mock('@/lib/supabase/public-config', () => ({
  SUPABASE_URL: 'https://uimulkjyekgemjakmepp.supabase.co',
}))
vi.mock('@/lib/logging/client', () => ({
  logClient: h.logClient,
  nomeErrore: (errore: unknown) => errore instanceof Error ? errore.name : 'ErroreSconosciuto',
}))

import { salvaFattura } from '@/lib/pagamenti/scarico-fattura'

function input(signal?: AbortSignal) {
  return {
    pagamentoId: PAGAMENTO,
    fatturaId: FATTURA,
    userId: UTENTE,
    numero: 1948,
    anno: 2026,
    signal,
  }
}

function differita<T>() {
  let resolve!: (valore: T) => void
  const promise = new Promise<T>((ok) => { resolve = ok })
  return { promise, resolve }
}

function rispostaPdf(stato = 200): Response {
  const corpo = new Blob(['pdf'], { type: 'application/pdf' })
  return {
    ok: stato >= 200 && stato < 300,
    status: stato,
    blob: async () => corpo,
  } as Response
}

beforeEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
  h.filesystem.writeFile.mockResolvedValue({ uri: 'file:///cache/fattura.pdf' })
  h.filesystem.getUri.mockResolvedValue({ uri: 'file:///cache/fattura.pdf' })
  h.filesystem.deleteFile.mockResolvedValue(undefined)
  h.condividiFile.mockResolvedValue(true)
  h.condividiLink.mockResolvedValue('foglio')
  vi.stubGlobal('location', { origin: 'http://localhost', assign: vi.fn() })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('salvaFattura — cancellazione della strada Filesystem reale', () => {
  it('propaga l’abort al fetch e una risposta tardiva non scrive, condivide o ripiega', async () => {
    const risposta = differita<Response>()
    const fetchFinta = vi.fn<(url: RequestInfo | URL, opzioni?: RequestInit) => Promise<Response>>()
    fetchFinta.mockReturnValue(risposta.promise)
    vi.stubGlobal('fetch', fetchFinta)
    const controller = new AbortController()

    const salvataggio = salvaFattura(input(controller.signal))
    await vi.waitFor(() => expect(fetchFinta).toHaveBeenCalledTimes(1))
    controller.abort()

    await expect(salvataggio).resolves.toMatchObject({ ok: false, motivo: 'annullato', avviso: null })
    const opzioni = fetchFinta.mock.calls[0]?.[1] as RequestInit | undefined
    expect(opzioni?.signal).toBeInstanceOf(AbortSignal)
    expect(opzioni?.signal?.aborted).toBe(true)
    await expect(salvaFattura(input())).resolves.toMatchObject({ ok: false, motivo: 'gia-in-corso' })

    risposta.resolve(rispostaPdf())
    await Promise.resolve()
    await Promise.resolve()

    expect(h.filesystem.writeFile).not.toHaveBeenCalled()
    expect(h.condividiFile).not.toHaveBeenCalled()
    expect(h.condividiLink).not.toHaveBeenCalled()
  })

  it('al tetto di 30 secondi abortisce il fetch e ignora la risposta arrivata dopo', async () => {
    vi.useFakeTimers()
    const risposta = differita<Response>()
    const fetchFinta = vi.fn<(url: RequestInfo | URL, opzioni?: RequestInit) => Promise<Response>>()
    fetchFinta.mockReturnValue(risposta.promise)
    vi.stubGlobal('fetch', fetchFinta)

    const salvataggio = salvaFattura(input())
    await vi.advanceTimersByTimeAsync(30_000)

    await expect(salvataggio).resolves.toMatchObject({ ok: false, motivo: 'tetto-tempo' })
    const opzioni = fetchFinta.mock.calls[0]?.[1] as RequestInit | undefined
    expect(opzioni?.signal?.aborted).toBe(true)
    await expect(salvaFattura(input())).resolves.toMatchObject({ ok: false, motivo: 'gia-in-corso' })

    risposta.resolve(rispostaPdf())
    await Promise.resolve()
    await Promise.resolve()

    expect(h.filesystem.writeFile).not.toHaveBeenCalled()
    expect(h.condividiFile).not.toHaveBeenCalled()
    expect(h.condividiLink).not.toHaveBeenCalled()
  })

  it('se l’abort arriva durante writeFile non apre Share, ripulisce il file e tiene il mutex', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => rispostaPdf()))
    const scrittura = differita<{ uri?: string }>()
    h.filesystem.writeFile.mockReturnValueOnce(scrittura.promise)
    const controller = new AbortController()

    const salvataggio = salvaFattura(input(controller.signal))
    await vi.waitFor(() => expect(h.filesystem.writeFile).toHaveBeenCalledTimes(1))
    controller.abort()

    await expect(salvataggio).resolves.toMatchObject({ ok: false, motivo: 'annullato', avviso: null })
    await expect(salvaFattura(input())).resolves.toMatchObject({ ok: false, motivo: 'gia-in-corso' })

    scrittura.resolve({ uri: 'file:///cache/fattura.pdf' })
    await vi.waitFor(() => expect(h.filesystem.deleteFile).toHaveBeenCalledWith({
      path: 'fattura-1948-2026.pdf',
      directory: 'CACHE',
    }))
    expect(h.condividiFile).not.toHaveBeenCalled()
    expect(h.condividiLink).not.toHaveBeenCalled()

    h.filesystem.writeFile.mockResolvedValue({ uri: 'file:///cache/fattura.pdf' })
    await expect(salvaFattura(input())).resolves.toMatchObject({ ok: true })
  })

  it('un 503 nativo produce un log error con solo stato e codice chiuso', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => rispostaPdf(503)))

    await expect(salvaFattura(input())).resolves.toMatchObject({
      ok: false,
      motivo: 'http-503',
      avviso: 'non-consegnato',
    })

    expect(h.logClient).toHaveBeenCalledWith({
      livello: 'error',
      evento: 'fetch',
      messaggio: 'fattura-salvataggio-nativo:ripiego-condivisione',
      stato: 503,
    })
    const log = JSON.stringify(h.logClient.mock.calls)
    expect(log).not.toContain('/api/pagamenti/fattura')
    expect(log).not.toContain('userId')
    expect(log).not.toContain('token')
  })

  it('il successo resta soltanto telemetria salvataggio_avviato, senza warn di falso salvataggio', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => rispostaPdf()))

    await expect(salvaFattura(input())).resolves.toMatchObject({ ok: true })

    expect(h.telemetria).toHaveBeenCalledWith({
      pagamentoId: PAGAMENTO,
      fatturaId: FATTURA,
      esito: 'salvataggio_avviato',
    })
    expect(h.logClient).not.toHaveBeenCalled()
  })
})
