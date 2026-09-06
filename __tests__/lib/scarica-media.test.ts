import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * LO SCARICO DI UNA FOTO DELLA GALLERIA — nativo contro web.
 *
 * ─── IL DIFETTO, MISURATO ────────────────────────────────────────────────────
 * Lato genitore il pulsante «Scarica» non faceva niente, mentre «Condividi»
 * funzionava. Il codice costruiva un `blob:` e cliccava un `<a download>`: nella
 * WebView Capacitor quel gesto NON scarica e NON solleva eccezioni, quindi il
 * `catch` non scattava e il ripiego (`window.open(url,'_blank')`) era muto a sua
 * volta — Capacitor non abilita le finestre multiple, e `capacitor.config.ts`
 * non dichiara nessun `setSupportMultipleWindows`.
 *
 * In `app_log` di produzione, però, una riga c'è: il 2026-09-05 alle 07:18:00.561
 * `gallery-download-diretto-fallito` su iOS — e ALLO STESSO MILLESIMO
 * `GET /storage/v1/object/sign/gallery/… — Load failed` con `stato_http = 0`.
 * Cioè: prima ancora del `<a download>`, è la `fetch` verso l'indirizzo firmato
 * (CROSS-ORIGIN, verso Supabase) che può morire dentro la WebView. Il ramo
 * d'errore quindi ESISTE — quello che mancava è che facesse qualcosa di utile:
 * il ripiego non si vedeva, il motivo non veniva loggato (`contesto: {}`,
 * `codice: null`) e del successo non restava traccia alcuna.
 *
 * ─── COSA BLOCCA QUESTO FILE ─────────────────────────────────────────────────
 * 1. Su NATIVO si prende la strada nativa (file scritto sul dispositivo e
 *    passato al foglio di sistema), su WEB quella web (`<a download>` su un
 *    `blob:`, che è SAME-ORIGIN — con l'href firmato di Supabase l'attributo
 *    `download` sarebbe ignorato per definizione).
 * 2. Nessun ramo è mai muto: quando la strada principale non riesce si ripiega
 *    sulla condivisione del link, che nella WebView è l'unico gesto che si è
 *    visto funzionare davvero.
 * 3. Il nome del file ha un'ESTENSIONE (prima era la didascalia nuda) e non può
 *    contenere separatori di percorso: su nativo diventa un `path` vero.
 */

vi.mock('@/lib/push/native-register', () => ({ isNativeApp: vi.fn(() => false) }))
vi.mock('@/lib/native/share', () => ({
  condividiLink: vi.fn(async () => 'foglio' as const),
  condividiFileLocale: vi.fn(async () => true),
}))

// Tipizzato di proposito: senza gli argomenti dichiarati `mock.calls[0][0]` non
// compila, e l'asserzione sulla cartella `CACHE` è metà del valore del file.
type OpzioniScrittura = { path: string; data: string; directory: string; recursive?: boolean }
const filesystemFinto = vi.hoisted(() => ({
  writeFile: vi.fn<(o: OpzioniScrittura) => Promise<{ uri?: string }>>(),
  getUri: vi.fn<(o: { path: string; directory: string }) => Promise<{ uri?: string }>>(),
}))
const isPluginAvailable = vi.hoisted(() => vi.fn(() => true))
vi.mock('@capacitor/core', () => ({
  Capacitor: { isPluginAvailable, isNativePlatform: () => false },
  registerPlugin: () => filesystemFinto,
}))

import { scarica, nomeFileScarico, estensioneMedia } from '@/lib/native/scarica'
import { condividiLink, condividiFileLocale } from '@/lib/native/share'
import { isNativeApp } from '@/lib/push/native-register'

const nativo = vi.mocked(isNativeApp)
const condividiMock = vi.mocked(condividiLink)
const condividiFileMock = vi.mocked(condividiFileLocale)

const URL_FIRMATO =
  'https://esempio.supabase.co/storage/v1/object/sign/gallery/uploads/abc/foto.jpg?token=xyz'

/** Una risposta `fetch` finta con un corpo vero: serve un `Blob` leggibile. */
function rispostaConCorpo(ok = true, status = 200) {
  return {
    ok,
    status,
    blob: async () => new Blob(['byte-di-prova'], { type: 'image/jpeg' }),
  } as unknown as Response
}

describe('scarica() — nativo contro web', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isPluginAvailable.mockReturnValue(true)
    filesystemFinto.writeFile.mockResolvedValue({ uri: 'file:///cache/foto.jpg' })
    filesystemFinto.getUri.mockResolvedValue({ uri: 'file:///cache/foto.jpg' })
    condividiFileMock.mockResolvedValue(true)
    condividiMock.mockResolvedValue('foglio')
    globalThis.fetch = vi.fn(async () => rispostaConCorpo()) as unknown as typeof fetch
  })

  it('su NATIVO scrive il file e lo passa al foglio di sistema (mai un <a download>)', async () => {
    nativo.mockReturnValue(true)
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click')

    const esito = await scarica({ url: URL_FIRMATO, nomeFile: 'foto.jpg', titolo: 'T' })

    expect(esito.esito).toBe('nativo-file')
    expect(filesystemFinto.writeFile).toHaveBeenCalledTimes(1)
    // `Directory.Cache` sul filo è la stringa 'CACHE': è la cartella che il
    // sistema può ripulire da sé, e non chiede permessi di archiviazione.
    expect(filesystemFinto.writeFile.mock.calls[0][0]).toMatchObject({
      path: 'foto.jpg',
      directory: 'CACHE',
    })
    expect(condividiFileMock).toHaveBeenCalledWith('file:///cache/foto.jpg', 'T')
    // È il punto: su nativo l'ancora non si tocca proprio.
    expect(click).not.toHaveBeenCalled()
    click.mockRestore()
  })

  it('su WEB clicca un <a download> su un blob: e non tocca il filesystem nativo', async () => {
    nativo.mockReturnValue(false)
    const creaUrl = vi.fn(() => 'blob:kidville/1')
    const revoca = vi.fn()
    URL.createObjectURL = creaUrl as unknown as typeof URL.createObjectURL
    URL.revokeObjectURL = revoca as unknown as typeof URL.revokeObjectURL

    // `mockImplementation` vuota: in jsdom un click su un'ancora con `href`
    // tenta una navigazione e stampa «Not implemented».
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    const esito = await scarica({ url: URL_FIRMATO, nomeFile: 'ricordo.jpg' })

    expect(esito.esito).toBe('web-blob')
    expect(click).toHaveBeenCalledTimes(1)
    // `mock.contexts[0]` è l'elemento SU CUI è stato chiamato `click()`.
    const ancora = click.mock.contexts[0] as HTMLAnchorElement
    expect(ancora.getAttribute('download')).toBe('ricordo.jpg')
    // L'href DEVE essere il blob (same-origin): con l'URL firmato di Supabase
    // l'attributo `download` verrebbe ignorato, perché è fuori origine.
    expect(ancora.getAttribute('href')).toBe('blob:kidville/1')
    expect(filesystemFinto.writeFile).not.toHaveBeenCalled()
    click.mockRestore()
  })

  it('su NATIVO senza il plugin Filesystem ripiega sulla condivisione del link, non sul silenzio', async () => {
    nativo.mockReturnValue(true)
    isPluginAvailable.mockReturnValue(false)

    const esito = await scarica({ url: URL_FIRMATO, nomeFile: 'foto.jpg', titolo: 'T' })

    expect(esito).toEqual({ esito: 'ripiego-condivisione', motivo: 'plugin-filesystem-assente' })
    expect(condividiMock).toHaveBeenCalledWith({ url: URL_FIRMATO, title: 'T' })
    expect(filesystemFinto.writeFile).not.toHaveBeenCalled()
  })

  it('la fetch che muore nella WebView (il caso misurato in produzione) finisce nel ripiego, col motivo', async () => {
    nativo.mockReturnValue(true)
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('Load failed')
    }) as unknown as typeof fetch

    const esito = await scarica({ url: URL_FIRMATO, nomeFile: 'foto.jpg' })

    expect(esito.esito).toBe('ripiego-condivisione')
    // Il MOTIVO non si butta via: senza, in `app_log` resta una riga che dice
    // «non è riuscito» e non dice perché — ed è esattamente la riga che c'era.
    expect(esito.motivo).toBe('TypeError')
    expect(condividiMock).toHaveBeenCalledTimes(1)
  })

  it('un indirizzo firmato scaduto (403) non è muto: ripiego col codice http', async () => {
    nativo.mockReturnValue(false)
    globalThis.fetch = vi.fn(async () => rispostaConCorpo(false, 403)) as unknown as typeof fetch

    const esito = await scarica({ url: URL_FIRMATO, nomeFile: 'foto.jpg' })

    // Il `beforeEach` fa rispondere `foglio` a `condividiLink`: questo è il ramo
    // che l'utente VEDE. Il suo gemello è il test qui sotto, che cambia solo
    // quello e pretende un verdetto diverso.
    expect(esito).toEqual({ esito: 'ripiego-condivisione', motivo: 'http-403' })
  })

  it('lo STESSO scarico che finisce negli appunti ha un verdetto DIVERSO da quello del foglio', async () => {
    // Stesso identico caso del test qui sopra — genitore sul web, indirizzo
    // firmato scaduto — con una sola differenza: niente Web Share API, quindi
    // `condividiLink` copia negli appunti invece di aprire il foglio.
    //
    // PERCHÉ È UN LOCK E NON UN DETTAGLIO: la copia negli appunti è MUTA. Se i
    // due rami tornassero lo stesso verdetto, `MediaGrid` non avrebbe NIENTE con
    // cui decidere se avvisare, e il genitore resterebbe con un pulsante premuto,
    // nessun file e nessun messaggio — il difetto di partenza, spostato di un
    // ramo. `share.ts` la distinzione ce l'ha già (`EsitoCondivisione`); qui si
    // pretende che non muoia per strada.
    nativo.mockReturnValue(false)
    globalThis.fetch = vi.fn(async () => rispostaConCorpo(false, 403)) as unknown as typeof fetch
    condividiMock.mockResolvedValueOnce('appunti')

    const esito = await scarica({ url: URL_FIRMATO, nomeFile: 'foto.jpg' })

    expect(esito).toEqual({ esito: 'ripiego-appunti', motivo: 'http-403' })
  })

  it('quando NEMMENO il ripiego offre un canale, il verdetto è «non riuscito» (l’unico da error)', async () => {
    nativo.mockReturnValue(true)
    isPluginAvailable.mockReturnValue(false)
    condividiMock.mockResolvedValueOnce('non-riuscita')

    const esito = await scarica({ url: URL_FIRMATO, nomeFile: 'foto.jpg' })

    expect(esito).toEqual({
      esito: 'non-riuscito',
      motivo: 'plugin-filesystem-assente|condivisione-non-riuscita',
    })
  })

  it('non lancia MAI: nemmeno se anche il ripiego esplode', async () => {
    nativo.mockReturnValue(true)
    isPluginAvailable.mockReturnValue(false)
    condividiMock.mockRejectedValueOnce(new Error('foglio rotto'))

    const esito = await scarica({ url: URL_FIRMATO, nomeFile: 'foto.jpg' })

    expect(esito.esito).toBe('non-riuscito')
    expect(esito.motivo).toContain('plugin-filesystem-assente')
  })

  it('il foglio di sistema annullato dall’utente non fa ripiegare: il file è stato consegnato', async () => {
    nativo.mockReturnValue(true)
    // `condividiFileLocale` risponde `true` anche sull'annullamento: il
    // meccanismo ha funzionato. Se rispondesse `false`, ogni «Annulla» del
    // genitore scriverebbe in `app_log` una riga di ripiego che non è successo.
    condividiFileMock.mockResolvedValueOnce(true)

    const esito = await scarica({ url: URL_FIRMATO, nomeFile: 'foto.jpg' })

    expect(esito.esito).toBe('nativo-file')
    expect(condividiMock).not.toHaveBeenCalled()
  })
})

describe('nomeFileScarico() — il nome che il file avrà sul telefono', () => {
  it('aggiunge l’estensione presa dal percorso firmato (prima non ce n’era nessuna)', () => {
    expect(nomeFileScarico('Gita al parco', URL_FIRMATO, 'foto')).toBe('Gita al parco.jpg')
  })

  it('senza didascalia usa un nome nostro, mai vuoto', () => {
    expect(nomeFileScarico(null, URL_FIRMATO, 'foto')).toBe('kidville-foto.jpg')
    expect(nomeFileScarico('   ', 'https://x/y/clip', 'video')).toBe('kidville-video.mp4')
  })

  it('toglie i separatori di percorso: su nativo il nome diventa un path vero', () => {
    const nome = nomeFileScarico('../../etc/passwd', URL_FIRMATO, 'foto')
    expect(nome).not.toContain('/')
    expect(nome).not.toContain('..')
    expect(nome.endsWith('.jpg')).toBe(true)
  })

  it('non raddoppia l’estensione quando la didascalia già ce l’ha', () => {
    expect(nomeFileScarico('foto.jpg', URL_FIRMATO, 'foto')).toBe('foto.jpg')
  })

  it('estensione dal percorso, non dalla query firmata', () => {
    expect(estensioneMedia(URL_FIRMATO, 'foto')).toBe('jpg')
    expect(estensioneMedia('https://x/y/filmato.mov?token=a.png', 'video')).toBe('mov')
    // Percorso senza estensione: si ricade sul tipo dichiarato dalla riga.
    expect(estensioneMedia('https://x/y/senzaestensione?t=1', 'video')).toBe('mp4')
    expect(estensioneMedia('https://x/y/senzaestensione?t=1', 'foto')).toBe('jpg')
  })
})
