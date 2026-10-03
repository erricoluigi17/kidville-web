import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useRef } from 'react'

/**
 * `useImagePicker` e i due parametri NUOVI: `sorgente` e `latoMassimo` (app 1.2, spec «caricamenti nativi»
 * §7.2, compito J2).
 *
 * L'hook è condiviso da MOLTI chiamanti (la Galleria, la chat, i documenti del fascicolo, le news…): solo la
 * Galleria chiede la fotocamera diretta a 1920 px. Il contratto è quindi doppio, e le due metà hanno lo stesso
 * peso:
 *   1. chi li passa li vede arrivare a `scegliFotoNativa`;
 *   2. chi NON li passa chiama `scegliFotoNativa` esattamente come prima — nemmeno le chiavi, non solo i valori —
 *      perché il suo predefinito (il foglio, 1600 px) sta in `camera.ts` e un `undefined` esplicito non deve
 *      poterlo scavalcare.
 *
 * Ogni caso è stato visto ROSSO rompendo il codice che prova (le mutazioni sono nel rapporto di J2).
 */

vi.mock('@/lib/native/camera', () => ({
  fotocameraNativaDisponibile: vi.fn(),
  scegliFotoNativa: vi.fn(),
}))

import { fotocameraNativaDisponibile, scegliFotoNativa } from '@/lib/native/camera'
import { useImagePicker, type UseImagePickerOptions } from '@/lib/native/use-image-picker'

const dispMock = vi.mocked(fotocameraNativaDisponibile)
const scegliMock = vi.mocked(scegliFotoNativa)

beforeEach(() => {
  vi.clearAllMocks()
  dispMock.mockReturnValue(true)
  scegliMock.mockResolvedValue([])
})

function setup(extra: Partial<UseImagePickerOptions> = {}) {
  // `onFiles` stabile fra i render. ⚠️ Non basta a rendere questo test una prova delle DIPENDENZE dell'hook: il
  // mock di next-intl restituisce un `t` nuovo a ogni render (`test/setup.ts`), quindi `apri` si ricrea comunque.
  // Le dipendenze di `useCallback` le tiene la regola `react-hooks/exhaustive-deps` (misurato: toglierne due fa
  // scattare un warning, e il gate è a zero warning); il test prova che i parametri nuovi arrivino davvero.
  const onFiles = vi.fn()
  return renderHook((props: Partial<UseImagePickerOptions>) => {
    const inputRef = useRef<HTMLInputElement | null>(null)
    inputRef.current = { click: vi.fn() } as unknown as HTMLInputElement
    return useImagePicker({ inputRef, onFiles, ...props })
  }, { initialProps: extra })
}

describe('chi li passa li vede arrivare a `scegliFotoNativa`', () => {
  it('`sorgente: fotocamera` e `latoMassimo: 1920`', async () => {
    const { result } = setup({ sorgente: 'fotocamera', latoMassimo: 1920, multiplo: true })
    await act(async () => { await result.current.apri() })
    expect(scegliMock).toHaveBeenCalledTimes(1)
    expect(scegliMock.mock.calls[0][0]).toMatchObject({ sorgente: 'fotocamera', latoMassimo: 1920, multiplo: true })
    // Le etichette del foglio le traduce comunque l'hook (le usa il foglio, se la sorgente è `prompt`).
    expect(scegliMock.mock.calls[0][0]?.etichette).toMatchObject({ scatta: 'Scatta una foto' })
  })

  it('anche `sorgente: prompt` esplicita arriva (non si perde per essere il valore di default)', async () => {
    const { result } = setup({ sorgente: 'prompt' })
    await act(async () => { await result.current.apri() })
    expect(scegliMock.mock.calls[0][0]).toMatchObject({ sorgente: 'prompt' })
  })

  it('i parametri seguono il re-render: l’hook non tiene quelli del primo', async () => {
    const { result, rerender } = setup({ sorgente: 'prompt', latoMassimo: 1600 })
    rerender({ sorgente: 'fotocamera', latoMassimo: 1920 })
    await act(async () => { await result.current.apri() })
    expect(scegliMock.mock.calls[0][0]).toMatchObject({ sorgente: 'fotocamera', latoMassimo: 1920 })
  })
})

describe('chi NON li passa chiama `scegliFotoNativa` come prima', () => {
  it('nessuna delle due CHIAVI arriva (un `undefined` esplicito scavalcherebbe il predefinito di camera.ts)', async () => {
    const { result } = setup({ multiplo: true })
    await act(async () => { await result.current.apri() })
    const opzioni = scegliMock.mock.calls[0][0] as Record<string, unknown>
    expect(opzioni).not.toHaveProperty('sorgente')
    expect(opzioni).not.toHaveProperty('latoMassimo')
    expect(Object.keys(opzioni).sort()).toEqual(['etichette', 'multiplo', 'onErrore'])
  })

  it('un `undefined` passato apposta vale «non passato»', async () => {
    const { result } = setup({ sorgente: undefined, latoMassimo: undefined })
    await act(async () => { await result.current.apri() })
    const opzioni = scegliMock.mock.calls[0][0] as Record<string, unknown>
    expect(opzioni).not.toHaveProperty('sorgente')
    expect(opzioni).not.toHaveProperty('latoMassimo')
  })
})

describe('sul web i due parametri non fanno niente: l’hook clicca l’<input>', () => {
  it('con `sorgente: fotocamera` su web non si apre nessuna fotocamera', async () => {
    dispMock.mockReturnValue(false)
    const { result } = setup({ sorgente: 'fotocamera', latoMassimo: 1920 })
    await act(async () => { await result.current.apri() })
    expect(scegliMock).not.toHaveBeenCalled()
  })
})
