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
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { applicaCartaIntestata } from '@/lib/carta/applica'
import { CARTA } from '@/lib/carta/geometria'

const A4: [number, number] = [595.276, 841.89]
const MM_PER_PUNTO = 25.4 / 72

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

/** Un disegno fatto DALL'APP sulla pagina finita, fuori da ogni form incorporato. */
interface DisegnoDellApp {
  /** Millimetri dal bordo ALTO del foglio: il bordo più alto dell'ingombro. */
  yMm: number
  altezzaMm: number
}

/** Come la carta e il contenuto vengono stesi sul foglio: scala e traslazione. */
interface StesuraForm {
  scalaX: number
  scalaY: number
  spostamentoX: number
  spostamentoY: number
}

interface ComposizionePagina {
  /** Percorsi e immagini disegnati SOPRA i form, cioè dall'app e non dalla carta. */
  disegniDellApp: DisegnoDellApp[]
  /** Un elemento per ogni form steso sulla pagina: la carta, il contenuto. */
  forme: StesuraForm[]
}

/**
 * Che cosa finisce sul foglio, e come.
 *
 * La distinzione fra «l'ha disegnato l'app» e «ce l'aveva la carta» è tutta nella
 * PROFONDITÀ: PDF.js espande i form XObject fra `paintFormXObjectBegin` e `…End`, quindi
 * i millecento tracciati vettoriali della carta stanno a profondità 1. Ciò che resta a
 * profondità 0 l'ha disegnato chi ha composto il foglio — ed è l'unica cosa che può
 * finire SOPRA il marchio della scuola.
 */
async function composizione(pdf: Uint8Array, pagina = 1): Promise<ComposizionePagina> {
  const { getDocumentProxy, getResolvedPDFJS } = await import('unpdf')
  const { OPS } = await getResolvedPDFJS()
  const doc = await getDocumentProxy(pdf.slice())
  const p = await doc.getPage(pagina)
  const altezzaFoglio = p.getViewport({ scale: 1 }).height
  const lista = await p.getOperatorList()
  const fn = lista.fnArray as number[]
  const args = lista.argsArray as unknown[]

  const disegniDellApp: DisegnoDellApp[] = []
  const forme: StesuraForm[] = []
  let profondita = 0
  // La matrice corrente a profondità 0: pdf-lib emette `cm` subito prima di `Do`.
  let corrente: number[] = [1, 0, 0, 1, 0, 0]

  for (let i = 0; i < fn.length; i++) {
    if (fn[i] === OPS.paintFormXObjectEnd) {
      profondita--
      continue
    }
    if (profondita > 0) {
      if (fn[i] === OPS.paintFormXObjectBegin) profondita++
      continue
    }
    if (fn[i] === OPS.transform) {
      const m = args[i] as number[]
      // Solo le matrici che dicono qualcosa: le identità che pdf-lib intercala no.
      if (m[0] !== 1 || m[3] !== 1 || m[4] !== 0 || m[5] !== 0) corrente = m
      continue
    }
    if (fn[i] === OPS.paintFormXObjectBegin) {
      forme.push({
        scalaX: corrente[0],
        scalaY: corrente[3],
        spostamentoX: corrente[4],
        spostamentoY: corrente[5],
      })
      corrente = [1, 0, 0, 1, 0, 0]
      profondita++
      continue
    }
    if (fn[i] === OPS.constructPath) {
      const limiti = (args[i] as unknown[])[2] as ArrayLike<number> | undefined
      if (!limiti || limiti.length < 4) continue
      // Il riquadro d'ingombro arriva nello spazio del tracciato: la `cm` che lo precede
      // lo sposta sul foglio, ed è proprio quella che porta la fascia in testa alla pagina.
      const basso = limiti[1] + corrente[5]
      const alto = limiti[3] + corrente[5]
      disegniDellApp.push({
        yMm: (altezzaFoglio - alto) * MM_PER_PUNTO,
        altezzaMm: (alto - basso) * MM_PER_PUNTO,
      })
      corrente = [1, 0, 0, 1, 0, 0]
      continue
    }
    if (fn[i] === OPS.paintImageXObject) {
      const [larghezza, , , altezza, , yBasso] = corrente
      disegniDellApp.push({
        yMm: (altezzaFoglio - (yBasso + altezza)) * MM_PER_PUNTO,
        altezzaMm: Math.abs(altezza) * MM_PER_PUNTO,
      })
      void larghezza
      corrente = [1, 0, 0, 1, 0, 0]
    }
  }
  return { disegniDellApp, forme }
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

  it('la carta non viene mai riscalata: sta sul foglio 1:1', async () => {
    // La prova che la segnatura a fascia NON è passata di qui. `applicaSegnatura()`
    // rimpicciolisce la pagina di 777,89/841,89 = 0,924 e la ricentra per far posto alla
    // banda verde: su un foglio bianco è una scelta gentile — non copre niente — ma sulla
    // carta della scuola stacca il piede a quattro colonne dal fondo del foglio e apre due
    // margini bianchi ai lati. Una carta intestata riscalata non è più carta intestata.
    const { forme } = await composizione(await applicaCartaIntestata(await pdfDiProva(2)))
    expect(forme.length).toBeGreaterThanOrEqual(2)
    for (const forma of forme) {
      expect(forma.scalaX).toBeCloseTo(1, 6)
      expect(forma.scalaY).toBeCloseTo(1, 6)
      expect(forma.spostamentoX).toBeCloseTo(0, 6)
      expect(forma.spostamentoY).toBeCloseTo(0, 6)
    }
  })

  it('non disegna niente sopra il marchio della scuola', async () => {
    const { disegniDellApp } = await composizione(await applicaCartaIntestata(await pdfDiProva(1)))
    for (const disegno of disegniDellApp) {
      expect(disegno.yMm + disegno.altezzaMm).toBeGreaterThan(CARTA.brandFine)
    }
  })
})

describe('applicaCartaIntestata — la segnatura di protocollo', () => {
  const RIGHE = ['SCUOLA DI PROVA SOC. COOP.', 'Prot. n. 0000123/2026 · Uscita', 'del 15/08/2026 ore 10:24']

  it('stampa la segnatura senza fascia, senza logo e senza riscalare la carta', async () => {
    // ⚠️ QUESTO TEST È IL DIFETTO N. 1 E N. 2 DELLA SPECIFICA, messo a lock.
    //
    // La segnatura del registro protocolli (`applicaSegnatura()`) nasce per i documenti
    // ACQUISITI — una scansione, una foto — che arrivano su un foglio bianco: lì la banda
    // verde alta 64 pt col logo bianco è la segnatura, e riscalare la pagina è il modo di
    // non coprire niente. Sulla carta intestata quella stessa banda cade ESATTAMENTE sul
    // marchio della scuola (0 → 26,8 mm) e ne stampa un secondo sopra il primo.
    //
    // Perciò la segnatura sulla carta la mette questo modulo, e la mette dove la carta ha
    // lasciato l'aria per farlo.
    const out = await applicaCartaIntestata(await pdfDiProva(2), { segnatura: { righe: RIGHE } })

    const { disegniDellApp, forme } = await composizione(out)
    for (const forma of forme) {
      expect(forma.scalaX, 'la carta è stata riscalata').toBeCloseTo(1, 6)
      expect(forma.spostamentoX, 'la carta è stata ricentrata').toBeCloseTo(0, 6)
    }
    for (const disegno of disegniDellApp) {
      expect(
        disegno.yMm + disegno.altezzaMm,
        `disegno dell'app fino a y=${(disegno.yMm + disegno.altezzaMm).toFixed(1)} mm`
      ).toBeGreaterThan(CARTA.brandFine)
    }
  })

  it('la segnatura si legge, e sta nell’aria fra il marchio e il contenuto', async () => {
    const { getDocumentProxy } = await import('unpdf')
    const out = await applicaCartaIntestata(await pdfDiProva(1), { segnatura: { righe: RIGHE } })
    const doc = await getDocumentProxy(out.slice())
    const contenuto = await (await doc.getPage(1)).getTextContent()
    const items = contenuto.items as Array<{ str?: string; transform?: number[] }>

    const segnatura = items.find((i) => i.str?.includes('0000123/2026'))
    expect(segnatura, 'la segnatura non è finita sul foglio').toBeDefined()
    expect(segnatura!.str).toContain('SCUOLA DI PROVA SOC. COOP.')
    expect(segnatura!.str).toContain('15/08/2026')

    const yMm = (841.89 - segnatura!.transform![5]) * MM_PER_PUNTO
    expect(yMm).toBeGreaterThan(CARTA.brandFine)
    expect(yMm).toBeLessThan(CARTA.contenutoInizio)
  })

  it('la segnatura sta sulla PRIMA pagina soltanto, come il timbro di protocollo', async () => {
    const { estraiTesto } = await import('@/lib/protocolli/estrai')
    const out = await applicaCartaIntestata(await pdfDiProva(3), { segnatura: { righe: RIGHE } })
    const testo = await estraiTesto(out)
    expect(testo.split('0000123/2026')).toHaveLength(2)
    expect(await PDFDocument.load(out).then((d) => d.getPageCount())).toBe(3)
  })

  it('un carattere che il font non sa scrivere non fa saltare il certificato', async () => {
    // Helvetica standard scrive WinAnsi e basta: `drawText` LANCIA su un carattere fuori
    // tabella. Un nome di sede con un ideogramma farebbe rispondere 500 a una route che
    // stava solo stampando un numero di protocollo — e il numero, a quel punto, è già
    // stato consumato dal registro.
    const out = await applicaCartaIntestata(await pdfDiProva(1), {
      segnatura: { righe: ['SCUOLA 東京 DI PROVA', 'Prot. n. 0000124/2026', 'del 15/08/2026'] },
    })
    expect(out).toBeInstanceOf(Uint8Array)
    const { estraiTesto } = await import('@/lib/protocolli/estrai')
    expect(await estraiTesto(out)).toContain('0000124/2026')
  })

  it('senza segnatura il foglio resta com’era: nessun testo aggiunto', async () => {
    const { estraiTesto } = await import('@/lib/protocolli/estrai')
    expect(await estraiTesto(await applicaCartaIntestata(await pdfDiProva(1)))).toBe(
      await estraiTesto(await applicaCartaIntestata(await pdfDiProva(1), { segnatura: null }))
    )
  })
})

/**
 * Il lock che rende il contratto ESEGUIBILE invece che raccomandato.
 *
 * La prima versione di questo modulo diceva ai chiamanti «a valle passa
 * `applicaSegnatura()`, come già oggi». Non era vero: quella funzione ridipinge la fascia
 * verde sopra il marchio, ne aggiunge un secondo logo e riscala la carta — cioè ricrea i
 * due difetti per cui questo lavoro è nato. Una frase in un commento non l'avrebbe mai
 * impedito; questo test sì.
 */
describe('nessun modulo compone la carta e poi la segnatura a fascia', () => {
  function sorgenti(cartella: string, raccolti: string[] = []): string[] {
    for (const voce of readdirSync(cartella, { withFileTypes: true })) {
      const completo = path.join(cartella, voce.name)
      if (voce.isDirectory()) sorgenti(completo, raccolti)
      else if (/\.tsx?$/.test(voce.name)) raccolti.push(completo)
    }
    return raccolti
  }

  /**
   * I nomi presi in prestito da un `import`, e non le occorrenze nel testo: i due
   * compaiono nei commenti dei moduli che spiegano perché non vanno insieme, e un lock
   * che inciampa sulla propria spiegazione viene disattivato entro la settimana.
   */
  function nomiImportati(sorgente: string): Set<string> {
    const nomi = new Set<string>()
    for (const [, clausola] of sorgente.matchAll(
      /^[ \t]*import\s+([^;]*?)\s+from\s+['"][^'"]+['"]/gm
    )) {
      for (const nome of clausola.replace(/[{}]/g, ' ').split(/[\s,]+/)) {
        if (nome) nomi.add(nome)
      }
    }
    return nomi
  }

  it('chi applica la carta usa l’opzione `segnatura`, non `applicaSegnatura`', () => {
    const radice = path.join(process.cwd(), 'src')
    const colpevoli = sorgenti(radice).filter((file) => {
      const nomi = nomiImportati(readFileSync(file, 'utf8'))
      return nomi.has('applicaCartaIntestata') && nomi.has('applicaSegnatura')
    })
    expect(
      colpevoli.map((f) => path.relative(radice, f)),
      'la segnatura sulla carta intestata si passa a applicaCartaIntestata({ segnatura }): ' +
        'applicaSegnatura() è il timbro dei documenti ACQUISITI, su foglio bianco'
    ).toEqual([])
  })
})

describe('applicaCartaIntestata — formati', () => {
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
