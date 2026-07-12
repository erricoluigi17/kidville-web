// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { applicaSegnatura, immagineInPdf } from '@/lib/protocolli/timbro'
import { estraiTesto } from '@/lib/protocolli/estrai'
import { righeSegnatura } from '@/lib/protocolli/segnatura'

/** PNG 1×1 (usato sia come "logo" sia come "scansione" di prova). */
const PNG_1x1 = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  ),
  (c) => c.charCodeAt(0)
)

const A4: [number, number] = [595.28, 841.89]

async function pdfDiProva(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const p1 = doc.addPage(A4)
  p1.drawText('Contenuto pagina uno', { x: 50, y: 700, size: 14, font })
  const p2 = doc.addPage(A4)
  p2.drawText('Seconda pagina', { x: 50, y: 700, size: 14, font })
  return doc.save()
}

const RIGHE = righeSegnatura({
  denominazione: 'Kidville Giugliano',
  numero: 42,
  anno: 2026,
  tipo: 'ingresso',
  quando: new Date('2026-07-12T07:41:00Z'),
})

describe('applicaSegnatura (fascia in testa alla 1ª pagina, decisione #9)', () => {
  it('aggiunge la segnatura senza perdere pagine, misure né contenuto', async () => {
    const originale = await pdfDiProva()
    const timbrato = await applicaSegnatura(originale, { righe: RIGHE, logoPng: PNG_1x1 })

    const doc = await PDFDocument.load(timbrato)
    expect(doc.getPageCount()).toBe(2)
    const { width, height } = doc.getPage(0).getSize()
    expect(width).toBeCloseTo(A4[0], 0)
    expect(height).toBeCloseTo(A4[1], 0)

    const testo = await estraiTesto(timbrato)
    expect(testo).toContain('KIDVILLE GIUGLIANO')
    expect(testo).toContain('Prot. n. 0000042/2026')
    expect(testo).toContain('del 12/07/2026 ore 09:41')
    expect(testo).toContain('Contenuto pagina uno')
    expect(testo).toContain('Seconda pagina')
  })

  it('funziona anche senza logo', async () => {
    const timbrato = await applicaSegnatura(await pdfDiProva(), { righe: RIGHE })
    expect((await estraiTesto(timbrato)).includes('Prot. n. 0000042/2026')).toBe(true)
  })
})

describe('immagineInPdf (decisione #7: JPG/PNG convertite e poi timbrate)', () => {
  it('avvolge una PNG in un PDF A4 a pagina singola con l\'immagine incorporata', async () => {
    const pdf = await immagineInPdf(PNG_1x1, 'image/png')
    const doc = await PDFDocument.load(pdf)
    expect(doc.getPageCount()).toBe(1)
    const { width, height } = doc.getPage(0).getSize()
    expect(width).toBeCloseTo(A4[0], 0)
    expect(height).toBeCloseTo(A4[1], 0)
    // l'immagine deve esserci davvero (XObject /Image nel PDF), non una pagina vuota
    expect(Buffer.from(pdf).toString('latin1')).toContain('/Subtype /Image')
  })

  it('il PDF convertito è a sua volta timbrabile', async () => {
    const pdf = await immagineInPdf(PNG_1x1, 'image/png')
    const timbrato = await applicaSegnatura(pdf, { righe: RIGHE })
    expect((await estraiTesto(timbrato)).includes('KIDVILLE GIUGLIANO')).toBe(true)
  })
})
