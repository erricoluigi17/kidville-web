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

function setup(onFiles: (f: File[]) => void, multiplo = false) {
  return renderHook(() => {
    const inputRef = useRef<HTMLInputElement | null>(null)
    const click = vi.fn()
    // input finto con .click() spiato
    inputRef.current = { click } as unknown as HTMLInputElement
    const picker = useImagePicker({ inputRef, onFiles, multiplo })
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
