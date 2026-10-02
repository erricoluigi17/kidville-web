import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useRef } from 'react'

// Il hook decide la sorgente: su nativo la fotocamera Capacitor, su web il click
// sull'<input type=file>. La UI web resta identica.
vi.mock('@/lib/native/camera', () => ({
  fotocameraNativaDisponibile: vi.fn(),
  scegliFotoNativa: vi.fn(),
}))

import { fotocameraNativaDisponibile, scegliFotoNativa } from '@/lib/native/camera'
import { useImagePicker } from '@/lib/native/use-image-picker'

const dispMock = vi.mocked(fotocameraNativaDisponibile)
const scegliMock = vi.mocked(scegliFotoNativa)

beforeEach(() => {
  vi.clearAllMocks()
})

function setup(
  onFiles: (f: File[]) => void,
  multiplo = false,
  extra: Pick<Parameters<typeof useImagePicker>[0], 'onErrore' | 'onAnnullato'> = {},
) {
  return renderHook(() => {
    const inputRef = useRef<HTMLInputElement | null>(null)
    const click = vi.fn()
    // input finto con .click() spiato
    inputRef.current = { click } as unknown as HTMLInputElement
    const picker = useImagePicker({ inputRef, onFiles, multiplo, ...extra })
    return { picker, click }
  })
}

describe('useImagePicker', () => {
  it('su web: apri() clicca l\'input e non tocca la fotocamera', async () => {
    dispMock.mockReturnValue(false)
    const onFiles = vi.fn()
    const { result } = setup(onFiles)
    await act(async () => { await result.current.picker.apri() })
    expect(result.current.click).toHaveBeenCalledTimes(1)
    expect(scegliMock).not.toHaveBeenCalled()
    expect(onFiles).not.toHaveBeenCalled()
  })

  it('su nativo: apri() usa la fotocamera e passa i File a onFiles senza cliccare l\'input', async () => {
    dispMock.mockReturnValue(true)
    const file = new File(['x'], 'foto-1.jpg', { type: 'image/jpeg' })
    scegliMock.mockResolvedValue([file])
    const onFiles = vi.fn()
    const { result } = setup(onFiles)
    await act(async () => { await result.current.picker.apri() })
    expect(scegliMock).toHaveBeenCalledWith(
      expect.objectContaining({
        multiplo: false,
        // L'hook traduce le etichette del foglio nativo: prima il picker
        // Capacitor compariva in inglese dentro un'app italiana.
        etichette: expect.objectContaining({ scatta: 'Scatta una foto' }),
      }),
    )
    expect(onFiles).toHaveBeenCalledWith([file])
    expect(result.current.click).not.toHaveBeenCalled()
  })

  it('su nativo con annullamento (scegliFotoNativa → []) non chiama onFiles', async () => {
    dispMock.mockReturnValue(true)
    scegliMock.mockResolvedValue([])
    const onFiles = vi.fn()
    const { result } = setup(onFiles)
    await act(async () => { await result.current.picker.apri() })
    expect(onFiles).not.toHaveBeenCalled()
    expect(result.current.click).not.toHaveBeenCalled()
  })
})

/**
 * `onAnnullato` — il segnale che la galleria usa per `annullato-fotocamera` (spec video PR 2 §11.1).
 *
 * `scegliFotoNativa` risponde `[]` sia all'annullamento sia all'errore, e li separa solo `onErrore`
 * (che non scatta mai per l'annullamento). L'hook deve quindi dire «annullato» solo quando NON ci sono
 * file E NON c'è stato un errore: un permesso negato ha già il suo log e il suo avviso, e dichiararlo
 * «chiuso dall'utente» falserebbe proprio il conteggio che si vuole leggere.
 */
describe('useImagePicker — onAnnullato', () => {
  it('su nativo, foglio chiuso senza foto e senza errore: onAnnullato scatta UNA volta', async () => {
    dispMock.mockReturnValue(true)
    scegliMock.mockResolvedValue([])
    const onFiles = vi.fn()
    const onAnnullato = vi.fn()
    const { result } = setup(onFiles, false, { onAnnullato })
    await act(async () => { await result.current.picker.apri() })
    expect(onAnnullato).toHaveBeenCalledTimes(1)
    expect(onFiles).not.toHaveBeenCalled()
  })

  it('su nativo con un errore (permesso negato): onErrore scatta, onAnnullato NO', async () => {
    dispMock.mockReturnValue(true)
    scegliMock.mockImplementation(async (opts) => {
      opts?.onErrore?.('permesso_negato', 'permission_denied_camera')
      return []
    })
    const onErrore = vi.fn()
    const onAnnullato = vi.fn()
    const { result } = setup(vi.fn(), false, { onErrore, onAnnullato })
    await act(async () => { await result.current.picker.apri() })
    expect(onErrore).toHaveBeenCalledWith('permesso_negato', 'permission_denied_camera')
    expect(onAnnullato, 'un errore non è un annullamento').not.toHaveBeenCalled()
  })

  it('un errore impedisce `onAnnullato` anche se il chiamante NON ha passato `onErrore` (l’hook lo intercetta da sé)', async () => {
    dispMock.mockReturnValue(true)
    scegliMock.mockImplementation(async (opts) => {
      opts?.onErrore?.('errore', 'plist_camera')
      return []
    })
    const onAnnullato = vi.fn()
    const { result } = setup(vi.fn(), false, { onAnnullato })
    await act(async () => { await result.current.picker.apri() })
    expect(onAnnullato).not.toHaveBeenCalled()
  })

  it('su nativo con una foto: onFiles sì, onAnnullato no', async () => {
    dispMock.mockReturnValue(true)
    const file = new File(['x'], 'foto-1.jpg', { type: 'image/jpeg' })
    scegliMock.mockResolvedValue([file])
    const onFiles = vi.fn()
    const onAnnullato = vi.fn()
    const { result } = setup(onFiles, false, { onAnnullato })
    await act(async () => { await result.current.picker.apri() })
    expect(onFiles).toHaveBeenCalledWith([file])
    expect(onAnnullato).not.toHaveBeenCalled()
  })

  it('su web non scatta mai: `apri()` clicca l’input e la fotocamera non si tocca', async () => {
    dispMock.mockReturnValue(false)
    const onAnnullato = vi.fn()
    const { result } = setup(vi.fn(), false, { onAnnullato })
    await act(async () => { await result.current.picker.apri() })
    expect(result.current.click).toHaveBeenCalledTimes(1)
    expect(onAnnullato).not.toHaveBeenCalled()
  })

  it('senza `onAnnullato` (gli altri chiamanti dell’hook) l’annullamento resta silenzioso e non lancia', async () => {
    dispMock.mockReturnValue(true)
    scegliMock.mockResolvedValue([])
    const { result } = setup(vi.fn())
    await expect(act(async () => { await result.current.picker.apri() })).resolves.not.toThrow()
  })
})
