import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// `scegliFotoNativa` deve degradare in modo pulito: su web (o su annullamento
// utente) restituisce `[]` e il chiamante ricade sull'<input type=file>.
// Su nativo apre @capacitor/camera (getPhoto, PROMPT) e converte il dataUrl in File.

vi.mock('@/lib/push/native-register', () => ({ isNativeApp: vi.fn() }))

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

  it('su annullamento/errore (getPhoto rifiuta) ritorna [] senza lanciare', async () => {
    isNativeMock.mockReturnValue(true)
    getPhotoMock.mockRejectedValue(new Error('User cancelled photos app'))
    await expect(scegliFotoNativa()).resolves.toEqual([])
  })

  it('se manca il dataUrl nel risultato ritorna []', async () => {
    isNativeMock.mockReturnValue(true)
    getPhotoMock.mockResolvedValue({ dataUrl: undefined })
    await expect(scegliFotoNativa()).resolves.toEqual([])
  })
})
