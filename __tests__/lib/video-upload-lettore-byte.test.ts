import { describe, expect, it } from 'vitest'
import { Blob as NodeBlob } from 'node:buffer'
import { LettoreBlob } from '@/lib/media/video/upload/lettore-blob'

describe('corpo TUS indipendente dai Blob WebKit', () => {
  it('spedisce byte legacy e dichiara anche la size richiesta da TUS sul blocco finale', async () => {
    const originale = new NodeBlob([new Uint8Array([1, 2, 3, 4, 5])]) as unknown as Blob
    const sorgente = await new LettoreBlob().openFile(originale)
    const fetta = await sorgente.slice(2, 8)
    expect(fetta.value).toBeInstanceOf(Uint8Array)
    expect(Array.from(fetta.value as unknown as Uint8Array)).toEqual([3, 4, 5])
    expect(fetta.value.size).toBe(3)
    expect(fetta.done).toBe(true)
  })

  it('legge soltanto l’intervallo richiesto di una sorgente persistente', async () => {
    const letture: number[][] = []
    const ingresso = {
      size: 2_000_000_000,
      type: 'video/mp4',
      async leggiIntervallo(inizio: number, fine: number) {
        letture.push([inizio, fine])
        return new Uint8Array(fine - inizio).fill(7)
      },
    }
    const sorgente = await new LettoreBlob().openFile(ingresso)
    const fetta = await sorgente.slice(31, 34)
    expect(letture).toEqual([[31, 34]])
    expect(Array.from(fetta.value as unknown as Uint8Array)).toEqual([7, 7, 7])
    expect(fetta.value.size).toBe(3)
    expect(fetta.done).toBe(false)
  })
})
