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

describe('salvaFattura — la strada nativa reale (scaricaDocumento, app 1.1)', () => {
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

  it('al tetto di 30 secondi abortisce il fetch appeso: «non riuscito», UNA riga error tetto-tempo, lucchetto libero', async () => {
    vi.useFakeTimers()
    // Come una fetch VERA: appesa finché il suo signal non viene abortito, poi AbortError.
    const fetchFinta = vi.fn<(url: RequestInfo | URL, opzioni?: RequestInit) => Promise<Response>>(
      (_url, opzioni) => new Promise<Response>((_ok, rifiuta) => {
        opzioni?.signal?.addEventListener('abort', () => {
          rifiuta(new DOMException('The operation was aborted.', 'AbortError'))
        }, { once: true })
      }),
    )
    vi.stubGlobal('fetch', fetchFinta)

    const salvataggio = salvaFattura(input())
    await vi.advanceTimersByTimeAsync(29_999)
    // Un attimo prima del tetto il giro è ancora vivo.
    expect(h.logClient).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)

    await expect(salvataggio).resolves.toMatchObject({ ok: false, motivo: 'tetto-tempo', avviso: 'non-riuscito' })
    // La fetch è quella della sorgente-funzione del modulo: stessa origine, coi cookie,
    // e col segnale del TETTO, che è l'unico a essere abortito.
    const [url, opzioni] = fetchFinta.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`/api/pagamenti/fattura?pagamento_id=${PAGAMENTO}&userId=${UTENTE}&fattura_id=${FATTURA}&download=1`)
    expect(opzioni).toMatchObject({ credentials: 'same-origin' })
    expect(opzioni.signal?.aborted).toBe(true)
    // UN guasto, UNA riga `error` — come il 503 qui sotto. La scrive l'helper, col motivo
    // del tetto e non con l'`AbortError` della fetch interrotta (che qui vorrebbe dire
    // annullamento); `salvaFattura` non ne aggiunge una sua.
    expect(h.logClient).toHaveBeenCalledTimes(1)
    expect(h.logClient).toHaveBeenCalledWith(expect.objectContaining({
      livello: 'error',
      evento: 'fetch',
      messaggio: 'fattura-scarico-non-riuscito: tetto-tempo',
    }))
    const messaggi = h.logClient.mock.calls.map(([riga]) => (riga as { messaggio: string }).messaggio)
    expect(messaggi.some((m) => m.includes('AbortError'))).toBe(false)
    expect(messaggi).not.toContain('fattura-salvataggio-nativo:tetto-tempo')
    expect(JSON.stringify(h.logClient.mock.calls)).not.toContain(UTENTE)
    expect(h.filesystem.writeFile).not.toHaveBeenCalled()
    expect(h.condividiFile).not.toHaveBeenCalled()
    expect(h.condividiLink).not.toHaveBeenCalled()

    // Il verdetto dell'helper è già arrivato: il lucchetto non resta chiuso. (Orologio
    // vero: la lettura del Blob in base64 di jsdom passa dai timer.)
    vi.useRealTimers()
    fetchFinta.mockImplementation(async () => rispostaPdf())
    await expect(salvaFattura(input())).resolves.toMatchObject({ ok: true, avviso: null })
  })

  it('il foglio «Salva su File» aperto oltre i 30 s non è un fallimento: ok, nessun tetto-tempo, una riga di successo', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn(async () => rispostaPdf()))
    // L'utente sceglie la cartella in File con calma: il foglio si chiude dopo 45 s.
    const foglio = differita<boolean>()
    h.condividiFile.mockReturnValueOnce(foglio.promise)

    let verdetto: unknown = 'in attesa'
    const salvataggio = salvaFattura(input()).then((r) => { verdetto = r; return r })
    await vi.waitFor(() => expect(h.condividiFile).toHaveBeenCalledTimes(1))
    await vi.advanceTimersByTimeAsync(45_000)

    // Scaduto il tetto, lo schermo NON dice «non riuscito» mentre il foglio è aperto.
    expect(verdetto).toBe('in attesa')
    expect(h.logClient).not.toHaveBeenCalled()
    await expect(salvaFattura(input())).resolves.toMatchObject({ ok: false, motivo: 'gia-in-corso' })

    foglio.resolve(true)
    await expect(salvataggio).resolves.toEqual({ ok: true, modalita: 'filesystem-nativo', avviso: null })

    const messaggi = h.logClient.mock.calls.map(([riga]) => (riga as { messaggio: string }).messaggio)
    expect(messaggi).not.toContain('fattura-salvataggio-nativo:tetto-tempo')
    expect(messaggi.filter((m) => m === 'fattura-scarico-riuscito:nativo-file')).toHaveLength(1)
    expect(h.logClient.mock.calls.some(([riga]) => (riga as { livello: string }).livello === 'error')).toBe(false)
  })

  it('«Annulla» sul foglio premuto dopo i 30 s si comporta come prima dei 30 s: niente tetto-tempo, niente «non riuscito»', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn(async () => rispostaPdf()))
    const foglio = differita<void>()
    // Come il `condividiFileLocale` VERO: all'«Annulla» dell'utente il catch risponde
    // `false` se il signal ricevuto è già abortito, altrimenti è un annullamento
    // dell'utente e risponde `true` (il foglio si è aperto, non è un guasto).
    h.condividiFile.mockImplementationOnce(
      (_uri: string, _titolo?: string, signal?: AbortSignal) => foglio.promise.then(() => !signal?.aborted),
    )
    const chiamante = new AbortController()

    let verdetto: unknown = 'in attesa'
    const salvataggio = salvaFattura(input(chiamante.signal)).then((r) => { verdetto = r; return r })
    await vi.waitFor(() => expect(h.condividiFile).toHaveBeenCalledTimes(1))
    // Al foglio arriva il segnale del CHIAMANTE, mai quello del tetto.
    expect(h.condividiFile.mock.calls[0]?.[2]).toBe(chiamante.signal)
    await vi.advanceTimersByTimeAsync(45_000)
    expect(verdetto).toBe('in attesa')
    expect((h.condividiFile.mock.calls[0]?.[2] as AbortSignal).aborted).toBe(false)

    // L'utente preme «Annulla» a 45 s.
    foglio.resolve()
    const risultato = await salvataggio
    expect(risultato).not.toMatchObject({ motivo: 'tetto-tempo' })
    expect(risultato).not.toMatchObject({ avviso: 'non-riuscito' })
    expect(risultato).toEqual({ ok: true, modalita: 'filesystem-nativo', avviso: null })

    const messaggi = h.logClient.mock.calls.map(([riga]) => (riga as { messaggio: string }).messaggio)
    expect(messaggi).not.toContain('fattura-salvataggio-nativo:tetto-tempo')
    expect(messaggi).not.toContain('fattura-scarico-annullato')
    expect(h.logClient.mock.calls.some(([riga]) => (riga as { livello: string }).livello === 'error')).toBe(false)
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

  it('un 503 nativo non condivide MAI il link: verdetto «non riuscito» e un solo log error, senza URL', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => rispostaPdf(503)))

    await expect(salvaFattura(input())).resolves.toMatchObject({
      ok: false,
      motivo: 'http-503',
      avviso: 'non-riuscito',
    })

    expect(h.condividiLink).not.toHaveBeenCalled()
    expect(h.condividiFile).not.toHaveBeenCalled()
    expect(h.filesystem.writeFile).not.toHaveBeenCalled()
    expect(h.logClient).toHaveBeenCalledTimes(1)
    expect(h.logClient).toHaveBeenCalledWith(expect.objectContaining({
      livello: 'error',
      evento: 'fetch',
      messaggio: 'fattura-scarico-non-riuscito: http-503',
    }))
    const log = JSON.stringify(h.logClient.mock.calls)
    expect(log).not.toContain('/api/pagamenti/fattura')
    expect(log).not.toContain('userId')
    expect(log).not.toContain(UTENTE)
    expect(log).not.toContain('token')
  })

  it('se il foglio col file non si apre non ripiega sul link relativo', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => rispostaPdf()))
    h.condividiFile.mockResolvedValue(false)

    await expect(salvaFattura(input())).resolves.toMatchObject({
      ok: false,
      motivo: 'foglio-file-non-aperto',
      avviso: 'non-riuscito',
    })
    expect(h.condividiLink).not.toHaveBeenCalled()
  })

  it('il successo consegna il PDF nel foglio «Salva su File» e lo logga con l’etichetta fattura', async () => {
    const fetchFinta = vi.fn(async () => rispostaPdf())
    vi.stubGlobal('fetch', fetchFinta)

    const chiamante = new AbortController()

    await expect(salvaFattura({ ...input(chiamante.signal), titolo: 'Fattura' }))
      .resolves.toMatchObject({ ok: true, avviso: null })

    // La route della STESSA origine, in attachment, letta coi cookie della WebView.
    const [url, opzioni] = fetchFinta.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`/api/pagamenti/fattura?pagamento_id=${PAGAMENTO}&userId=${UTENTE}&fattura_id=${FATTURA}&download=1`)
    expect(opzioni).toMatchObject({ credentials: 'same-origin' })
    // Il FILE in Cache col nome fiscale, e il foglio col file — mai col link.
    expect(h.filesystem.writeFile).toHaveBeenCalledWith(expect.objectContaining({
      path: 'fattura-1948-2026.pdf',
      directory: 'CACHE',
    }))
    // Col segnale del CHIAMANTE: quello del tetto resta alla sola fetch.
    expect(h.condividiFile).toHaveBeenCalledWith('file:///cache/fattura.pdf', 'Fattura', chiamante.signal)
    expect(opzioni.signal).not.toBe(chiamante.signal)
    expect(h.condividiLink).not.toHaveBeenCalled()
    expect(h.telemetria).toHaveBeenCalledWith({
      pagamentoId: PAGAMENTO,
      fatturaId: FATTURA,
      esito: 'salvataggio_avviato',
    })
    // §5 di AGENTS.md: il successo di un evento critico si logga, una riga sola.
    expect(h.logClient).toHaveBeenCalledTimes(1)
    expect(h.logClient).toHaveBeenCalledWith(expect.objectContaining({
      livello: 'warn',
      messaggio: 'fattura-scarico-riuscito:nativo-file',
    }))
  })
})
