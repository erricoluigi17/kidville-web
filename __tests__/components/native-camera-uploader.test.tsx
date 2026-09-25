import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react'

// Verifica il WIRING della fotocamera nativa nei due uploader immagine:
// su nativo il trigger deve instradare il File della fotocamera nello STESSO
// handler di upload dell'input (flusso invariato).

vi.mock('@/lib/native/camera', () => ({
  fotocameraNativaDisponibile: vi.fn(() => true),
  scegliFotoNativa: vi.fn(),
}))

// framer-motion → render diretto (deterministico in jsdom)
vi.mock('framer-motion', async () => {
  const React = await import('react')
  const strip = (props: Record<string, unknown>) => {
    const { initial, animate, exit, variants, transition, whileHover, whileTap, layout, ...rest } = props
    void initial; void animate; void exit; void variants; void transition; void whileHover; void whileTap; void layout
    return rest
  }
  const motion = new Proxy({}, {
    get: (_t, tag: string) => React.forwardRef(function M(
      { children, ...props }: { children?: React.ReactNode }, ref: React.Ref<HTMLElement>,
    ) { return React.createElement(tag, { ...strip(props), ref }, children) }),
  })
  return { motion, AnimatePresence: ({ children }: { children?: React.ReactNode }) => children }
})

import { fotocameraNativaDisponibile, scegliFotoNativa } from '@/lib/native/camera'
import { MediaUploader } from '@/components/features/gallery/MediaUploader'
import { NewsMediaUploader } from '@/components/features/admin/news/NewsMediaUploader'

const scegliMock = vi.mocked(scegliFotoNativa)

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(fotocameraNativaDisponibile).mockReturnValue(true)
  Object.defineProperty(URL, 'createObjectURL', { value: vi.fn(() => 'blob:x'), configurable: true })
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('MediaUploader — fotocamera nativa', () => {
  it('il click sulla drop-zone aggiunge la foto nativa alle anteprime', async () => {
    scegliMock.mockResolvedValue([new File(['x'], 'foto-1.jpg', { type: 'image/jpeg' })])
    render(<MediaUploader onUpload={vi.fn()} />)
    fireEvent.click(screen.getByText(/Trascina foto o video/i))
    // A foto acquisita compare il pulsante che porta allo step dei tag, col
    // conteggio. ⚠️ Diceva «Carica 1 file» — e non caricava niente: il caricamento
    // vero parte solo dopo lo step 2. L'etichetta è stata corretta il 2026-09-11
    // insieme all'anteprima dei video; qui cambia il SELETTORE, non l'intento.
    // Si cerca per RUOLO e NOME ACCESSIBILE e si pretende l'assenza del verbo
    // sbagliato: un `/1 file/i` da solo corrisponderebbe anche alla vecchia
    // etichetta, cioè non distinguerebbe più il prima dal dopo.
    const avanti = await screen.findByRole('button', { name: /1 file/i })
    expect(avanti.textContent, 'il bottone non carica: porta ai tag').not.toMatch(/carica/i)
    expect(scegliMock).toHaveBeenCalledWith(
      expect.objectContaining({
        multiplo: true,
        // L'hook traduce le etichette del foglio nativo: prima il picker
        // Capacitor compariva in inglese dentro un'app italiana.
        etichette: expect.objectContaining({ scatta: 'Scatta una foto' }),
      }),
    )
  })

  it('dopo uno scatto riuscito offre ancora un gesto separato per scegliere un video dal dispositivo', async () => {
    scegliMock.mockResolvedValue([new File(['foto'], 'scatto.jpg', { type: 'image/jpeg' })])
    const { container } = render(<MediaUploader onUpload={vi.fn()} />)
    fireEvent.click(screen.getByText(/Trascina foto o video/i))
    await screen.findByRole('button', { name: /1 file/i })
    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    expect(input.accept).toContain('video/*')
    const clickInput = vi.spyOn(input, 'click')
    fireEvent.click(screen.getByRole('button', { name: /scegli.*file/i }))
    expect(clickInput).toHaveBeenCalledTimes(1)
    expect(scegliMock, 'la scelta file non riapre la fotocamera').toHaveBeenCalledTimes(1)
  })

  it('mostra la configurazione iOS e offre la scelta file con un nuovo gesto', async () => {
    scegliMock.mockImplementation(async opts => {
      opts?.onErrore?.('errore', 'plist_photo_library_add')
      return []
    })
    const { container } = render(<MediaUploader onUpload={vi.fn()} />)
    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    const clickInput = vi.spyOn(input, 'click')
    fireEvent.click(screen.getByText(/Trascina foto o video/i))
    expect(await screen.findByRole('alert')).toHaveTextContent(/configurazione/i)
    expect(clickInput).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /scegli.*file/i }))
    expect(clickInput).toHaveBeenCalledTimes(1)
    expect(scegliMock, 'il click DOM dell’input non deve risalire e riaprire la fotocamera').toHaveBeenCalledTimes(1)
  })

  it('distingue il permesso negato dall’annullamento', async () => {
    scegliMock.mockImplementationOnce(async opts => {
      opts?.onErrore?.('permesso_negato', 'permission_denied_camera')
      return []
    }).mockResolvedValueOnce([])
    render(<MediaUploader onUpload={vi.fn()} />)
    fireEvent.click(screen.getByText(/Trascina foto o video/i))
    expect(await screen.findByRole('alert')).toHaveTextContent(/permesso/i)
    fireEvent.click(screen.getByText(/Trascina foto o video/i))
    await waitFor(() => expect(scegliMock).toHaveBeenCalledTimes(2))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('accetta un JPEG senza MIME, mantiene i file validi e segnala quelli sconosciuti', async () => {
    const onUpload = vi.fn()
    const { container } = render(<MediaUploader onUpload={onUpload} />)
    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    const foto = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0])], 'foto.jpeg')
    const ignoto = new File([new Uint8Array([1, 2, 3])], 'ingannevole.jpg')
    fireEvent.change(input, { target: { files: [foto, ignoto] } })
    expect(await screen.findByRole('alert')).toHaveTextContent(/formato/i)
    fireEvent.click(screen.getByRole('button', { name: /1 file/i }))
    expect(onUpload).toHaveBeenCalledTimes(1)
    expect(onUpload.mock.calls[0][0]).toHaveLength(1)
    expect(onUpload.mock.calls[0][0][0].file.type).toBe('image/jpeg')
  })

  it('riconosce un video MP4 senza MIME dai byte, non dall’estensione', async () => {
    const onUpload = vi.fn()
    const { container } = render(<MediaUploader onUpload={onUpload} />)
    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    const video = new File([new Uint8Array([0, 0, 0, 16, 102, 116, 121, 112, 105, 115, 111, 109])], 'ripresa.bin')
    fireEvent.change(input, { target: { files: [video] } })
    const continua = await screen.findByRole('button', { name: /1 file/i })
    fireEvent.click(continua)
    expect(onUpload.mock.calls[0][0][0].file.type).toBe('video/mp4')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it.each(['video/quicktime', 'video/x-m4v'])('accetta il video in ingresso %s per la pipeline', async tipo => {
    const onUpload = vi.fn()
    const { container } = render(<MediaUploader onUpload={onUpload} />)
    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File(['video'], 'ripresa.mov', { type: tipo })] } })
    fireEvent.click(await screen.findByRole('button', { name: /1 file/i }))
    expect(onUpload.mock.calls[0][0][0].file.type).toBe(tipo)
  })

  it('rifiuta visibilmente un HEIC senza MIME anche se si chiama video.mp4', async () => {
    const onUpload = vi.fn()
    const { container } = render(<MediaUploader onUpload={onUpload} />)
    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    const heic = new File([new Uint8Array([0, 0, 0, 16, 102, 116, 121, 112, 104, 101, 105, 99])], 'video.mp4')
    fireEvent.change(input, { target: { files: [heic] } })
    expect(await screen.findByRole('alert')).toHaveTextContent(/formato/i)
    expect(screen.queryByRole('button', { name: /1 file/i })).not.toBeInTheDocument()
    expect(onUpload).not.toHaveBeenCalled()
  })

  it('non crea URL oggetto se la lettura della firma termina dopo lo smontaggio', async () => {
    let completaLettura: (() => void) | undefined
    class LettoreControllato {
      result: ArrayBuffer | null = null
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      readAsArrayBuffer() {
        completaLettura = () => {
          this.result = new Uint8Array([0xff, 0xd8, 0xff]).buffer
          this.onload?.()
        }
      }
    }
    vi.stubGlobal('FileReader', LettoreControllato)
    const { container, unmount } = render(<MediaUploader onUpload={vi.fn()} />)
    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File([new Uint8Array([0xff, 0xd8, 0xff])], 'foto.jpg')] } })
    expect(completaLettura).toBeDefined()
    unmount()
    await act(async () => { completaLettura?.() })
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })
})

describe('NewsMediaUploader — fotocamera nativa', () => {
  it('con consenso già dato, la foto nativa viene caricata e ritorna l\'URL', async () => {
    scegliMock.mockResolvedValue([new File(['x'], 'foto-1.jpg', { type: 'image/jpeg' })])
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => ({ fileUrl: 'https://cdn/x.jpg' }),
    }))
    const onUploaded = vi.fn()
    render(
      <NewsMediaUploader userId="u1" consensoFoto onConsensoFoto={vi.fn()} onUploaded={onUploaded} />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Carica immagine/i }))
    await waitFor(() => expect(onUploaded).toHaveBeenCalledWith('https://cdn/x.jpg'))
    expect(scegliMock).toHaveBeenCalled()
  })
})
