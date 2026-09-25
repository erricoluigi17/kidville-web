import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * L'HELPER UNICO DI DOWNLOAD DELL'APP 1.1 — `scaricaMedia`, `scaricaDocumento`,
 * `apriDocumento` in `src/lib/native/scarica.ts`.
 *
 * Tre mondi, simulati plugin per plugin:
 *  - NATIVO 1.1: Filesystem, FileTransfer, Media, FileViewer e Share registrati.
 *    Foto e video vanno in Galleria (iOS senza album = permesso di sola aggiunta;
 *    Android nell'album «Kidville»), i documenti nel foglio col FILE, l'apertura
 *    nell'anteprima di sistema.
 *  - NATIVO 1.0: solo Share. Nessun plugin nuovo si tocca; si ripiega come prima
 *    (link condiviso per gli URL assoluti) e il ripiego si registra.
 *  - WEB: stesso comportamento di prima (`<a download>`, `blob:`, scheda nuova).
 *
 * I finti NON rispondono tutti uguale: `isPluginAvailable` legge un insieme che
 * ogni test riempie, e ogni asserzione guarda gli ARGOMENTI (cartella, percorso,
 * album, credenziali della fetch), non solo l'esito.
 */

vi.mock('@/lib/push/native-register', () => ({ isNativeApp: vi.fn(() => false) }))
vi.mock('@/lib/native/share', () => ({
  condividiLink: vi.fn(async () => 'foglio' as const),
  condividiFileLocale: vi.fn(async () => true),
}))
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
    fv: { openDocumentFromLocalPath: vi.fn<(o: { path: string }) => Promise<void>>() },
    media: {
      savePhoto: vi.fn<(o: { path: string; albumIdentifier?: string; fileName?: string }) => Promise<unknown>>(),
      saveVideo: vi.fn<(o: { path: string; albumIdentifier?: string; fileName?: string }) => Promise<unknown>>(),
      getAlbums: vi.fn<() => Promise<{ albums?: { identifier?: string; name?: string }[] }>>(),
      createAlbum: vi.fn<(o: { name: string }) => Promise<void>>(),
      getAlbumsPath: vi.fn<() => Promise<{ path?: string }>>(),
    },
  }
})

const isPluginAvailable = vi.hoisted(() => vi.fn())
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isPluginAvailable,
    isNativePlatform: () => false,
    getPlatform: () => h.piattaforma.valore,
  },
  registerPlugin: (nome: string) =>
    ({ Filesystem: h.fs, FileTransfer: h.ft, FileViewer: h.fv, Media: h.media } as Record<string, unknown>)[nome],
}))

import { scaricaMedia, scaricaDocumento, apriDocumento, fileConsegnato, nomeFileDocumento, nomeFileScarico } from '@/lib/native/scarica'
import { condividiLink, condividiFileLocale } from '@/lib/native/share'
import { isNativeApp } from '@/lib/push/native-register'
import { logClient } from '@/lib/logging/client'

const nativo = vi.mocked(isNativeApp)
const condividiLinkMock = vi.mocked(condividiLink)
const condividiFileMock = vi.mocked(condividiFileLocale)
const log = vi.mocked(logClient)

const URL_FIRMATO = 'https://progetto-esempio.supabase.co/storage/v1/object/sign/gallery/a/foto.jpg?token=segreto'
const URL_DOC = 'https://progetto-esempio.supabase.co/storage/v1/object/sign/documenti/a/doc.pdf?token=segreto'
const URI_CACHE = 'file:///cache/foto.jpg'

const TUTTI = ['Filesystem', 'FileTransfer', 'Media', 'FileViewer', 'Share']

function rispostaConCorpo(testo = 'ciao', ok = true, status = 200) {
  return { ok, status, blob: async () => new Blob([testo], { type: 'application/pdf' }) } as unknown as Response
}

function messaggi(): string[] {
  return log.mock.calls.map((c) => c[0].messaggio)
}

/** Nessuna riga di log porta URL, token o nome del file: da lì si va in `app_log`. */
function nessunDatoNeiLog(): void {
  for (const m of messaggi()) {
    expect(m).not.toMatch(/supabase|token|segreto|esempio|bambino|https?:\/\/|file:\/\/|\/api\/|\.pdf|\.jpg|\.mp4/i)
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  h.disponibili.clear()
  h.piattaforma.valore = 'ios'
  isPluginAvailable.mockImplementation((nome: string) => h.disponibili.has(nome))
  h.fs.getUri.mockImplementation(async ({ path }) => ({ uri: `file:///cache/${path}` }))
  h.fs.writeFile.mockImplementation(async ({ path }) => ({ uri: `file:///cache/${path}` }))
  h.fs.deleteFile.mockResolvedValue(undefined)
  h.ft.downloadFile.mockImplementation(async ({ path }) => ({ path }))
  h.fv.openDocumentFromLocalPath.mockResolvedValue(undefined)
  h.media.savePhoto.mockResolvedValue({ identifier: 'x' })
  h.media.saveVideo.mockResolvedValue({ identifier: 'x' })
  h.media.getAlbumsPath.mockResolvedValue({ path: '/storage/media/app' })
  h.media.getAlbums.mockResolvedValue({ albums: [{ name: 'Altro', identifier: '/storage/media/app/Altro' }] })
  h.media.createAlbum.mockResolvedValue(undefined)
  condividiFileMock.mockResolvedValue(true)
  condividiLinkMock.mockResolvedValue('foglio')
  globalThis.fetch = vi.fn(async () => rispostaConCorpo()) as unknown as typeof fetch
})

afterEach(() => {
  nessunDatoNeiLog()
})

/* ══════════════════════════════════════════════════════════════════════════
 * NATIVO 1.1
 * ══════════════════════════════════════════════════════════════════════════ */

describe('scaricaMedia — nativo 1.1', () => {
  beforeEach(() => {
    nativo.mockReturnValue(true)
    TUTTI.forEach((p) => h.disponibili.add(p))
  })

  it('iOS: FileTransfer in CACHE e savePhoto SENZA album (solo permesso di aggiunta), niente base64', async () => {
    const r = await scaricaMedia({ url: URL_FIRMATO, nomeFile: 'foto.jpg', tipo: 'foto' })

    expect(r).toEqual({ esito: 'nativo-galleria' })
    expect(h.fs.getUri).toHaveBeenCalledWith({ path: 'foto.jpg', directory: 'CACHE' })
    expect(h.ft.downloadFile).toHaveBeenCalledWith({ url: URL_FIRMATO, path: URI_CACHE })
    // Proprio l'oggetto con il solo `path`: un `albumIdentifier` farebbe chiedere a
    // iOS l'accesso all'intera libreria.
    expect(h.media.savePhoto).toHaveBeenCalledWith({ path: URI_CACHE })
    expect(h.media.saveVideo).not.toHaveBeenCalled()
    expect(h.media.getAlbums).not.toHaveBeenCalled()
    // Niente base64 nel bridge: né fetch nella WebView né writeFile.
    expect(fetch).not.toHaveBeenCalled()
    expect(h.fs.writeFile).not.toHaveBeenCalled()
    // La copia in Cache si toglie: quella vera è in Galleria.
    expect(h.fs.deleteFile).toHaveBeenCalledWith({ path: 'foto.jpg', directory: 'CACHE' })
    expect(condividiFileMock).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      livello: 'warn',
      messaggio: 'gallery-scarico-riuscito:nativo-galleria',
    }))
    // Ogni plugin toccato è stato prima chiesto a isPluginAvailable.
    for (const p of ['Filesystem', 'FileTransfer', 'Media']) expect(isPluginAvailable).toHaveBeenCalledWith(p)
  })

  it('Android, video: crea l\'album «Kidville» se manca e salva lì, nome senza estensione', async () => {
    h.piattaforma.valore = 'android'
    const r = await scaricaMedia({ url: URL_FIRMATO.replace('foto.jpg', 'gita.mp4'), nomeFile: 'gita.mp4', tipo: 'video' })

    expect(r.esito).toBe('nativo-galleria')
    expect(h.media.createAlbum).toHaveBeenCalledWith({ name: 'Kidville' })
    expect(h.media.saveVideo).toHaveBeenCalledTimes(1)
    const opzioni = h.media.saveVideo.mock.calls[0][0]
    expect(opzioni.path).toBe('file:///cache/gita.mp4')
    expect(opzioni.albumIdentifier).toBe('/storage/media/app/Kidville')
    expect(opzioni.fileName).toMatch(/^gita-\d+$/)
    expect(h.media.savePhoto).not.toHaveBeenCalled()
  })

  it('Android: album già presente → nessuna creazione', async () => {
    h.piattaforma.valore = 'android'
    h.media.getAlbums.mockResolvedValue({ albums: [{ name: 'Kidville', identifier: '/storage/media/app/Kidville' }] })

    await scaricaMedia({ url: URL_FIRMATO, nomeFile: 'foto.jpg', tipo: 'foto' })

    expect(h.media.createAlbum).not.toHaveBeenCalled()
    expect(h.media.savePhoto.mock.calls[0][0].albumIdentifier).toBe('/storage/media/app/Kidville')
  })

  it('Android: «album esiste già» in gara si verifica rileggendo, non fallisce', async () => {
    h.piattaforma.valore = 'android'
    h.media.getAlbums
      .mockResolvedValueOnce({ albums: [] })
      .mockResolvedValueOnce({ albums: [{ name: 'Kidville', identifier: '/storage/media/app/Kidville' }] })
    h.media.createAlbum.mockRejectedValue(Object.assign(new Error('x'), { code: 'filesystemError' }))

    const r = await scaricaMedia({ url: URL_FIRMATO, nomeFile: 'foto.jpg', tipo: 'foto' })

    expect(r.esito).toBe('nativo-galleria')
    expect(h.media.savePhoto).toHaveBeenCalledTimes(1)
  })

  it('Galleria negata: il file già scaricato va nel foglio di sistema, e il motivo lo dice', async () => {
    h.media.savePhoto.mockRejectedValue(Object.assign(new Error('negato'), { code: 'accessDenied' }))

    const r = await scaricaMedia({ url: URL_FIRMATO, nomeFile: 'foto.jpg', tipo: 'foto', titolo: 'T' })

    expect(r).toEqual({ esito: 'nativo-file', motivo: 'galleria-accessDenied' })
    expect(condividiFileMock).toHaveBeenCalledWith(URI_CACHE, 'T')
    expect(condividiLinkMock).not.toHaveBeenCalled()
    expect(messaggi()).toContain('gallery-scarico-riuscito:nativo-file: galleria-accessDenied')
  })

  it('FileTransfer rifiuta con HTTP 403: ripiego sul link, motivo http-403, Galleria mai toccata', async () => {
    h.ft.downloadFile.mockRejectedValue({ code: 'OS-PLUG-FLTR-0010', message: 'corpo', data: { httpStatus: 403 } })

    const r = await scaricaMedia({ url: URL_FIRMATO, nomeFile: 'foto.jpg', tipo: 'foto', etichetta: 'gallery' })

    expect(r).toEqual({ esito: 'ripiego-condivisione', motivo: 'http-403' })
    expect(condividiLinkMock).toHaveBeenCalledWith({ url: URL_FIRMATO })
    expect(h.media.savePhoto).not.toHaveBeenCalled()
    expect(messaggi()).toContain('gallery-scarico-ripiego-condivisione: http-403')
  })

  it('FileTransfer 403 su un binario SENZA Share: condividiLink non si chiama, il motivo lo dice', async () => {
    h.disponibili.delete('Share')
    h.ft.downloadFile.mockRejectedValue({ code: 'OS-PLUG-FLTR-0010', data: { httpStatus: 403 } })

    const r = await scaricaMedia({ url: URL_FIRMATO, nomeFile: 'foto.jpg', tipo: 'foto' })

    expect(r).toEqual({ esito: 'non-riuscito', motivo: 'http-403|plugin-assenti:share' })
    expect(condividiLinkMock).not.toHaveBeenCalled()
    expect(condividiFileMock).not.toHaveBeenCalled()
    expect(isPluginAvailable).toHaveBeenCalledWith('Share')
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      livello: 'error',
      messaggio: 'gallery-scarico-non-riuscito: http-403|plugin-assenti:share',
    }))
  })

  it('Android: un nome già ripulito vicino al taglio non diventa «….j-<ora>» nell\'album', async () => {
    h.piattaforma.valore = 'android'
    const nome = nomeFileScarico('a'.repeat(58), URL_FIRMATO, 'foto')

    await scaricaMedia({ url: URL_FIRMATO, nomeFile: nome, tipo: 'foto' })

    expect(h.fs.getUri).toHaveBeenCalledWith({ path: nome, directory: 'CACHE' })
    expect(h.media.savePhoto.mock.calls[0][0].fileName).toMatch(new RegExp(`^${'a'.repeat(58)}-\\d+$`))
  })
})

describe('scaricaDocumento / apriDocumento — nativo 1.1', () => {
  beforeEach(() => {
    nativo.mockReturnValue(true)
    TUTTI.forEach((p) => h.disponibili.add(p))
  })

  it('URL assoluto: FileTransfer in CACHE e foglio col FILE; nessuna fetch nella WebView', async () => {
    const r = await scaricaDocumento({ sorgente: URL_DOC, nomeFile: 'doc.pdf', mime: 'application/pdf', titolo: 'Doc', etichetta: 'fattura' })

    expect(r).toEqual({ esito: 'nativo-file' })
    expect(h.ft.downloadFile).toHaveBeenCalledWith({ url: URL_DOC, path: 'file:///cache/doc.pdf' })
    expect(condividiFileMock).toHaveBeenCalledWith('file:///cache/doc.pdf', 'Doc')
    expect(fetch).not.toHaveBeenCalled()
    expect(h.fs.writeFile).not.toHaveBeenCalled()
    expect(messaggi()).toEqual(['fattura-scarico-riuscito:nativo-file'])
  })

  it('stessa origine: fetch con i cookie di sessione e writeFile in CACHE; FileTransfer NO', async () => {
    const r = await scaricaDocumento({
      sorgente: '/api/pagamenti/fattura?pagamento_id=p&download=1',
      nomeFile: 'fattura-12-2026',
      mime: 'application/pdf',
    })

    expect(r.esito).toBe('nativo-file')
    expect(fetch).toHaveBeenCalledWith('/api/pagamenti/fattura?pagamento_id=p&download=1', { credentials: 'same-origin' })
    expect(h.ft.downloadFile).not.toHaveBeenCalled()
    expect(h.fs.writeFile).toHaveBeenCalledWith({
      path: 'fattura-12-2026.pdf',
      data: btoa('ciao'),
      directory: 'CACHE',
      recursive: true,
    })
    expect(condividiFileMock).toHaveBeenCalledWith('file:///cache/fattura-12-2026.pdf', undefined)
  })

  it('Blob pronto e funzione che produce un Blob: i BYTE veri finiscono in writeFile', async () => {
    const xlsx = new Blob(['foglio-di-calcolo'], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
    await scaricaDocumento({ sorgente: xlsx, nomeFile: 'export', mime: xlsx.type })
    await scaricaDocumento({ sorgente: async () => new Blob(['pdf-generato']), nomeFile: 'ricevuta.pdf', mime: 'application/pdf' })

    expect(h.fs.writeFile.mock.calls.map((c) => [c[0].path, c[0].data])).toEqual([
      ['export.xlsx', btoa('foglio-di-calcolo')],
      ['ricevuta.pdf', btoa('pdf-generato')],
    ])
    expect(fetch).not.toHaveBeenCalled()
  })

  it('stessa origine con 401: non riuscito, e il link relativo NON si condivide', async () => {
    globalThis.fetch = vi.fn(async () => rispostaConCorpo('', false, 401)) as unknown as typeof fetch

    const r = await scaricaDocumento({ sorgente: '/api/primaria/pagella?x=1', nomeFile: 'pagella.pdf', etichetta: 'pagella' })

    expect(r).toEqual({ esito: 'non-riuscito', motivo: 'http-401' })
    expect(condividiLinkMock).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ livello: 'error', messaggio: 'pagella-scarico-non-riuscito: http-401' }))
  })

  it('apriDocumento: anteprima di sistema con FileViewer, niente foglio', async () => {
    const r = await apriDocumento({ sorgente: URL_DOC, nomeFile: 'doc.pdf', etichetta: 'pagella' })

    expect(r).toEqual({ esito: 'nativo-anteprima' })
    expect(h.fv.openDocumentFromLocalPath).toHaveBeenCalledWith({ path: 'file:///cache/doc.pdf' })
    expect(condividiFileMock).not.toHaveBeenCalled()
    expect(messaggi()).toEqual(['pagella-apertura-riuscita:nativo-anteprima'])
  })

  it('apriDocumento: FileViewer rifiuta (nessuna app) → foglio col file, motivo col codice', async () => {
    h.fv.openDocumentFromLocalPath.mockRejectedValue({ code: 'OS-PLUG-FLVW-0010' })

    const r = await apriDocumento({ sorgente: new Blob(['x']), nomeFile: 'doc.pdf' })

    expect(r).toEqual({ esito: 'nativo-file', motivo: 'anteprima-OS-PLUG-FLVW-0010' })
    expect(condividiFileMock).toHaveBeenCalledWith('file:///cache/doc.pdf', undefined)
  })

  it('apriDocumento senza FileViewer registrato: il plugin non si chiama, si passa al foglio e si segnala', async () => {
    h.disponibili.delete('FileViewer')

    const r = await apriDocumento({ sorgente: URL_DOC, nomeFile: 'doc.pdf' })

    expect(h.fv.openDocumentFromLocalPath).not.toHaveBeenCalled()
    expect(r).toEqual({ esito: 'nativo-file', motivo: 'plugin-assenti:fileviewer', binarioDaAggiornare: true })
  })
})

/* ══════════════════════════════════════════════════════════════════════════
 * NATIVO 1.0 — solo Share
 * ══════════════════════════════════════════════════════════════════════════ */

describe('binario 1.0 — nessun plugin nuovo si chiama, il ripiego è quello di prima e si registra', () => {
  beforeEach(() => {
    nativo.mockReturnValue(true)
    h.disponibili.add('Share')
  })

  function nessunPluginChiamato(): void {
    const tutti = [
      ...Object.values(h.fs), ...Object.values(h.ft), ...Object.values(h.fv), ...Object.values(h.media),
    ]
    for (const f of tutti) expect(f).not.toHaveBeenCalled()
  }

  it('scaricaMedia: foglio col link firmato, motivo con i plugin assenti, binarioDaAggiornare', async () => {
    const r = await scaricaMedia({ url: URL_FIRMATO, nomeFile: 'foto.jpg', tipo: 'foto' })

    expect(r).toEqual({
      esito: 'ripiego-condivisione',
      motivo: 'plugin-assenti:filesystem+filetransfer+media|plugin-filesystem-assente',
      binarioDaAggiornare: true,
    })
    expect(condividiLinkMock).toHaveBeenCalledWith({ url: URL_FIRMATO })
    nessunPluginChiamato()
    expect(messaggi()).toEqual([
      'gallery-scarico-ripiego-condivisione: plugin-assenti:filesystem+filetransfer+media|plugin-filesystem-assente',
    ])
  })

  it('scaricaDocumento con URL assoluto: condivide il link come prima', async () => {
    const r = await scaricaDocumento({ sorgente: URL_DOC, nomeFile: 'doc.pdf' })

    expect(r.esito).toBe('ripiego-condivisione')
    expect(r.binarioDaAggiornare).toBe(true)
    expect(condividiLinkMock).toHaveBeenCalledWith({ url: URL_DOC })
    nessunPluginChiamato()
  })

  it('scaricaDocumento della stessa origine: non riuscito, SENZA condividere il link né fare fetch', async () => {
    const r = await scaricaDocumento({ sorgente: '/api/pagamenti/fattura?userId=u', nomeFile: 'f.pdf', etichetta: 'fattura' })

    expect(r).toEqual({
      esito: 'non-riuscito',
      motivo: 'plugin-assenti:filesystem|link-non-condivisibile',
      binarioDaAggiornare: true,
    })
    expect(condividiLinkMock).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    nessunPluginChiamato()
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      livello: 'error',
      messaggio: 'fattura-scarico-non-riuscito: plugin-assenti:filesystem|link-non-condivisibile',
    }))
  })

  it('apriDocumento con URL assoluto: stesso ripiego, FileViewer mai chiamato', async () => {
    const r = await apriDocumento({ sorgente: URL_DOC, nomeFile: 'doc.pdf' })

    expect(r.esito).toBe('ripiego-condivisione')
    expect(r.binarioDaAggiornare).toBe(true)
    nessunPluginChiamato()
  })

  /** Il foglio col link si apre, ma intanto il gesto viene ritirato (tetto, smontaggio). */
  function condivisioneCheAnnulla(controllore: AbortController): void {
    condividiLinkMock.mockImplementation(async () => {
      controllore.abort()
      return 'foglio'
    })
  }

  function soloAnnullatoNeiLog(atteso: string): void {
    expect(log.mock.calls.some((c) => c[0].livello === 'error')).toBe(false)
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ livello: 'warn', messaggio: atteso }))
    expect(messaggi()).toEqual([atteso])
  }

  it('scaricaMedia annullato durante il ripiego: resta «annullato», nessun avviso di aggiornamento, nessun error', async () => {
    const controllore = new AbortController()
    condivisioneCheAnnulla(controllore)

    const r = await scaricaMedia({ url: URL_FIRMATO, nomeFile: 'foto.jpg', tipo: 'foto', signal: controllore.signal })

    expect(condividiLinkMock).toHaveBeenCalledTimes(1)
    expect(r).toEqual({ esito: 'non-riuscito', motivo: 'annullato' })
    expect(r.binarioDaAggiornare).toBeUndefined()
    nessunPluginChiamato()
    soloAnnullatoNeiLog('gallery-scarico-annullato')
  })

  it('scaricaDocumento (URL assoluto) annullato durante il ripiego: resta «annullato», nessun error', async () => {
    const controllore = new AbortController()
    condivisioneCheAnnulla(controllore)

    const r = await scaricaDocumento({ sorgente: URL_DOC, nomeFile: 'doc.pdf', etichetta: 'fattura', signal: controllore.signal })

    expect(condividiLinkMock).toHaveBeenCalledTimes(1)
    expect(r).toEqual({ esito: 'non-riuscito', motivo: 'annullato' })
    expect(r.binarioDaAggiornare).toBeUndefined()
    nessunPluginChiamato()
    soloAnnullatoNeiLog('fattura-scarico-annullato')
  })

  it('apriDocumento (URL assoluto) annullato durante il ripiego: resta «annullata», nessun error', async () => {
    const controllore = new AbortController()
    condivisioneCheAnnulla(controllore)

    const r = await apriDocumento({ sorgente: URL_DOC, nomeFile: 'doc.pdf', signal: controllore.signal })

    expect(r).toEqual({ esito: 'non-riuscito', motivo: 'annullato' })
    soloAnnullatoNeiLog('documento-apertura-annullata')
  })

  it('apriDocumento senza FileViewer, foglio rifiutato e gesto ritirato nel ripiego: nessun binarioDaAggiornare', async () => {
    h.disponibili.add('Filesystem')
    h.disponibili.add('FileTransfer')
    condividiFileMock.mockResolvedValue(false)
    const controllore = new AbortController()
    condivisioneCheAnnulla(controllore)

    const r = await apriDocumento({ sorgente: URL_DOC, nomeFile: 'doc.pdf', signal: controllore.signal })

    expect(h.ft.downloadFile).toHaveBeenCalledTimes(1)
    expect(h.fv.openDocumentFromLocalPath).not.toHaveBeenCalled()
    expect(condividiFileMock).toHaveBeenCalledTimes(1)
    expect(r).toEqual({ esito: 'non-riuscito', motivo: 'annullato' })
    soloAnnullatoNeiLog('documento-apertura-annullata')
  })

  it('binario con il solo Filesystem (senza FileTransfer/Media): scarico di prima, file nel foglio', async () => {
    h.disponibili.add('Filesystem')

    const r = await scaricaMedia({ url: URL_FIRMATO, nomeFile: 'foto.jpg', tipo: 'foto' })

    expect(r).toEqual({ esito: 'nativo-file', motivo: 'plugin-assenti:filetransfer+media', binarioDaAggiornare: true })
    expect(h.fs.writeFile).toHaveBeenCalledTimes(1)
    expect(h.ft.downloadFile).not.toHaveBeenCalled()
    expect(h.media.savePhoto).not.toHaveBeenCalled()
  })
})

/* ══════════════════════════════════════════════════════════════════════════
 * WEB
 * ══════════════════════════════════════════════════════════════════════════ */

describe('web — il comportamento di prima', () => {
  let click: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    nativo.mockReturnValue(false)
    TUTTI.forEach((p) => h.disponibili.add(p))
    URL.createObjectURL = vi.fn(() => 'blob:kidville/1') as unknown as typeof URL.createObjectURL
    URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL
    click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  })
  afterEach(() => {
    click.mockRestore()
    vi.restoreAllMocks()
  })

  function ancora(): HTMLAnchorElement {
    return click.mock.contexts[0] as HTMLAnchorElement
  }

  it('scaricaMedia: fetch → blob: → <a download>, nessun plugin', async () => {
    const r = await scaricaMedia({ url: URL_FIRMATO, nomeFile: 'foto.jpg', tipo: 'foto' })

    expect(r).toEqual({ esito: 'web-blob' })
    expect(ancora().getAttribute('href')).toBe('blob:kidville/1')
    expect(ancora().getAttribute('download')).toBe('foto.jpg')
    expect(h.ft.downloadFile).not.toHaveBeenCalled()
    expect(h.media.savePhoto).not.toHaveBeenCalled()
    expect(messaggi()).toEqual(['gallery-scarico-riuscito:web-blob'])
  })

  it('scaricaDocumento stessa origine: fetch coi cookie → risposta controllata → blob: → <a download>', async () => {
    const r = await scaricaDocumento({ sorgente: '/api/export?x=1', nomeFile: 'export.xlsx' })

    expect(r).toEqual({ esito: 'web-blob' })
    expect(fetch).toHaveBeenCalledWith('/api/export?x=1', { credentials: 'same-origin' })
    // L'ancora punta al blob: (i byte VISTI), non all'indirizzo della route.
    expect(ancora().getAttribute('href')).toBe('blob:kidville/1')
    expect(ancora().getAttribute('download')).toBe('export.xlsx')
    expect(messaggi()).toEqual(['documento-scarico-riuscito:web-blob'])
  })

  it('scaricaDocumento stessa origine con 401: non riuscito, NESSUN clic sull\'ancora, log d\'errore', async () => {
    globalThis.fetch = vi.fn(async () => rispostaConCorpo('non autorizzato', false, 401)) as unknown as typeof fetch

    const r = await scaricaDocumento({ sorgente: '/api/pagamenti/fattura?x=1', nomeFile: 'fattura.pdf', etichetta: 'fattura' })

    expect(r).toEqual({ esito: 'non-riuscito', motivo: 'http-401' })
    expect(click).not.toHaveBeenCalled()
    expect(URL.createObjectURL).not.toHaveBeenCalled()
    expect(condividiLinkMock).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ livello: 'error', messaggio: 'fattura-scarico-non-riuscito: http-401' }))
    expect(messaggi().some((m) => m.includes('-scarico-riuscito'))).toBe(false)
  })

  it('scaricaMedia con un nome GIÀ ripulito da nomeFileScarico: stesso attributo download di oggi, niente doppio taglio', async () => {
    const nome = nomeFileScarico('a'.repeat(58), URL_FIRMATO, 'foto')
    expect(nome).toBe(`${'a'.repeat(58)}.jpg`)

    const r = await scaricaMedia({ url: URL_FIRMATO, nomeFile: nome, tipo: 'foto' })

    expect(r).toEqual({ esito: 'web-blob' })
    expect(ancora().getAttribute('download')).toBe(nome)
  })

  it('scaricaDocumento con funzione-Blob: blob: → <a download>', async () => {
    const r = await scaricaDocumento({ sorgente: () => new Blob(['a;b']), nomeFile: 'elenco', mime: 'text/csv' })

    expect(r).toEqual({ esito: 'web-blob' })
    expect(ancora().getAttribute('href')).toBe('blob:kidville/1')
    expect(ancora().getAttribute('download')).toBe('elenco.csv')
  })

  it('apriDocumento con URL: la scheda si apre DENTRO il gesto, prima di ogni await', async () => {
    const finestra = { opener: {}, closed: false, close: vi.fn(), location: { replace: vi.fn() } }
    const open = vi.spyOn(window, 'open').mockReturnValue(finestra as unknown as Window)

    const promessa = apriDocumento({ sorgente: URL_DOC, nomeFile: 'doc.pdf' })
    // Sincrono: nessuna microtask è ancora passata.
    expect(open).toHaveBeenCalledWith(URL_DOC, '_blank')
    expect(await promessa).toEqual({ esito: 'web-scheda' })
    expect(finestra.opener).toBeNull()
    expect(messaggi()).toEqual(['documento-apertura-riuscita:web-scheda'])
  })

  it('apriDocumento con funzione: scheda vuota subito, poi location.replace sul blob:', async () => {
    const finestra = { opener: {}, closed: false, close: vi.fn(), location: { replace: vi.fn() } }
    const open = vi.spyOn(window, 'open').mockReturnValue(finestra as unknown as Window)

    const promessa = apriDocumento({ sorgente: async () => new Blob(['pdf']), nomeFile: 'pagella.pdf' })
    expect(open).toHaveBeenCalledWith('', '_blank')
    expect(finestra.location.replace).not.toHaveBeenCalled()

    expect(await promessa).toEqual({ esito: 'web-scheda' })
    expect(finestra.location.replace).toHaveBeenCalledWith('blob:kidville/1')
  })

  it('apriDocumento con la scheda bloccata: si scarica invece di tacere', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null)

    const r = await apriDocumento({ sorgente: new Blob(['x']), nomeFile: 'doc.pdf' })

    expect(r).toEqual({ esito: 'web-blob', motivo: 'finestra-bloccata' })
    expect(ancora().getAttribute('download')).toBe('doc.pdf')
  })

  it('apriDocumento con la scheda bloccata e il gesto ritirato durante la fetch: «annullata», nessun error', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null)
    const controllore = new AbortController()
    globalThis.fetch = vi.fn(async () => {
      controllore.abort()
      throw new DOMException('interrotto', 'AbortError')
    }) as unknown as typeof fetch

    const r = await apriDocumento({ sorgente: '/api/documento?x=1', nomeFile: 'doc.pdf', signal: controllore.signal })

    expect(fetch).toHaveBeenCalledWith('/api/documento?x=1', { credentials: 'same-origin', signal: controllore.signal })
    expect(r).toEqual({ esito: 'non-riuscito', motivo: 'annullato' })
    expect(click).not.toHaveBeenCalled()
    expect(log.mock.calls.some((c) => c[0].livello === 'error')).toBe(false)
    expect(messaggi()).toEqual(['documento-apertura-annullata'])
  })

  it('apriDocumento con funzione e il gesto ritirato mentre la sorgente lavora: scheda chiusa, «annullata»', async () => {
    const finestra = { opener: {}, closed: false, close: vi.fn(), location: { replace: vi.fn() } }
    vi.spyOn(window, 'open').mockReturnValue(finestra as unknown as Window)
    const controllore = new AbortController()

    const r = await apriDocumento({
      sorgente: async () => {
        controllore.abort()
        throw new DOMException('interrotto', 'AbortError')
      },
      nomeFile: 'pagella.pdf',
      signal: controllore.signal,
    })

    expect(r).toEqual({ esito: 'non-riuscito', motivo: 'annullato' })
    expect(finestra.close).toHaveBeenCalledTimes(1)
    expect(finestra.location.replace).not.toHaveBeenCalled()
    expect(log.mock.calls.some((c) => c[0].livello === 'error')).toBe(false)
    expect(messaggi()).toEqual(['documento-apertura-annullata'])
  })
})

/* ══════════════════════════════════════════════════════════════════════════
 * Contorno
 * ══════════════════════════════════════════════════════════════════════════ */

describe('contorno', () => {
  it('un\'etichetta fuori forma non entra nei log: si usa quella predefinita', async () => {
    nativo.mockReturnValue(true)
    TUTTI.forEach((p) => h.disponibili.add(p))

    await scaricaDocumento({ sorgente: URL_DOC, nomeFile: 'doc.pdf', etichetta: 'Testo Libero di esempio!' })

    expect(messaggi()).toEqual(['documento-scarico-riuscito:nativo-file'])
  })

  it('il nome del file sul dispositivo non è mai un percorso, e riceve l\'estensione dal mime', () => {
    expect(nomeFileDocumento('../../bambino/segreto', 'application/pdf')).not.toMatch(/\/|\.\./)
    expect(nomeFileDocumento('', 'application/pdf')).toBe('kidville-documento.pdf')
    expect(nomeFileDocumento('ricevuta.pdf', 'application/pdf')).toBe('ricevuta.pdf')
  })

  it('nomi lunghi: si tronca la BASE, l\'estensione resta intera (con e senza mime)', () => {
    for (const lunghezza of [57, 58, 59]) {
      const base = 'b'.repeat(lunghezza)
      expect(nomeFileDocumento(`${base}.pdf`, 'application/pdf')).toBe(`${base}.pdf`)
      expect(nomeFileDocumento(`${base}.pdf`)).toBe(`${base}.pdf`)
    }
    // Oltre BASE_MAX si taglia la base, mai la coda.
    expect(nomeFileDocumento(`${'c'.repeat(80)}.PDF`)).toBe(`${'c'.repeat(60)}.pdf`)
  })

  it('un punto nel nome non è un\'estensione: «ricevuta n.12» riceve .pdf dal mime', () => {
    expect(nomeFileDocumento('ricevuta n.12', 'application/pdf')).toBe('ricevuta n.12.pdf')
    // L'estensione già riconosciuta non si raddoppia, e ripassare di qui non cambia niente.
    const una = nomeFileDocumento('pagella 2026.pdf', 'application/pdf')
    expect(nomeFileDocumento(una, 'application/pdf')).toBe(una)
  })

  it('nomeFileScarico è idempotente anche vicino al taglio', () => {
    for (const lunghezza of [57, 58, 59, 60, 61]) {
      const una = nomeFileScarico('a'.repeat(lunghezza), URL_FIRMATO, 'foto')
      expect(nomeFileScarico(una, URL_FIRMATO, 'foto')).toBe(una)
      expect(una.endsWith('.jpg')).toBe(true)
      expect(una).not.toMatch(/\.j\.jpg$/)
    }
  })

  it('fileConsegnato: solo gli esiti che lasciano il file in mano', () => {
    for (const esito of ['nativo-file', 'nativo-galleria', 'nativo-anteprima', 'web-blob', 'web-scheda'] as const) {
      expect(fileConsegnato({ esito })).toBe(true)
    }
    for (const esito of ['ripiego-condivisione', 'ripiego-appunti', 'non-riuscito'] as const) {
      expect(fileConsegnato({ esito })).toBe(false)
    }
  })
})
