import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * LA FOTOCAMERA DIRETTA di `scegliFotoNativa` — `sorgente: 'fotocamera'` e `latoMassimo`
 * (app 1.2, spec «caricamenti nativi» §2.2 e §7.2, compito J2; chiude il secondario #194 della PR 2).
 *
 * ─── IL FATTO ────────────────────────────────────────────────────────────────────────────────────
 * «Scatta una foto» nella Galleria apriva il foglio `CameraSource.Prompt` del plugin: un'etichetta che promette
 * la fotocamera e un foglio che offre DUE cose (scatta / scegli dalla libreria). Adesso la Galleria chiede la
 * fotocamera DIRETTA (`CameraSource.Camera`) a lato 1920. Gli altri chiamanti (chat, documenti, fascicolo) NON
 * cambiano: il predefinito resta il foglio a 1600 px.
 *
 * ─── COSA INCHIODA QUESTO FILE ───────────────────────────────────────────────────────────────────
 *  · il PREDEFINITO non si è mosso (PROMPT, 1600) — è l'altra metà del contratto, e senza di lei un cambio del
 *    predefinito passerebbe in silenzio;
 *  · la sorgente e il lato arrivano al plugin; un lato che non è un intero positivo non ci arriva mai;
 *  · con la fotocamera diretta le etichette del foglio NON si passano (non c'è nessun foglio);
 *  · il log del successo porta `canale` (la sorgente) e si scrive UNA volta per sessione e PER SORGENTE: un
 *    solo flag farebbe nascondere la fotocamera della Galleria dietro il successo del foglio della chat;
 *  · il log d'errore porta anche lui `canale`, e i campi restano sotto il tetto e leggibili da `redact`.
 *
 * Il modulo si RICARICA a ogni test (`resetModules`): il flag dei successi è stato di modulo, e senza il reset il
 * secondo test girerebbe su una sessione che ha già scritto il suo successo.
 *
 * Ogni caso è stato visto ROSSO rompendo il codice che prova (le mutazioni sono nel rapporto di J2).
 */

vi.mock('@/lib/push/native-register', () => ({ isNativeApp: vi.fn(() => true) }))

const logClient = vi.hoisted(() => vi.fn())
vi.mock('@/lib/logging/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/logging/client')>()),
  logClient,
}))

const getPhoto = vi.hoisted(() => vi.fn())
vi.mock('@capacitor/camera', () => ({
  Camera: { getPhoto },
  CameraResultType: { DataUrl: 'dataUrl' },
  CameraSource: { Prompt: 'PROMPT', Camera: 'CAMERA', Photos: 'PHOTOS' },
}))

import { redact } from '@/lib/logging/redact'

type Modulo = typeof import('@/lib/native/camera')
async function caricaCamera(): Promise<Modulo> {
  vi.resetModules()
  return import('@/lib/native/camera')
}

const ETICHETTE = { intestazione: 'Aggiungi una foto', scatta: 'Scatta una foto', libreria: 'Scegli dalla galleria', annulla: 'Annulla' }

const successi = () => logClient.mock.calls
  .map((c) => c[0] as { messaggio: string; livello: string; campi?: Record<string, unknown> })
  .filter((r) => r.messaggio === 'fotocamera-scatto-riuscito')
const errori = () => logClient.mock.calls
  .map((c) => c[0] as { messaggio: string; livello: string; campi?: Record<string, unknown> })
  .filter((r) => r.messaggio === 'fotocamera-errore' || r.messaggio === 'fotocamera-permesso-negato')

beforeEach(() => {
  logClient.mockClear()
  getPhoto.mockReset()
  getPhoto.mockResolvedValue({ dataUrl: 'data:image/jpeg;base64,AAAA', format: 'jpeg' })
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ blob: async () => new Blob(['x'], { type: 'image/jpeg' }) }))
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('il PREDEFINITO non si è mosso: il foglio «scatta o scegli», a 1600 px', () => {
  it.each([
    ['nessuna opzione', undefined],
    ['opzioni senza sorgente', { multiplo: true }],
    ['`sorgente: prompt` esplicita', { sorgente: 'prompt' as const }],
    ['una sorgente che non conosciamo vale il predefinito', { sorgente: 'galleria' as never }],
  ])('%s', async (_nome, opts) => {
    const { scegliFotoNativa } = await caricaCamera()
    await scegliFotoNativa(opts)
    expect(getPhoto.mock.calls[0][0]).toMatchObject({ source: 'PROMPT', width: 1600, height: 1600, quality: 80 })
  })
})

describe('la fotocamera DIRETTA: `sorgente: fotocamera`', () => {
  it('apre `CameraSource.Camera` e non il foglio', async () => {
    const { scegliFotoNativa } = await caricaCamera()
    await scegliFotoNativa({ sorgente: 'fotocamera' })
    expect(getPhoto.mock.calls[0][0].source).toBe('CAMERA')
  })

  it('mantiene le difese di sempre: ricodifica raddrizzata (niente EXIF né GPS), niente rullino, niente editor', async () => {
    const { scegliFotoNativa } = await caricaCamera()
    await scegliFotoNativa({ sorgente: 'fotocamera' })
    expect(getPhoto.mock.calls[0][0]).toMatchObject({
      resultType: 'dataUrl', correctOrientation: true, saveToGallery: false, allowEditing: false, quality: 80,
    })
  })

  it('con le etichette del foglio NON le passa al plugin (non c’è nessun foglio a cui darle)', async () => {
    const { scegliFotoNativa } = await caricaCamera()
    await scegliFotoNativa({ sorgente: 'fotocamera', etichette: ETICHETTE })
    const opzioni = getPhoto.mock.calls[0][0]
    for (const chiave of ['promptLabelHeader', 'promptLabelPicture', 'promptLabelPhoto', 'promptLabelCancel']) {
      expect(opzioni, chiave).not.toHaveProperty(chiave)
    }
  })

  it('…mentre il foglio le passa ancora (il predefinito con le etichette non è cambiato)', async () => {
    const { scegliFotoNativa } = await caricaCamera()
    await scegliFotoNativa({ etichette: ETICHETTE })
    expect(getPhoto.mock.calls[0][0]).toMatchObject({
      promptLabelHeader: 'Aggiungi una foto', promptLabelPicture: 'Scatta una foto',
      promptLabelPhoto: 'Scegli dalla galleria', promptLabelCancel: 'Annulla',
    })
  })

  it('restituisce il `File` JPEG come il foglio', async () => {
    const { scegliFotoNativa } = await caricaCamera()
    const files = await scegliFotoNativa({ sorgente: 'fotocamera' })
    expect(files).toHaveLength(1)
    expect(files[0]).toBeInstanceOf(File)
    expect(files[0].type).toBe('image/jpeg')
    expect(files[0].name).toMatch(/^foto-\d+\.jpg$/)
  })
})

describe('`latoMassimo` — il lato lungo dello scatto', () => {
  it('arriva al plugin come larghezza E altezza', async () => {
    const { scegliFotoNativa } = await caricaCamera()
    await scegliFotoNativa({ sorgente: 'fotocamera', latoMassimo: 1920 })
    expect(getPhoto.mock.calls[0][0]).toMatchObject({ width: 1920, height: 1920 })
  })

  it('vale anche per il foglio (è un’opzione del lato, non della sorgente)', async () => {
    const { scegliFotoNativa } = await caricaCamera()
    await scegliFotoNativa({ latoMassimo: 1024 })
    expect(getPhoto.mock.calls[0][0]).toMatchObject({ source: 'PROMPT', width: 1024, height: 1024 })
  })

  it.each([[0], [-1920], [1.5], [Number.NaN], [Number.POSITIVE_INFINITY], ['1920' as unknown as number]])(
    'un lato che non è un intero positivo (%s) non arriva MAI al plugin: vale il predefinito 1600',
    async (lato) => {
      const { scegliFotoNativa } = await caricaCamera()
      await scegliFotoNativa({ sorgente: 'fotocamera', latoMassimo: lato })
      expect(getPhoto.mock.calls[0][0]).toMatchObject({ width: 1600, height: 1600 })
    },
  )
})

describe('il log del successo: `canale` è la sorgente, e si scrive una volta per sessione E PER SORGENTE', () => {
  it('fotocamera diretta → `canale: fotocamera`; il foglio → `canale: prompt`', async () => {
    const { scegliFotoNativa } = await caricaCamera()
    await scegliFotoNativa({ sorgente: 'fotocamera' })
    expect(successi().map((r) => r.campi?.canale)).toEqual(['fotocamera'])
    await scegliFotoNativa()
    expect(successi().map((r) => r.campi?.canale)).toEqual(['fotocamera', 'prompt'])
    expect(successi()[0]).toMatchObject({ livello: 'warn', campi: { esito: 'ok', formato: 'jpeg', multiplo: false } })
  })

  it('la SECONDA foto della stessa sorgente non riscrive la riga (una volta per sessione)', async () => {
    const { scegliFotoNativa } = await caricaCamera()
    await scegliFotoNativa({ sorgente: 'fotocamera' })
    await scegliFotoNativa({ sorgente: 'fotocamera' })
    await scegliFotoNativa({ sorgente: 'fotocamera' })
    expect(successi()).toHaveLength(1)
  })

  it('il successo del foglio NON nasconde quello della fotocamera diretta (era il rischio di un flag solo)', async () => {
    const { scegliFotoNativa } = await caricaCamera()
    await scegliFotoNativa() // la chat scatta con il foglio: successo `prompt`
    await scegliFotoNativa({ sorgente: 'fotocamera' }) // la Galleria scatta con la fotocamera diretta
    expect(successi().map((r) => r.campi?.canale)).toEqual(['prompt', 'fotocamera'])
  })

  it('i campi del successo restano leggibili da `redact` (le chiavi sono in lista bianca)', async () => {
    const { scegliFotoNativa } = await caricaCamera()
    await scegliFotoNativa({ sorgente: 'fotocamera' })
    const campi = successi()[0].campi as Record<string, unknown>
    expect(redact(campi)).toEqual(campi)
  })
})

describe('il log d’errore dice anche DA QUALE strada', () => {
  it('un guasto della fotocamera diretta porta `canale: fotocamera`, uno del foglio `canale: prompt`', async () => {
    const { scegliFotoNativa } = await caricaCamera()
    getPhoto.mockRejectedValue(new Error('Device does not have a camera available'))
    await scegliFotoNativa({ sorgente: 'fotocamera' })
    await scegliFotoNativa()
    const [diretta, foglio] = errori()
    expect(diretta).toMatchObject({ livello: 'error', campi: { canale: 'fotocamera', error_code: 'no_camera_available', operazione: 'scatto' } })
    expect(foglio.campi?.canale).toBe('prompt')
  })

  it('i campi dell’errore restano sotto i 12 e passano intatti dalla lista bianca (anche con `canale`)', async () => {
    const { scegliFotoNativa } = await caricaCamera()
    getPhoto.mockRejectedValue(new Error('User denied access to camera'))
    await scegliFotoNativa({ sorgente: 'fotocamera' })
    const campi = errori()[0].campi as Record<string, unknown>
    expect(Object.keys(campi).length).toBeLessThanOrEqual(12)
    expect(redact(campi)).toEqual(campi)
  })

  it('l’annullamento resta silenzioso con la fotocamera diretta, come col foglio', async () => {
    const { scegliFotoNativa } = await caricaCamera()
    getPhoto.mockRejectedValue(new Error('User cancelled photos app'))
    await expect(scegliFotoNativa({ sorgente: 'fotocamera' })).resolves.toEqual([])
    expect(logClient).not.toHaveBeenCalled()
  })

  it('il permesso negato avvisa il chiamante (`onErrore`) anche con la fotocamera diretta', async () => {
    const { scegliFotoNativa } = await caricaCamera()
    getPhoto.mockRejectedValue(new Error('User denied access to camera'))
    const onErrore = vi.fn()
    await scegliFotoNativa({ sorgente: 'fotocamera', onErrore })
    expect(onErrore).toHaveBeenCalledWith('permesso_negato', 'permission_denied_camera')
  })
})

describe('sul web non c’è niente da aprire, qualunque sorgente', () => {
  it('`scegliFotoNativa({ sorgente: fotocamera })` risponde [] senza toccare il plugin', async () => {
    vi.resetModules()
    vi.doMock('@/lib/push/native-register', () => ({ isNativeApp: vi.fn(() => false) }))
    const { scegliFotoNativa } = await import('@/lib/native/camera')
    await expect(scegliFotoNativa({ sorgente: 'fotocamera' })).resolves.toEqual([])
    expect(getPhoto).not.toHaveBeenCalled()
    vi.doUnmock('@/lib/push/native-register')
  })
})
