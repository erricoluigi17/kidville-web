import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// `scegliFotoNativa` deve degradare in modo pulito: su web (o su annullamento
// utente) restituisce `[]` e il chiamante ricade sull'<input type=file>.
// Su nativo apre @capacitor/camera (getPhoto, PROMPT) e converte il dataUrl in File.

vi.mock('@/lib/push/native-register', () => ({ isNativeApp: vi.fn() }))

const logClient = vi.hoisted(() => vi.fn())
vi.mock('@/lib/logging/client', () => ({ logClient }))

const getPhotoMock = vi.hoisted(() => vi.fn())
vi.mock('@capacitor/camera', () => ({
  Camera: { getPhoto: getPhotoMock },
  CameraResultType: { DataUrl: 'dataUrl', Uri: 'uri', Base64: 'base64' },
  CameraSource: { Prompt: 'PROMPT', Camera: 'CAMERA', Photos: 'PHOTOS' },
}))

import { isNativeApp } from '@/lib/push/native-register'
import { fotocameraNativaDisponibile, scegliFotoNativa } from '@/lib/native/camera'

const isNativeMock = vi.mocked(isNativeApp)

beforeEach(() => {
  vi.clearAllMocks()
  // fetch(dataUrl) → blob JPEG (jsdom non risolve i data: URL da solo)
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ blob: async () => new Blob(['x'], { type: 'image/jpeg' }) }),
  )
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fotocameraNativaDisponibile', () => {
  it('riflette isNativeApp() — false su web', () => {
    isNativeMock.mockReturnValue(false)
    expect(fotocameraNativaDisponibile()).toBe(false)
  })
  it('true quando isNativeApp() è true', () => {
    isNativeMock.mockReturnValue(true)
    expect(fotocameraNativaDisponibile()).toBe(true)
  })
})

describe('scegliFotoNativa', () => {
  it('su web ritorna [] senza toccare la fotocamera', async () => {
    isNativeMock.mockReturnValue(false)
    const files = await scegliFotoNativa()
    expect(files).toEqual([])
    expect(getPhotoMock).not.toHaveBeenCalled()
  })

  it('su nativo converte il dataUrl in un File immagine', async () => {
    isNativeMock.mockReturnValue(true)
    getPhotoMock.mockResolvedValue({ dataUrl: 'data:image/jpeg;base64,AAAA' })
    const files = await scegliFotoNativa()
    expect(files).toHaveLength(1)
    expect(files[0]).toBeInstanceOf(File)
    expect(files[0].type).toBe('image/jpeg')
    expect(files[0].name).toMatch(/^foto-\d+\.jpg$/)
    // getPhoto chiamato con PROMPT + dataUrl + qualità
    expect(getPhotoMock).toHaveBeenCalledTimes(1)
    const opts = getPhotoMock.mock.calls[0][0]
    expect(opts).toMatchObject({ resultType: 'dataUrl', source: 'PROMPT', quality: 80 })
  })

  it('LIMITA la risoluzione: senza, l’upload sforava il body della funzione', async () => {
    // È il difetto: a piena risoluzione una foto pesa 4-6 MB, l'upload falliva
    // con un 413 e nel fascicolo lo spinner restava appeso senza messaggio.
    isNativeMock.mockReturnValue(true)
    getPhotoMock.mockResolvedValue({ dataUrl: 'data:image/jpeg;base64,AAAA' })
    await scegliFotoNativa()
    expect(getPhotoMock.mock.calls[0][0]).toMatchObject({
      width: 1600,
      height: 1600,
      // Raddrizza E ri-codifica: la ricodifica lascia indietro l'EXIF (GPS).
      correctOrientation: true,
      // La foto di un certificato medico non deve finire nel rullino.
      saveToGallery: false,
      allowEditing: false,
    })
  })

  it('con le etichette passate localizza il foglio nativo', async () => {
    isNativeMock.mockReturnValue(true)
    getPhotoMock.mockResolvedValue({ dataUrl: 'data:image/jpeg;base64,AAAA' })
    await scegliFotoNativa({
      etichette: {
        intestazione: 'Aggiungi una foto',
        scatta: 'Scatta una foto',
        libreria: 'Scegli dalla galleria',
        annulla: 'Annulla',
      },
    })
    expect(getPhotoMock.mock.calls[0][0]).toMatchObject({
      promptLabelHeader: 'Aggiungi una foto',
      promptLabelPicture: 'Scatta una foto',
      promptLabelPhoto: 'Scegli dalla galleria',
      promptLabelCancel: 'Annulla',
    })
  })

  it('senza etichette NON passa alcun promptLabel: la lib resta pura', async () => {
    isNativeMock.mockReturnValue(true)
    getPhotoMock.mockResolvedValue({ dataUrl: 'data:image/jpeg;base64,AAAA' })
    await scegliFotoNativa()
    expect(getPhotoMock.mock.calls[0][0].promptLabelHeader).toBeUndefined()
  })

  it('l’ANNULLAMENTO dell’utente non è un guasto: [] e nessun log', async () => {
    isNativeMock.mockReturnValue(true)
    getPhotoMock.mockRejectedValue(new Error('User cancelled photos app'))
    await expect(scegliFotoNativa()).resolves.toEqual([])
    expect(logClient).not.toHaveBeenCalled()
  })

  it('il PERMESSO NEGATO invece lo è: si logga e si avvisa il chiamante', async () => {
    // Prima un unico catch inghiottiva tutto e il sintomo era identico —
    // «premo e non succede niente» — sia per l'annullamento sia per il permesso.
    isNativeMock.mockReturnValue(true)
    getPhotoMock.mockRejectedValue(new Error('User denied access to camera'))
    const onErrore = vi.fn()
    await expect(scegliFotoNativa({ onErrore })).resolves.toEqual([])
    expect(onErrore).toHaveBeenCalledWith('permesso_negato')
    expect(logClient).toHaveBeenCalledTimes(1)
    expect(logClient.mock.calls[0][0].messaggio).toBe('fotocamera-permesso-negato')
  })

  it('nel log non finisce MAI il messaggio del plugin', async () => {
    isNativeMock.mockReturnValue(true)
    getPhotoMock.mockRejectedValue(new Error('/percorso/privato/foto-di-un-minore.jpg'))
    await scegliFotoNativa()
    expect(JSON.stringify(logClient.mock.calls)).not.toContain('minore')
  })

  it('se manca il dataUrl nel risultato ritorna []', async () => {
    isNativeMock.mockReturnValue(true)
    getPhotoMock.mockResolvedValue({ dataUrl: undefined })
    await expect(scegliFotoNativa()).resolves.toEqual([])
  })
})
