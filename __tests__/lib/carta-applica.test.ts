// @vitest-environment node
/**
 * `applicaCartaIntestata` — la carta reale sotto, il contenuto sopra.
 *
 * L'ordine non è una preferenza estetica: jsPDF non disegna un fondo bianco, quindi una
 * carta stampata SOPRA il contenuto lo coprirebbe con la propria filigrana. È l'unico
 * difetto di questo modulo che non si vedrebbe in nessun conteggio — pagine giuste,
 * dimensione giusta, testo estraibile giusto — e si vedrebbe solo aprendo il foglio.
 * Perciò qui si misura la z: sulla pagina composta i tracciati della carta vengono PRIMA
 * del testo, e «prima» in un flusso di contenuto PDF vuol dire «sotto».
 *
 * Nessun dato reale: le pagine di prova portano la parola «pagina» e un numero.
 */
import { describe, it, expect } from 'vitest'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { applicaCartaIntestata } from '@/lib/carta/applica'

const A4: [number, number] = [595.276, 841.89]

/** Pagine con SOLO testo e nessun tracciato: è ciò che rende misurabile l'ordine. */
async function pdfDiProva(pagine: number, formato: [number, number] = A4): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (let i = 0; i < pagine; i++) {
    const p = doc.addPage(formato)
    p.drawText(`pagina ${i + 1}`, { x: 62, y: 700, size: 12, font, color: rgb(0.18, 0.18, 0.18) })
  }
  return doc.save()
}

interface OperazioniPagina {
  /** Indice della prima costruzione di tracciato: la carta è vettoriale pura. */
  primoTracciato: number
  /** Indice della prima emissione di testo: il contenuto di prova è solo testo. */
  primoTesto: number
  tracciati: number
}

/**
 * Che cosa disegna ogni pagina, e in che ordine. PDF.js espande i form XObject dentro la
 * lista di operatori mantenendone la sequenza: è esattamente la pila di disegno.
 */
async function operazioni(pdf: Uint8Array): Promise<OperazioniPagina[]> {
  const { getDocumentProxy, getResolvedPDFJS } = await import('unpdf')
  const { OPS } = await getResolvedPDFJS()
  // `slice()` difensivo: PDF.js detacha l'ArrayBuffer che riceve.
  const doc = await getDocumentProxy(pdf.slice())
  const pagine: OperazioniPagina[] = []
  for (let p = 1; p <= doc.numPages; p++) {
    const lista = await (await doc.getPage(p)).getOperatorList()
    const fn = lista.fnArray as number[]
    let primoTracciato = -1
    let primoTesto = -1
    let tracciati = 0
    for (let i = 0; i < fn.length; i++) {
      if (fn[i] === OPS.constructPath) {
        tracciati++
        if (primoTracciato < 0) primoTracciato = i
      }
      const testo = fn[i] === OPS.showText || fn[i] === OPS.showSpacedText
      if (testo && primoTesto < 0) primoTesto = i
    }
    pagine.push({ primoTracciato, primoTesto, tracciati })
  }
  return pagine
}

describe('applicaCartaIntestata', () => {
  it('mette la carta su OGNI pagina, non solo sulla prima', async () => {
    const out = await applicaCartaIntestata(await pdfDiProva(3))
    const doc = await PDFDocument.load(out)
    expect(doc.getPageCount()).toBe(3)

    // Una pagina di prova non disegna nemmeno un tracciato: quelli che si contano qui
    // vengono tutti dalla carta. Zero su una pagina = quella pagina è rimasta nuda.
    const pagine = await operazioni(out)
    expect(pagine).toHaveLength(3)
    for (const pagina of pagine) expect(pagina.tracciati).toBeGreaterThan(50)
  })

  it('la carta sta SOTTO il contenuto, su ogni pagina', async () => {
    // Il difetto che questo test esiste per impedire: la carta sopra, che copre il testo
    // con la propria filigrana. Conteggi e dimensioni resterebbero identici.
    const pagine = await operazioni(await applicaCartaIntestata(await pdfDiProva(3)))
    for (const pagina of pagine) {
      expect(pagina.primoTracciato).toBeGreaterThanOrEqual(0)
      expect(pagina.primoTesto).toBeGreaterThan(pagina.primoTracciato)
    }
  })

  it('non altera il numero di pagine né il formato', async () => {
    const doc = await PDFDocument.load(await applicaCartaIntestata(await pdfDiProva(2)))
    expect(doc.getPageCount()).toBe(2)
    const { width, height } = doc.getPage(1).getSize()
    expect(width).toBeCloseTo(595.276, 2)
    expect(height).toBeCloseTo(841.89, 2)
  })

  it('non perde il contenuto che c’era', async () => {
    const { estraiTesto } = await import('@/lib/protocolli/estrai')
    const testo = await estraiTesto(await applicaCartaIntestata(await pdfDiProva(3)))
    expect(testo).toContain('pagina 1')
    expect(testo).toContain('pagina 3')
  })

  it('incorpora la carta una volta sola anche su 5 pagine', async () => {
    // È la differenza fra 1,1 MB a documento e 1,1 MB a PAGINA: un registro presenze di
    // dodici pagine peserebbe 13 MB invece di 1,1.
    //
    // Misurato il 2026-08-15: 1 pagina 1,066 MB · 2 pagine 1,067 · 5 pagine 1,069 ·
    // 12 pagine 1,074. Il costo di una pagina in più è ~0,7 KB, non 1,1 MB. La soglia
    // qui sotto è larga di proposito — non misura il peso, misura che non si moltiplichi.
    const una = (await applicaCartaIntestata(await pdfDiProva(1))).byteLength
    const cinque = (await applicaCartaIntestata(await pdfDiProva(5))).byteLength
    expect(cinque).toBeLessThan(una * 2)
  })

  it('non lancia su un PDF senza pagine e non rompe il chiamante', async () => {
    // Un `PDFDocument.create()` salvato senza aggiungere pagine si rilegge come UNA
    // pagina priva di flusso di contenuto, e pdf-lib si rifiuta di incorporarla. Il foglio
    // bianco esce comunque, e con la carta della scuola sopra: farlo sparire — o far
    // fallire l'intero documento — sarebbe peggio di stamparlo vuoto.
    const doc = await PDFDocument.create()
    const out = await applicaCartaIntestata(await doc.save())
    expect(out).toBeInstanceOf(Uint8Array)

    const pagine = await operazioni(out)
    expect(pagine).toHaveLength(1)
    expect(pagine[0].tracciati).toBeGreaterThan(50)
    expect(pagine[0].primoTesto).toBe(-1)
  })

  it('non si mangia le pagine di formato diverso: le impagina lo stesso', async () => {
    // Il registro presenze è in orizzontale. Che la carta ci stia stretta è un problema di
    // resa, non un motivo per far sparire un foglio.
    const orizzontale: [number, number] = [841.89, 595.276]
    const doc = await PDFDocument.load(await applicaCartaIntestata(await pdfDiProva(1, orizzontale)))
    expect(doc.getPageCount()).toBe(1)
    const { width, height } = doc.getPage(0).getSize()
    expect(width).toBeCloseTo(841.89, 2)
    expect(height).toBeCloseTo(595.276, 2)
  })
})
