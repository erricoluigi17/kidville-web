import { describe, expect, it } from 'vitest'
import { Blob as NodeBlob } from 'node:buffer'
import { LettoreBlob } from '@/lib/media/video/upload/lettore-blob'
import { ErroreByteVideo, LETTURA_VIDEO_MASSIMA, leggiBloccoBlob } from '@/lib/media/video/upload/byte-video'
import { DIMENSIONE_BLOCCO_TUS_BYTE } from '@/lib/media/video/contratto'

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

  // È la forma che tus usa davvero per l'ultimo blocco: `fine` esattamente uguale
  // alla dimensione. Un `>` al posto di `>=` lascerebbe tus in attesa di un blocco
  // che non esiste.
  it('segna la fine anche quando l’intervallo chiesto termina esattamente sulla dimensione', async () => {
    const originale = new NodeBlob([new Uint8Array([1, 2, 3, 4, 5])]) as unknown as Blob
    const sorgente = await new LettoreBlob().openFile(originale)
    expect((await sorgente.slice(0, 4)).done).toBe(false)
    const ultima = await sorgente.slice(4, 5)
    expect(Array.from(ultima.value as unknown as Uint8Array)).toEqual([5])
    expect(ultima.done).toBe(true)
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

  it('una lettura più corta dell’intervallo è un blocco incompleto, e chi carica lo sa prima di tus', async () => {
    const errori: unknown[] = []
    const ingresso = {
      size: 10,
      type: 'video/mp4',
      async leggiIntervallo() {
        return new Uint8Array(2)
      },
    }
    const sorgente = await new LettoreBlob((err) => errori.push(err)).openFile(ingresso)
    await expect(sorgente.slice(0, 5)).rejects.toMatchObject({ name: 'VIDEO_BLOCCO_INCOMPLETO' })
    expect(errori).toHaveLength(1)
    expect(errori[0]).toBeInstanceOf(ErroreByteVideo)
  })

  // Il tetto di una lettura non deve mai scendere sotto il blocco TUS: se lo
  // facesse, ogni PATCH chiederebbe un intervallo «non valido» e nessun video
  // ripreso dal deposito partirebbe più — con tutti i test in memoria verdi.
  it('il tetto di una lettura resta sopra il blocco TUS del contratto', () => {
    expect(LETTURA_VIDEO_MASSIMA).toBeGreaterThanOrEqual(DIMENSIONE_BLOCCO_TUS_BYTE)
  })
})

describe('leggiBloccoBlob', () => {
  it('usa FileReader nelle WebView che non espongono Blob.arrayBuffer', async () => {
    const blob = new Blob([new Uint8Array([9, 8, 7])])
    Object.defineProperty(blob, 'arrayBuffer', { value: undefined })
    const buffer = await leggiBloccoBlob(blob)
    expect(Array.from(new Uint8Array(buffer))).toEqual([9, 8, 7])
  })
})
