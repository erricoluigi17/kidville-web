import { describe, expect, it, vi } from 'vitest'
import { FotoTroppoGrandeError, leggiByteFoto } from '@/lib/gallery/byte-foto'
import { TETTO_GALLERIA_BYTE } from '@/lib/gallery/limiti'

describe('byte foto portabili', () => {
  it('rifiuta un originale sovradimensionato prima di leggerlo in memoria', async () => {
    const read = vi.fn()
    const file = new Blob(['x'], { type: 'image/jpeg' })
    Object.defineProperties(file, { size: { value: TETTO_GALLERIA_BYTE + 1 }, arrayBuffer: { value: read } })
    await expect(leggiByteFoto(file)).rejects.toBeInstanceOf(FotoTroppoGrandeError)
    expect(read).not.toHaveBeenCalled()
  })

  it('propaga una lettura fallita senza inventare byte', async () => {
    const file = new Blob(['x'])
    Object.defineProperty(file, 'arrayBuffer', { value: () => Promise.reject(new DOMException('non leggibile', 'NotReadableError')) })
    await expect(leggiByteFoto(file)).rejects.toHaveProperty('name', 'NotReadableError')
  })
})
