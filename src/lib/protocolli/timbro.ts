/**
 * Timbro di segnatura (decisione #9 dello spec): fascia brand in testa alla
 * prima pagina. La pagina originale viene incorporata (embedPdf) e riscalata
 * per lasciare spazio alla fascia: NIENTE del documento viene mai coperto.
 * Le pagine successive sono copiate identiche. Conversione immagini → PDF A4
 * (decisione #7) senza dipendenze native. Testato in
 * __tests__/lib/protocolli-timbro.test.ts.
 */

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'

const VERDE_KIDVILLE = rgb(0 / 255, 106 / 255, 95 / 255) // #006A5F
const GIALLO_KIDVILLE = rgb(253 / 255, 196 / 255, 0) // #FDC400
const BIANCO = rgb(1, 1, 1)

/** Altezza della fascia di segnatura, in punti PDF. */
const FASCIA_ALTEZZA = 64

/**
 * Applica la fascia di segnatura sulla prima pagina.
 * `righe` sono le tre righe prodotte da `righeSegnatura()`.
 */
export async function applicaSegnatura(
  pdfBytes: Uint8Array,
  opts: { righe: string[]; logoPng?: Uint8Array }
): Promise<Uint8Array> {
  const sorgente = await PDFDocument.load(pdfBytes)
  const out = await PDFDocument.create()

  const totalePagine = sorgente.getPageCount()
  const prima = sorgente.getPage(0)
  const { width, height } = prima.getSize()

  // Pagina 1: originale incorporata e riscalata in basso, fascia in alto.
  const [incorporata] = await out.embedPdf(sorgente, [0])
  const pagina = out.addPage([width, height])
  const altezzaContenuto = height - FASCIA_ALTEZZA
  const scala = altezzaContenuto / height
  const larghezzaContenuto = width * scala
  pagina.drawPage(incorporata, {
    x: (width - larghezzaContenuto) / 2,
    y: 0,
    width: larghezzaContenuto,
    height: altezzaContenuto,
  })

  pagina.drawRectangle({
    x: 0,
    y: height - FASCIA_ALTEZZA,
    width,
    height: FASCIA_ALTEZZA,
    color: VERDE_KIDVILLE,
  })
  pagina.drawRectangle({
    x: 0,
    y: height - FASCIA_ALTEZZA - 2,
    width,
    height: 2,
    color: GIALLO_KIDVILLE,
  })

  const grassetto = await out.embedFont(StandardFonts.HelveticaBold)
  const normale = await out.embedFont(StandardFonts.Helvetica)

  let testoX = 14
  if (opts.logoPng) {
    const logo = await out.embedPng(opts.logoPng)
    const logoAltezza = 26
    const logoLarghezza = (logo.width / logo.height) * logoAltezza
    pagina.drawImage(logo, {
      x: 14,
      y: height - FASCIA_ALTEZZA + (FASCIA_ALTEZZA - logoAltezza) / 2,
      width: logoLarghezza,
      height: logoAltezza,
    })
    testoX = 14 + logoLarghezza + 12
  }

  const [rigaEnte = '', rigaNumero = '', rigaData = ''] = opts.righe
  pagina.drawText(rigaEnte, {
    x: testoX,
    y: height - 21,
    size: 10,
    font: grassetto,
    color: GIALLO_KIDVILLE,
  })
  pagina.drawText(rigaNumero, {
    x: testoX,
    y: height - 38,
    size: 12.5,
    font: grassetto,
    color: BIANCO,
  })
  pagina.drawText(rigaData, {
    x: testoX,
    y: height - 54,
    size: 9.5,
    font: normale,
    color: BIANCO,
  })

  // Pagine successive: copiate identiche.
  if (totalePagine > 1) {
    const indici = Array.from({ length: totalePagine - 1 }, (_, i) => i + 1)
    const resto = await out.copyPages(sorgente, indici)
    for (const p of resto) out.addPage(p)
  }

  return out.save()
}

const A4: [number, number] = [595.28, 841.89]

/** Avvolge una foto/scansione JPG o PNG in un PDF A4 centrato (mai upscaling). */
export async function immagineInPdf(
  bytes: Uint8Array,
  mime: 'image/png' | 'image/jpeg'
): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const immagine = mime === 'image/png' ? await doc.embedPng(bytes) : await doc.embedJpg(bytes)
  const pagina = doc.addPage(A4)
  const margine = 24
  const scala = Math.min(
    (A4[0] - margine * 2) / immagine.width,
    (A4[1] - margine * 2) / immagine.height,
    1
  )
  const larghezza = immagine.width * scala
  const altezza = immagine.height * scala
  pagina.drawImage(immagine, {
    x: (A4[0] - larghezza) / 2,
    y: (A4[1] - altezza) / 2,
    width: larghezza,
    height: altezza,
  })
  return doc.save()
}
