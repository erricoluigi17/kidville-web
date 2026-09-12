import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

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

import { scegliFotoNativa } from '@/lib/native/camera'
import { MediaUploader } from '@/components/features/gallery/MediaUploader'
import { NewsMediaUploader } from '@/components/features/admin/news/NewsMediaUploader'

const scegliMock = vi.mocked(scegliFotoNativa)

beforeEach(() => {
  vi.clearAllMocks()
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
