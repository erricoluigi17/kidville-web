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
  /** La matrice per intero: con una rotazione la scala non sta più in `a` e `d`. */
  matrice: number[]
}

/**
 * Quanto una matrice DEFORMA ciò che trasporta, misurato sui due assi del form.
 *
 * Una matrice `[a b c d]` porta il vettore orizzontale in `(a,b)` e quello verticale in
 * `(c,d)`. La forma è conservata quando i due restano perpendicolari e della stessa
 * lunghezza: allora è una rotazione con una scala uniforme, e il logotipo «Kidville»
 * resta il logotipo «Kidville». Se le lunghezze divergono, le lettere si allargano su un
 * asse e si schiacciano sull'altro — che è il difetto misurato sull'A4 orizzontale, dove
 * la carta veniva stirata di 1,414× in larghezza e compressa di 0,707× in altezza.
 */
function deformazione(m: number[]): { anisotropia: number; nonOrtogonale: number } {
  const [a, b, c, d] = m
  const lungoX = Math.hypot(a, b)
  const lungoY = Math.hypot(c, d)
  return {
    anisotropia: Math.abs(lungoX - lungoY),
    nonOrtogonale: Math.abs(a * c + b * d),
  }
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
/**
 * `A × B` fra due matrici PDF, nella convenzione a vettore-riga del formato.
 *
 * Serve perché `cm` **pre-concatena**: pdf-lib emette traslazione, rotazione e scala come
 * tre operatori distinti, e leggere solo l'ultimo — come faceva questo file finché la
 * carta non veniva mai girata — restituisce la sola scala. Con una rotazione in mezzo
 * quella lettura direbbe che il foglio non è ruotato, cioè misurerebbe l'esatto contrario.
 */
function per(a: number[], b: number[]): number[] {
  return [
    a[0] * b[0] + a[1] * b[2],
    a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2],
    a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4],
    a[4] * b[1] + a[5] * b[3] + b[5],
  ]
}

const IDENTITA = [1, 0, 0, 1, 0, 0]

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
  // La matrice corrente a profondità 0, ACCUMULATA: pdf-lib emette fino a tre `cm`
  // consecutivi prima di `Do` (traslazione, rotazione, scala) e vanno composti tutti.
  let corrente: number[] = IDENTITA

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
      corrente = per(args[i] as number[], corrente)
      continue
    }
    if (fn[i] === OPS.paintFormXObjectBegin) {
      forme.push({
        scalaX: corrente[0],
        scalaY: corrente[3],
        spostamentoX: corrente[4],
        spostamentoY: corrente[5],
        matrice: corrente,
      })
      corrente = IDENTITA
      profondita++
      continue
    }
    if (fn[i] === OPS.constructPath) {
      const limiti = (args[i] as unknown[])[2] as ArrayLike<number> | undefined
      if (!limiti || limiti.length < 4) continue
      // Il riquadro d'ingombro arriva nello spazio del tracciato: la `cm` che lo precede
      // lo sposta sul foglio, ed è proprio quella che porta la fascia in testa alla pagina.
      // I quattro angoli si mappano tutti, non solo la quota: con una matrice ruotata
      // sommare `f` a `y` darebbe un ingombro che sul foglio non esiste.
      const [a, b, c, d, , f] = corrente
      const quote = [
        [limiti[0], limiti[1]],
        [limiti[2], limiti[1]],
        [limiti[0], limiti[3]],
        [limiti[2], limiti[3]],
      ].map(([x, y]) => b * x + d * y + f)
      void a
      void c
      const basso = Math.min(...quote)
      const alto = Math.max(...quote)
      disegniDellApp.push({
        yMm: (altezzaFoglio - alto) * MM_PER_PUNTO,
        altezzaMm: (alto - basso) * MM_PER_PUNTO,
      })
      corrente = IDENTITA
      continue
    }
    if (fn[i] === OPS.paintImageXObject) {
      const [larghezza, , , altezza, , yBasso] = corrente
      disegniDellApp.push({
        yMm: (altezzaFoglio - (yBasso + altezza)) * MM_PER_PUNTO,
        altezzaMm: Math.abs(altezza) * MM_PER_PUNTO,
      })
      void larghezza
      corrente = IDENTITA
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
 * IL LOCK CHE SORVEGLIA IL RISCHIO VERO — e la versione che non lo sorvegliava.
 *
 * ⚠️ Fino al 2026-08-15 questo blocco conteneva un test **vacuo**: pretendeva che nessun
 * file importasse insieme `applicaCartaIntestata` e `applicaSegnatura`. Siccome
 * `applicaCartaIntestata` non era importata da NESSUN file di `src/`, il primo congiunto
 * era falso ovunque e il test passava a vuoto su tutto il repository — mentre il
 * certificato vero usciva senza carta intestata. Misurava la composizione sbagliata, non
 * l'assenza della carta.
 *
 * Il predicato qui sotto è **invertito**: non «chi la applica non faccia altro», ma
 * **«chi consegna un prestampato DEVE applicarla»**. Ed è verificabile: le rotte sono il
 * confine oltre il quale i byte diventano un foglio in mano a una famiglia o a un ente.
 */
describe('ogni rotta che consegna un prestampato stende la carta intestata', () => {
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

  /** Le porte da cui esce un PDF di prestampato: chi importa una di queste, consegna. */
  const PORTE_DEL_MOTORE = [
    'buildPrestampatoPdf',
    'componiPrestampato',
    'renderPrestampatoGenitore',
    'renderPrestampatoSegreteria',
  ]

  /**
   * Le ROTTE che consegnano un prestampato, dedotte invece che elencate.
   *
   * Un elenco scritto a mano invecchia al primo file nuovo, e invecchia in silenzio: chi
   * aggiunge una rotta non va a cercare un test per aggiungercela. Qui l'insieme si
   * ricava dagli import, quindi una rotta nuova entra nel lock da sola.
   *
   * Solo i `route.ts`: `banco.ts` e `render.ts` **passano** i byte a qualcun altro, e
   * `applicaCartaIntestata` va chiamata UNA volta sola — la seconda incollerebbe una
   * seconda carta sopra il contenuto.
   */
  function rotteCheConsegnano(): { file: string; nomi: Set<string> }[] {
    const radice = path.join(process.cwd(), 'src')
    return sorgenti(radice)
      .filter((file) => /[\\/]route\.tsx?$/.test(file))
      .map((file) => ({ file: path.relative(radice, file), nomi: nomiImportati(readFileSync(file, 'utf8')) }))
      .filter(({ nomi }) => PORTE_DEL_MOTORE.some((porta) => nomi.has(porta)))
  }

  it('esistono davvero delle rotte che consegnano prestampati (o questo lock è vacuo)', () => {
    // La riga che impedisce a questo blocco di tornare a passare per assenza di soggetti,
    // che è esattamente il modo in cui la versione precedente diceva il falso.
    expect(rotteCheConsegnano().map((r) => r.file).sort()).not.toEqual([])
  })

  it('nessuna rotta consegna un prestampato senza `applicaCartaIntestata`', () => {
    const nude = rotteCheConsegnano()
      .filter(({ nomi }) => !nomi.has('applicaCartaIntestata'))
      .map((r) => r.file)
    expect(
      nude,
      'queste rotte consegnano un prestampato NUDO: senza il marchio della scuola, senza ' +
        'la riga «NIDO · INFANZIA / PRIMARIA · CAMPO ESTIVO», senza filigrana e senza il ' +
        'piede a quattro colonne con la P.IVA e le tre sedi. Il motore non disegna più la ' +
        'testata (impaginazione.ts): se nessuno stende la carta al suo posto, il foglio ' +
        'esce PEGGIO di prima. Si ripara con applicaCartaIntestata(pdf, { segnatura })'
    ).toEqual([])
  })

  it('e nessuna la timbra con la fascia dei documenti acquisiti', () => {
    // `applicaSegnatura()` dipinge una fascia verde alta 64 pt in testa alla prima pagina,
    // ci mette dentro un SECONDO logo Kidville e riscala il foglio di 777,89/841,89 =
    // 0,924 ricentrandolo. Su una scansione arrivata su foglio bianco è la scelta giusta:
    // non copre niente. Sulla carta intestata cade ESATTAMENTE sul marchio della scuola
    // (0 → 26,8 mm) — cioè ricrea i difetti n. 1 e n. 2 della specifica.
    const timbrate = rotteCheConsegnano()
      .filter(({ nomi }) => nomi.has('applicaSegnatura'))
      .map((r) => r.file)
    expect(
      timbrate,
      'la segnatura su carta intestata si passa a applicaCartaIntestata({ segnatura }): ' +
        'applicaSegnatura() è il timbro dei documenti ACQUISITI, su foglio bianco'
    ).toEqual([])
  })
})

describe('applicaCartaIntestata — formati', () => {
  const ORIZZONTALE: [number, number] = [841.89, 595.276]

  it('non si mangia le pagine di formato diverso: le impagina lo stesso', async () => {
    // Il registro presenze è in orizzontale.
    const doc = await PDFDocument.load(await applicaCartaIntestata(await pdfDiProva(1, ORIZZONTALE)))
    expect(doc.getPageCount()).toBe(1)
    const { width, height } = doc.getPage(0).getSize()
    expect(width).toBeCloseTo(841.89, 2)
    expect(height).toBeCloseTo(595.276, 2)
  })

  it('sulla pagina orizzontale il marchio della scuola NON si deforma', async () => {
    // ⚠️ Il difetto che questo test esiste per impedire, reso e guardato il 2026-08-15: su
    // A4 orizzontale la carta veniva stesa `drawPage(carta, {width: 841,89, height:
    // 595,276})`, cioè allargata di 1,414× e schiacciata di 0,707×. Il logotipo «Kidville»
    // diventava grasso e piatto, la riga «NIDO · INFANZIA / PRIMARIA · CAMPO ESTIVO» si
    // comprimeva e il piede a quattro colonne arrivava al limite della leggibilità.
    //
    // Non era un caso di scuola: la spec §1.5 manda il REGISTRO PRESENZE — che è in
    // orizzontale — dentro questo stesso motore. Il modulo se ne accorgeva da sé e
    // consegnava lo stesso, con un `warn` che nessuno avrebbe letto prima della segretaria
    // che stampa. **Il marchio di una scuola non si stira, mai.**
    const { forme } = await composizione(await applicaCartaIntestata(await pdfDiProva(1, ORIZZONTALE)))
    expect(forme.length).toBeGreaterThanOrEqual(1)

    const carta = deformazione(forme[0].matrice)
    expect(carta.anisotropia, 'la carta è stirata su un asse').toBeLessThan(1e-6)
    expect(carta.nonOrtogonale, 'la carta è stata inclinata').toBeLessThan(1e-6)
  })

  it("sull'A4 orizzontale la carta si gira invece di rimpicciolirsi: copre il foglio intero", async () => {
    // La carta è un foglio FISICO, e il foglio fisico è A4 verticale: un contenuto
    // orizzontale ci si stampa sopra di traverso. Perciò la scelta giusta non è
    // rimpicciolire la carta al 70,7% lasciando due fasce bianche ai lati, è girarla di
    // 90°: l'asset è vettoriale, la rotazione non costa un byte, e sul foglio stampato il
    // marchio torna in testa.
    const { forme } = await composizione(await applicaCartaIntestata(await pdfDiProva(1, ORIZZONTALE)))
    const [a, b, c, d] = forme[0].matrice
    // Scala 1 su entrambi gli assi: la carta copre l'A4 girato senza margini bianchi.
    expect(Math.hypot(a, b)).toBeCloseTo(1, 6)
    expect(Math.hypot(c, d)).toBeCloseTo(1, 6)
    // Ed è davvero girata: l'asse orizzontale del form non è più orizzontale.
    expect(Math.abs(a)).toBeLessThan(1e-6)
  })

  it('su un formato che non è A4 la carta resta intera e centrata, mai deformata', async () => {
    // Formato inventato e sgraziato di proposito: qui nessuna rotazione fa combaciare i
    // bordi, quindi la carta si stende «contain» e resta dell'aria. Ciò che NON può
    // succedere è che si deformi per riempire.
    const strano: [number, number] = [500, 700]
    const { forme } = await composizione(await applicaCartaIntestata(await pdfDiProva(1, strano)))
    const carta = deformazione(forme[0].matrice)
    expect(carta.anisotropia).toBeLessThan(1e-6)
    expect(carta.nonOrtogonale).toBeLessThan(1e-6)

    // «Contain» vuol dire che ci sta tutta: la scala è quella del lato più stretto.
    const scala = Math.hypot(forme[0].matrice[0], forme[0].matrice[1])
    expect(scala).toBeCloseTo(Math.min(500 / 595.276, 700 / 841.89), 6)
  })
})
