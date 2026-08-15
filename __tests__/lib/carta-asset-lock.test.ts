// @vitest-environment node
/**
 * Lock sull'asset della carta intestata.
 *
 * Il PDF è la carta intestata reale della scuola, fornita dal titolare il 2026-08-15.
 * NON si ricomprime, non si ottimizza, non si ritaglia: una ricompressione lossless
 * ridurrebbe il peso senza cambiare l'aspetto, ma cambierebbe i byte — e la carta di una
 * scuola non è un asset da «migliorare» senza che nessuno se ne accorga. Il SHA-256 qui
 * sotto è ciò che rende visibile un'ottimizzazione ben intenzionata.
 */
import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { cartaIntestataBytes } from '@/lib/carta/asset'

const SHA256_ATTESO = '6946d21216594797b8b8e6feb3c582a64caae3baa9adbdf76aa2590b19b8cceb'

describe('asset della carta intestata', () => {
  it('è il file esatto fornito dalla scuola, byte per byte', () => {
    const bytes = cartaIntestataBytes()
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(SHA256_ATTESO)
    expect(bytes.byteLength).toBe(1_097_589)
  })

  it('è un PDF di una pagina sola, A4 esatto', async () => {
    const { PDFDocument } = await import('pdf-lib')
    const doc = await PDFDocument.load(cartaIntestataBytes())
    expect(doc.getPageCount()).toBe(1)
    const { width, height } = doc.getPage(0).getSize()
    expect(width).toBeCloseTo(595.276, 2)
    expect(height).toBeCloseTo(841.89, 2)
  })

  it('si carica una volta sola', () => {
    // Memoizzato: 1,1 MB riletti a ogni certificato sarebbero 1,1 MB di lettura per
    // ciascuno dei diciassette prestampati, per ogni famiglia che ne scarica uno.
    expect(cartaIntestataBytes()).toBe(cartaIntestataBytes())
  })
})
