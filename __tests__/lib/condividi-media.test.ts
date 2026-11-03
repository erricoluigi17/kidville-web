import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * `condividiMedia` — «Condividi» manda il FILE, non il link.
 *
 * Il difetto che chiude: il pulsante «Condividi» della galleria mandava un link firmato
 * che scade in 10 minuti. Chi lo riceveva su WhatsApp, mezz'ora dopo, trovava un 403.
 * Ora al foglio di sistema va il file vero:
 *  - APP 1.1 → file in Cache (`fileInCache`) e foglio col FILE (`condividiFileLocale`);
 *  - APP 1.0 → «aggiorna l'app», MAI il link (è proprio il link il difetto);
 *  - WEB → `fetch` → `File` → `navigator.share({ files })`, solo dove `canShare` lo
 *    ammette; se Safari rifiuta il gesto (`NotAllowedError`, perché fra il tocco e la
 *    condivisione c'è stata la `fetch`) il file resta pronto per la stessa `chiave` e il
 *    SECONDO tocco condivide subito, senza altra rete.
 *
 * ─── Come sono fatti i finti, e perché ───────────────────────────────────────
 * `@/lib/native/share` è sostituito SOLO in `condividiLink` e `condividiFileLocale` (i due
 * rami nativi, che in jsdom non esistono). `condividiFileWeb` resta VERO: i test web
 * guardano gli argomenti che arrivano a `navigator.share` e l'instradamento degli errori
 * (`NotAllowedError`, `AbortError`), cioè il produttore. Con anche quello finto il test
 * misurerebbe il finto: la trappola già pagata in `native-share.test.ts`.
 */

vi.mock('@/lib/push/native-register', () => ({ isNativeApp: vi.fn(() => false) }))
vi.mock('@/lib/native/share', async (importOriginal) => {
  const reale = await importOriginal<typeof import('@/lib/native/share')>()
  return {
    ...reale,
    condividiLink: vi.fn(async () => 'foglio' as const),
    condividiFileLocale: vi.fn(async () => true),
  }
})
vi.mock('@/lib/logging/client', () => ({
  logClient: vi.fn(),
  nomeErrore: (e: unknown) => (e instanceof Error ? e.name : 'errore'),
}))

const h = vi.hoisted(() => {
  type Uri = { uri?: string }
  return {
    disponibili: new Set<string>(),
    piattaforma: { valore: 'ios' },
    fs: {
      writeFile: vi.fn<(o: { path: string; data: string; directory: string; recursive?: boolean }) => Promise<Uri>>(),
      getUri: vi.fn<(o: { path: string; directory: string }) => Promise<Uri>>(),
      deleteFile: vi.fn<(o: { path: string; directory: string }) => Promise<void>>(),
    },
    ft: { downloadFile: vi.fn<(o: { url: string; path: string }) => Promise<{ path?: string }>>() },
  }
})

const isPluginAvailable = vi.hoisted(() => vi.fn())
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isPluginAvailable,
    isNativePlatform: () => false,
    getPlatform: () => h.piattaforma.valore,
  },
  registerPlugin: (nome: string) => ({ Filesystem: h.fs, FileTransfer: h.ft } as Record<string, unknown>)[nome],
}))

import {
  condividiMedia,
  puoCondividereFileMedia,
  type CondividiMediaInput,
} from '@/lib/native/scarica'
import { condividiFileWeb, condividiLink, condividiFileLocale } from '@/lib/native/share'
import { isNativeApp } from '@/lib/push/native-register'
import { logClient } from '@/lib/logging/client'

const nativo = vi.mocked(isNativeApp)
const condividiLinkMock = vi.mocked(condividiLink)
const condividiFileMock = vi.mocked(condividiFileLocale)
const log = vi.mocked(logClient)

const URL_FIRMATO = 'https://progetto-esempio.supabase.co/storage/v1/object/sign/gallery/a/foto.jpg?token=segreto-uno'
const URL_RIFIRMATO = 'https://progetto-esempio.supabase.co/storage/v1/object/sign/gallery/a/foto.jpg?token=segreto-due'
const TITOLO = 'Foto da Kidville'

const PLUGIN_1_1 = ['Filesystem', 'FileTransfer', 'Share']

/** Ogni test una chiave sua: il «file pronto» è una variabile di modulo e sopravvive fra i test. */
let contatore = 0
const nuovaChiave = () => `messaggio-finto-${++contatore}`

function input(extra: Partial<CondividiMediaInput> = {}): CondividiMediaInput {
  return { url: URL_FIRMATO, nomeFile: '', tipo: 'foto', chiave: nuovaChiave(), titolo: TITOLO, ...extra }
}

function risposta(testo = 'ciao', tipo = 'image/jpeg', ok = true, status = 200) {
  return { ok, status, blob: async () => new Blob([testo], { type: tipo }) } as unknown as Response
}

function stubNavigator(key: string, value: unknown) {
  Object.defineProperty(navigator, key, { value, configurable: true, writable: true })
}

function messaggi(): string[] {
  return log.mock.calls.map((c) => c[0].messaggio)
}

/** Da qui si va dritti in `app_log`: né URL, né token, né nomi di file. */
function nessunDatoNeiLog(): void {
  const tutto = JSON.stringify(log.mock.calls)
  expect(tutto).not.toMatch(/supabase|token|segreto|esempio|https?:\/\/|file:\/\/|\.jpg|\.mp4|kidville-foto|kidville-video/i)
}

const annullamentoAbort = () => new DOMException('The operation was aborted.', 'AbortError')
const gestoScaduto = () => new DOMException('', 'NotAllowedError')

beforeEach(() => {
  vi.clearAllMocks()
  h.disponibili.clear()
  h.piattaforma.valore = 'ios'
  isPluginAvailable.mockImplementation((nome: string) => h.disponibili.has(nome))
  h.fs.getUri.mockImplementation(async ({ path }) => ({ uri: `file:///cache/${path}` }))
  h.fs.writeFile.mockImplementation(async ({ path }) => ({ uri: `file:///cache/${path}` }))
  h.fs.deleteFile.mockResolvedValue(undefined)
  h.ft.downloadFile.mockImplementation(async ({ path }) => ({ path }))
  condividiFileMock.mockResolvedValue(true)
  condividiLinkMock.mockResolvedValue('foglio')
  nativo.mockReturnValue(false)
  stubNavigator('share', undefined)
  stubNavigator('canShare', undefined)
  stubNavigator('clipboard', undefined)
  globalThis.fetch = vi.fn(async () => risposta()) as unknown as typeof fetch
})

afterEach(() => {
  nessunDatoNeiLog()
})

/* ══════════════════════════════════════════════════════════════════════════
 * APP 1.1
 * ══════════════════════════════════════════════════════════════════════════ */

describe('condividiMedia — app 1.1', () => {
  beforeEach(() => {
    nativo.mockReturnValue(true)
    PLUGIN_1_1.forEach((p) => h.disponibili.add(p))
  })

  it('app 1.1: il foglio riceve il FILE in cache, mai il link', async () => {
    const uriDaGetUri = 'file:///cache/uri-restituito-da-getUri.jpg'
    h.fs.getUri.mockResolvedValue({ uri: uriDaGetUri })

    const r = await condividiMedia(input({ nomeFile: 'gita.jpg' }))

    expect(r).toEqual({ esito: 'nativo-foglio' })
    expect(h.fs.getUri).toHaveBeenCalledWith({ path: 'gita.jpg', directory: 'CACHE' })
    // FileTransfer scrive proprio dove getUri ha detto, e il foglio riceve quell'uri.
    expect(h.ft.downloadFile).toHaveBeenCalledWith({ url: URL_FIRMATO, path: uriDaGetUri })
    expect(condividiFileMock).toHaveBeenCalledTimes(1)
    expect(condividiFileMock).toHaveBeenCalledWith(uriDaGetUri, TITOLO)
    // Il link NON è un ripiego: è il difetto che si toglie.
    expect(condividiLinkMock).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    expect(h.fs.writeFile).not.toHaveBeenCalled()
    // La copia in Cache NON si cancella dopo il foglio: su Android la promessa si
    // risolve prima che l'app di destinazione legga il file.
    expect(h.fs.deleteFile).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith({
      livello: 'warn',
      evento: 'fetch',
      messaggio: 'gallery-condivisione-riuscita:nativo-foglio',
      campi: { esito: 'nativo-foglio', operazione: 'condivisione', piattaforma: 'ios' },
    })
    // Ogni plugin toccato è stato prima chiesto a isPluginAvailable.
    for (const p of PLUGIN_1_1) expect(isPluginAvailable).toHaveBeenCalledWith(p)
  })

  it('il nome del file sul dispositivo passa da nomeFileScarico: mai un percorso, sempre con estensione', async () => {
    await condividiMedia(input({ nomeFile: '../../Gita al parco/2026' }))

    const { path } = h.fs.getUri.mock.calls[0][0]
    expect(path).not.toMatch(/\/|\.\./)
    expect(path).toBe('Gita al parco 2026.jpg')

    h.fs.getUri.mockClear()
    await condividiMedia(input({ nomeFile: '', url: URL_FIRMATO.replace('foto.jpg', 'filmato.mp4'), tipo: 'video' }))
    expect(h.fs.getUri.mock.calls[0][0].path).toBe('kidville-video.mp4')
  })

  it('il foglio non si apre: non-riuscita col motivo, nessun link', async () => {
    condividiFileMock.mockResolvedValue(false)

    const r = await condividiMedia(input())

    expect(r).toEqual({ esito: 'non-riuscita', motivo: 'foglio-file-non-aperto' })
    expect(condividiLinkMock).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      livello: 'error',
      messaggio: 'gallery-condivisione-non-riuscita: foglio-file-non-aperto',
    }))
  })

  it('FileTransfer rifiuta con HTTP 403: non-riuscita http-403, foglio e link mai toccati', async () => {
    h.ft.downloadFile.mockRejectedValue({ code: 'OS-PLUG-FLTR-0010', message: 'corpo', data: { httpStatus: 403 } })

    const r = await condividiMedia(input())

    expect(r).toEqual({ esito: 'non-riuscita', motivo: 'http-403' })
    expect(condividiFileMock).not.toHaveBeenCalled()
    expect(condividiLinkMock).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      livello: 'error',
      messaggio: 'gallery-condivisione-non-riuscita: http-403',
    }))
  })

  it('gesto ritirato prima del foglio: «annullata» (warn), copia in Cache tolta, foglio mai aperto', async () => {
    const controllore = new AbortController()
    h.ft.downloadFile.mockImplementation(async ({ path }) => {
      controllore.abort()
      return { path }
    })

    const r = await condividiMedia(input({ signal: controllore.signal }))

    expect(r).toEqual({ esito: 'non-riuscita', motivo: 'annullato' })
    expect(condividiFileMock).not.toHaveBeenCalled()
    expect(h.fs.deleteFile).toHaveBeenCalledTimes(1)
    expect(log.mock.calls.some((c) => c[0].livello === 'error')).toBe(false)
    expect(messaggi()).toEqual(['gallery-condivisione-annullata'])
  })

  it('gesto già ritirato in partenza: niente plugin, niente rete, riga «annullata»', async () => {
    const controllore = new AbortController()
    controllore.abort()

    const r = await condividiMedia(input({ signal: controllore.signal }))

    expect(r).toEqual({ esito: 'non-riuscita', motivo: 'annullato' })
    expect(h.fs.getUri).not.toHaveBeenCalled()
    expect(h.ft.downloadFile).not.toHaveBeenCalled()
    expect(condividiFileMock).not.toHaveBeenCalled()
    expect(messaggi()).toEqual(['gallery-condivisione-annullata'])
  })
})

/* ══════════════════════════════════════════════════════════════════════════
 * APP 1.0 — i plugin nuovi non ci sono
 * ══════════════════════════════════════════════════════════════════════════ */

describe('condividiMedia — app 1.0', () => {
  beforeEach(() => {
    nativo.mockReturnValue(true)
  })

  function nessunPluginChiamato(): void {
    for (const f of [...Object.values(h.fs), ...Object.values(h.ft)]) expect(f).not.toHaveBeenCalled()
  }

  it('app 1.0: avvisa di aggiornare e non manda il link', async () => {
    // Un binario 1.0 ha il solo Share: è proprio il caso in cui il link «funzionerebbe».
    h.disponibili.add('Share')

    const r = await condividiMedia(input())

    expect(r.esito).toBe('app-da-aggiornare')
    expect(r.motivo).toContain('plugin-assenti:')
    expect(r.motivo).toBe('plugin-assenti:filesystem+filetransfer')
    expect(fetch).not.toHaveBeenCalled()
    expect(condividiLinkMock).not.toHaveBeenCalled()
    expect(condividiFileMock).not.toHaveBeenCalled()
    nessunPluginChiamato()
    expect(log).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith({
      livello: 'error',
      evento: 'fetch',
      messaggio: 'gallery-condivisione-non-riuscita: plugin-assenti:filesystem+filetransfer',
      campi: { esito: 'app-da-aggiornare', operazione: 'condivisione', piattaforma: 'ios' },
    })
  })

  it('app 1.0: FileTransfer assente → «aggiorna», senza FileTransfer nessun file arriva in Cache', async () => {
    h.disponibili.add('Filesystem')
    h.disponibili.add('Share')

    const r = await condividiMedia(input())

    expect(r).toEqual({ esito: 'app-da-aggiornare', motivo: 'plugin-assenti:filetransfer' })
    expect(fetch).not.toHaveBeenCalled()
    expect(condividiLinkMock).not.toHaveBeenCalled()
    nessunPluginChiamato()
  })

  it('app 1.0: Share assente → «aggiorna», nessun file scaricato per niente', async () => {
    h.disponibili.add('Filesystem')
    h.disponibili.add('FileTransfer')

    const r = await condividiMedia(input())

    expect(r).toEqual({ esito: 'app-da-aggiornare', motivo: 'plugin-assenti:share' })
    expect(h.ft.downloadFile).not.toHaveBeenCalled()
    expect(condividiFileMock).not.toHaveBeenCalled()
    expect(condividiLinkMock).not.toHaveBeenCalled()
  })

  it('app 1.0: nessun plugin: li elenca tutti, nell\'ordine', async () => {
    const r = await condividiMedia(input())

    expect(r).toEqual({ esito: 'app-da-aggiornare', motivo: 'plugin-assenti:filesystem+filetransfer+share' })
    nessunPluginChiamato()
  })
})

/* ══════════════════════════════════════════════════════════════════════════
 * WEB
 * ══════════════════════════════════════════════════════════════════════════ */

describe('puoCondividereFileMedia', () => {
  it('nell\'app è sempre true, anche sul binario 1.0: il pulsante c\'è e avvisa', () => {
    nativo.mockReturnValue(true)
    // Nessun plugin registrato, nessun navigator.canShare.
    expect(puoCondividereFileMedia()).toBe(true)
  })

  it('web: true solo se canShare ammette DAVVERO un file immagine', () => {
    const canShare = vi.fn(() => true)
    stubNavigator('canShare', canShare)

    expect(puoCondividereFileMedia()).toBe(true)

    expect(canShare).toHaveBeenCalledTimes(1)
    const dati = canShare.mock.calls[0] as unknown as [{ files: File[] }]
    expect(dati[0].files).toHaveLength(1)
    expect(dati[0].files[0]).toBeInstanceOf(File)
    expect(dati[0].files[0].name).toBe('kidville-foto.jpg')
    expect(dati[0].files[0].type).toBe('image/jpeg')
  })

  it('web: canShare assente, falso o che lancia → false (e non lancia)', () => {
    expect(puoCondividereFileMedia()).toBe(false)

    stubNavigator('canShare', () => false)
    expect(puoCondividereFileMedia()).toBe(false)

    // Solo `=== true` conta: un valore «truthy» non basta.
    stubNavigator('canShare', () => 'sì')
    expect(puoCondividereFileMedia()).toBe(false)

    stubNavigator('canShare', () => {
      throw new TypeError('x')
    })
    expect(puoCondividereFileMedia()).toBe(false)
  })
})

describe('condividiMedia — web', () => {
  let share: ReturnType<typeof vi.fn>
  beforeEach(() => {
    h.piattaforma.valore = 'web'
    share = vi.fn().mockResolvedValue(undefined)
    stubNavigator('share', share)
    stubNavigator('canShare', () => true)
  })

  it('web con canShare: navigator.share riceve un File con estensione e nessun url', async () => {
    const r = await condividiMedia(input({ nomeFile: 'gita' }))

    expect(r).toEqual({ esito: 'web-foglio' })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledWith(URL_FIRMATO)
    expect(share).toHaveBeenCalledTimes(1)
    const dati = share.mock.calls[0][0] as { files: File[]; title?: string }
    expect(dati.files).toHaveLength(1)
    expect(dati.files[0]).toBeInstanceOf(File)
    expect(dati.files[0].name).toBe('gita.jpg')
    expect(dati.files[0].name.endsWith('.jpg')).toBe(true)
    expect(dati.files[0].type).toBe('image/jpeg')
    expect(dati.files[0].size).toBe('ciao'.length)
    expect(dati.title).toBe(TITOLO)
    // Il link NON viaggia: né `url` né `text`.
    expect('url' in dati).toBe(false)
    expect('text' in dati).toBe(false)
    expect(condividiLinkMock).not.toHaveBeenCalled()
    expect(messaggi()).toEqual(['gallery-condivisione-riuscita:web-foglio'])
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      livello: 'warn',
      campi: { esito: 'web-foglio', operazione: 'condivisione', piattaforma: 'web' },
    }))
  })

  it('senza titolo il foglio non riceve la chiave title', async () => {
    await condividiMedia(input({ titolo: undefined }))

    expect('title' in (share.mock.calls[0][0] as object)).toBe(false)
  })

  it('tipo del file: quello del blob; senza, image/jpeg per una foto e video/mp4 per un video', async () => {
    globalThis.fetch = vi.fn(async () => risposta('x', 'image/png')) as unknown as typeof fetch
    await condividiMedia(input({ url: URL_FIRMATO.replace('foto.jpg', 'foto.png') }))
    expect((share.mock.calls[0][0] as { files: File[] }).files[0].type).toBe('image/png')

    globalThis.fetch = vi.fn(async () => risposta('x', '')) as unknown as typeof fetch
    await condividiMedia(input())
    expect((share.mock.calls[1][0] as { files: File[] }).files[0].type).toBe('image/jpeg')

    await condividiMedia(input({ tipo: 'video', url: URL_FIRMATO.replace('foto.jpg', 'filmato.mp4') }))
    const video = (share.mock.calls[2][0] as { files: File[] }).files[0]
    expect(video.type).toBe('video/mp4')
    expect(video.name).toBe('kidville-video.mp4')
  })

  it('web senza canShare: non-supportato e nessun fetch', async () => {
    stubNavigator('canShare', undefined)

    const r = await condividiMedia(input())

    expect(r.esito).toBe('non-supportato')
    expect(r.motivo).toBe('condivisione-file-assente')
    expect(fetch).not.toHaveBeenCalled()
    expect(share).not.toHaveBeenCalled()
    expect(condividiLinkMock).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      livello: 'error',
      messaggio: 'gallery-condivisione-non-riuscita: condivisione-file-assente',
      campi: { esito: 'non-supportato', operazione: 'condivisione', piattaforma: 'web' },
    }))
  })

  it('web con canShare falso: lo stesso, nessun fetch', async () => {
    stubNavigator('canShare', () => false)

    const r = await condividiMedia(input())

    expect(r.esito).toBe('non-supportato')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('gesto scaduto: il secondo tocco con la stessa chiave condivide senza rifare il fetch', async () => {
    const chiave = nuovaChiave()
    share.mockRejectedValueOnce(gestoScaduto())

    const primo = await condividiMedia(input({ chiave }))

    expect(primo).toEqual({ esito: 'web-gesto-scaduto' })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(share).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenLastCalledWith(expect.objectContaining({
      livello: 'warn',
      messaggio: 'gallery-condivisione-gesto-scaduto',
    }))

    // L'URL è cambiato (rifirmato): non conta, l'identità è la chiave.
    const secondo = await condividiMedia(input({ chiave, url: URL_RIFIRMATO }))

    expect(secondo).toEqual({ esito: 'web-foglio' })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(share).toHaveBeenCalledTimes(2)
    // È lo STESSO file del primo tentativo, non uno scaricato di nuovo.
    const primoFile = (share.mock.calls[0][0] as { files: File[] }).files[0]
    const secondoFile = (share.mock.calls[1][0] as { files: File[] }).files[0]
    expect(secondoFile).toBe(primoFile)
    expect(messaggi()).toEqual([
      'gallery-condivisione-gesto-scaduto',
      'gallery-condivisione-riuscita:web-foglio',
    ])
  })

  it('il posto si svuota: dopo la condivisione del file pronto, il tocco successivo scarica di nuovo', async () => {
    const chiave = nuovaChiave()
    share.mockRejectedValueOnce(gestoScaduto())
    await condividiMedia(input({ chiave }))
    await condividiMedia(input({ chiave }))
    expect(fetch).toHaveBeenCalledTimes(1)

    await condividiMedia(input({ chiave }))

    expect(fetch).toHaveBeenCalledTimes(2)
    expect(share).toHaveBeenCalledTimes(3)
  })

  it('se anche il secondo tocco perde il gesto, il file resta pronto per il terzo', async () => {
    const chiave = nuovaChiave()
    share.mockRejectedValueOnce(gestoScaduto()).mockRejectedValueOnce(gestoScaduto())

    expect((await condividiMedia(input({ chiave }))).esito).toBe('web-gesto-scaduto')
    expect((await condividiMedia(input({ chiave }))).esito).toBe('web-gesto-scaduto')
    expect((await condividiMedia(input({ chiave }))).esito).toBe('web-foglio')

    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('un file pronto per un\'ALTRA chiave non si condivide: foto diversa, fetch nuovo', async () => {
    const chiaveA = nuovaChiave()
    const chiaveB = nuovaChiave()
    share.mockRejectedValueOnce(gestoScaduto())
    await condividiMedia(input({ chiave: chiaveA }))

    const r = await condividiMedia(input({ chiave: chiaveB }))

    expect(r).toEqual({ esito: 'web-foglio' })
    expect(fetch).toHaveBeenCalledTimes(2)
    // Il file di A non è stato dato alla foto B.
    const fileA = (share.mock.calls[0][0] as { files: File[] }).files[0]
    const fileB = (share.mock.calls[1][0] as { files: File[] }).files[0]
    expect(fileB).not.toBe(fileA)

    // E A aspetta ancora il suo secondo tocco.
    const ancoraA = await condividiMedia(input({ chiave: chiaveA }))
    expect(ancoraA).toEqual({ esito: 'web-foglio' })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect((share.mock.calls[2][0] as { files: File[] }).files[0]).toBe(fileA)
  })

  it('annullare il foglio non è un errore', async () => {
    share.mockRejectedValueOnce(annullamentoAbort())

    const r = await condividiMedia(input())

    // Il foglio si è aperto: per chi chiama è `web-foglio`, con `annullata` a dirlo.
    expect(r).toEqual({ esito: 'web-foglio', annullata: true })
    expect(log.mock.calls.some((c) => c[0].livello === 'error')).toBe(false)
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      livello: 'warn',
      messaggio: 'gallery-condivisione-annullata',
    }))
    expect(messaggi()).toEqual(['gallery-condivisione-annullata'])
  })

  it('annullare il foglio NON lascia il file pronto: la volta dopo si scarica di nuovo', async () => {
    const chiave = nuovaChiave()
    share.mockRejectedValueOnce(annullamentoAbort())
    await condividiMedia(input({ chiave }))

    await condividiMedia(input({ chiave }))

    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('firma scaduta: non-riuscita con http-403 e il log non contiene l\'URL', async () => {
    globalThis.fetch = vi.fn(async () => risposta('', 'application/xml', false, 403)) as unknown as typeof fetch

    const r = await condividiMedia(input())

    expect(r).toEqual({ esito: 'non-riuscita', motivo: 'http-403' })
    expect(share).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledTimes(1)
    const chiamata = log.mock.calls[0][0]
    expect(chiamata.livello).toBe('error')
    expect(chiamata.messaggio).toBe('gallery-condivisione-non-riuscita: http-403')
    // L'URL non sta nel messaggio né nei campi.
    expect(chiamata.messaggio).not.toContain(URL_FIRMATO)
    expect(JSON.stringify(chiamata.campi)).not.toContain(URL_FIRMATO)
    expect(JSON.stringify(chiamata)).not.toContain('token')
    expect(chiamata.campi).toEqual({ esito: 'non-riuscita', operazione: 'condivisione', piattaforma: 'web' })
  })

  it('la rete cade: non-riuscita col solo NOME dell\'errore, mai il testo', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError(`Load failed ${URL_FIRMATO}`)
    }) as unknown as typeof fetch

    const r = await condividiMedia(input())

    expect(r).toEqual({ esito: 'non-riuscita', motivo: 'TypeError' })
    expect(messaggi()).toEqual(['gallery-condivisione-non-riuscita: TypeError'])
  })

  it('navigator.share rifiuta per un altro motivo: non-riuscita, e il file NON resta pronto', async () => {
    const chiave = nuovaChiave()
    share.mockRejectedValueOnce(new TypeError('tipo non ammesso'))

    const r = await condividiMedia(input({ chiave }))

    expect(r).toEqual({ esito: 'non-riuscita', motivo: 'foglio-file-non-aperto' })
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      livello: 'error',
      messaggio: 'gallery-condivisione-non-riuscita: foglio-file-non-aperto',
    }))

    await condividiMedia(input({ chiave }))
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('gesto ritirato durante la fetch: «annullata», niente foglio, nessun error', async () => {
    const controllore = new AbortController()
    globalThis.fetch = vi.fn(async () => {
      controllore.abort()
      throw annullamentoAbort()
    }) as unknown as typeof fetch

    const r = await condividiMedia(input({ signal: controllore.signal }))

    expect(r).toEqual({ esito: 'non-riuscita', motivo: 'annullato' })
    expect(share).not.toHaveBeenCalled()
    expect(log.mock.calls.some((c) => c[0].livello === 'error')).toBe(false)
    expect(messaggi()).toEqual(['gallery-condivisione-annullata'])
  })

  it('gesto ritirato mentre il foglio si apre: «annullata», il file non resta pronto', async () => {
    const chiave = nuovaChiave()
    const controllore = new AbortController()
    share.mockImplementationOnce(async () => {
      controllore.abort()
      throw gestoScaduto()
    })

    const r = await condividiMedia(input({ chiave, signal: controllore.signal }))

    expect(r).toEqual({ esito: 'non-riuscita', motivo: 'annullato' })
    expect(messaggi()).toEqual(['gallery-condivisione-annullata'])
    await condividiMedia(input({ chiave }))
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})

/* ══════════════════════════════════════════════════════════════════════════
 * Etichetta
 * ══════════════════════════════════════════════════════════════════════════ */

describe('etichetta dei log', () => {
  beforeEach(() => {
    h.piattaforma.valore = 'web'
    stubNavigator('share', vi.fn().mockResolvedValue(undefined))
    stubNavigator('canShare', () => true)
  })

  it('etichetta chat: i log escono come chat-condivisione-…', async () => {
    const chiave = nuovaChiave()
    ;(navigator.share as ReturnType<typeof vi.fn>).mockRejectedValueOnce(gestoScaduto())

    await condividiMedia(input({ chiave, etichetta: 'chat' }))
    await condividiMedia(input({ chiave, etichetta: 'chat' }))
    globalThis.fetch = vi.fn(async () => risposta('', '', false, 403)) as unknown as typeof fetch
    await condividiMedia(input({ etichetta: 'chat' }))
    stubNavigator('canShare', undefined)
    await condividiMedia(input({ etichetta: 'chat' }))

    expect(messaggi()).toEqual([
      'chat-condivisione-gesto-scaduto',
      'chat-condivisione-riuscita:web-foglio',
      'chat-condivisione-non-riuscita: http-403',
      'chat-condivisione-non-riuscita: condivisione-file-assente',
    ])
  })

  it('un\'etichetta fuori forma non entra nei log: si usa «gallery»', async () => {
    await condividiMedia(input({ etichetta: 'Testo Libero di esempio!' }))

    expect(messaggi()).toEqual(['gallery-condivisione-riuscita:web-foglio'])
  })
})

/* ══════════════════════════════════════════════════════════════════════════
 * condividiFileWeb — il produttore, con `navigator.share` finto e il resto vero
 * ══════════════════════════════════════════════════════════════════════════ */

describe('condividiFileWeb', () => {
  const file = () => new File(['ciao'], 'prova.jpg', { type: 'image/jpeg' })
  let share: ReturnType<typeof vi.fn>
  beforeEach(() => {
    share = vi.fn().mockResolvedValue(undefined)
    stubNavigator('share', share)
  })

  it('passa a navigator.share il solo file (e il titolo, se c\'è)', async () => {
    const f = file()

    expect(await condividiFileWeb(f, 'Titolo')).toBe('foglio')
    expect(share).toHaveBeenCalledWith({ files: [f], title: 'Titolo' })

    share.mockClear()
    expect(await condividiFileWeb(f)).toBe('foglio')
    expect(share).toHaveBeenCalledWith({ files: [f] })
  })

  it('AbortError e «Share canceled» sono annullamenti dell\'utente', async () => {
    share.mockRejectedValueOnce(annullamentoAbort())
    expect(await condividiFileWeb(file())).toBe('annullato')

    share.mockRejectedValueOnce(new Error('Share canceled'))
    expect(await condividiFileWeb(file())).toBe('annullato')
  })

  it('NotAllowedError è il gesto scaduto, e non un annullamento', async () => {
    share.mockRejectedValueOnce(gestoScaduto())

    expect(await condividiFileWeb(file())).toBe('gesto-scaduto')
  })

  it('ogni altro errore è non-riuscita', async () => {
    share.mockRejectedValueOnce(new TypeError('x'))
    expect(await condividiFileWeb(file())).toBe('non-riuscita')

    share.mockRejectedValueOnce({ name: 'DataError' })
    expect(await condividiFileWeb(file())).toBe('non-riuscita')

    share.mockRejectedValueOnce(null)
    expect(await condividiFileWeb(file())).toBe('non-riuscita')
  })

  it('senza navigator.share: non-riuscita, senza lanciare', async () => {
    stubNavigator('share', undefined)

    expect(await condividiFileWeb(file())).toBe('non-riuscita')
  })

  it('segnale già interrotto: non-riuscita e il foglio non si apre; interrotto durante: lo stesso', async () => {
    const gia = new AbortController()
    gia.abort()
    expect(await condividiFileWeb(file(), undefined, gia.signal)).toBe('non-riuscita')
    expect(share).not.toHaveBeenCalled()

    // Un gesto ritirato non è un annullamento dell'utente né un gesto scaduto, qualunque
    // errore porti il rifiuto del foglio: chi chiama non deve tenere il file «pronto».
    const durante = new AbortController()
    share.mockImplementationOnce(async () => {
      durante.abort()
      throw gestoScaduto()
    })
    expect(await condividiFileWeb(file(), undefined, durante.signal)).toBe('non-riuscita')
  })
})
