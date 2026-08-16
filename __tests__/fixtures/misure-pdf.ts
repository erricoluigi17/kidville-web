/**
 * Misurare un PDF invece di guardarlo — gli strumenti, in un posto solo.
 *
 * Non si ispezionano i pixel: si legge ciò che il formato espone davvero. Per ogni pezzo
 * di testo la stringa, il punto d'inizio e il corpo; per ogni percorso disegnato (bande,
 * filetti, cornici) il suo riquadro d'ingombro; per ogni immagine disegnata dove finisce.
 * Con questi tre si prova la sola cosa che conta quando si stampa su carta intestata:
 * **che l'app non scriva dove la carta ha già il suo inchiostro.**
 *
 * Queste funzioni vivevano copiate dentro `prestampati-impaginazione.test.ts`, ed è lo
 * stesso difetto che il lavoro sulla carta è nato per togliere: cinque motori PDF con
 * cinque testate ricopiate. Cinque test che misurano gli stessi millimetri con cinque
 * copie degli stessi helper divergono con la stessa facilità — e un helper che sbaglia
 * rende VERDE un test che dovrebbe essere rosso.
 *
 * ⚠️ **L'altezza della pagina si legge dal PDF, non si passa come parametro.** Il registro
 * presenze è A4 ORIZZONTALE (297 × 210) e il resto è verticale (210 × 297): un `297`
 * cablato qui avrebbe ribaltato ogni quota del registro di 87 mm, cioè avrebbe misurato
 * benissimo un foglio che non esiste.
 */

const MM_PER_PUNTO = 25.4 / 72

/** Un rettangolo sul foglio: `yMm` è il bordo ALTO, contato dal bordo alto della pagina. */
export interface Ingombro {
  pagina: number
  xMm: number
  yMm: number
  larghezzaMm: number
  altezzaMm: number
}

export interface ElementoTesto {
  pagina: number
  testo: string
  xMm: number
  larghezzaMm: number
  /**
   * Millimetri dal bordo ALTO.
   *
   * ⚠️ È la LINEA DI SCRITTURA, non la cima delle lettere: chi la confronta con una
   * fascia vietata sta misurando dal posto sbagliato di due o tre millimetri. Il conto
   * giusto lo fa `ingombroTesto(yMm, corpoPt)` di `@/lib/carta/geometria`.
   */
  yMm: number
  /** Il corpo in punti: è ciò che serve per sapere quanto l'inchiostro sale e scende. */
  corpoPt: number
}

/** Le dimensioni di ogni pagina, in millimetri: `[larghezza, altezza]` per indice 1-based. */
async function misurePagine(doc: {
  numPages: number
  getPage(n: number): Promise<{ view: number[] }>
}): Promise<Map<number, { larghezza: number; altezza: number }>> {
  const misure = new Map<number, { larghezza: number; altezza: number }>()
  for (let p = 1; p <= doc.numPages; p++) {
    const view = (await doc.getPage(p)).view
    misure.set(p, {
      larghezza: (view[2] - view[0]) * MM_PER_PUNTO,
      altezza: (view[3] - view[1]) * MM_PER_PUNTO,
    })
  }
  return misure
}

/**
 * `slice()` difensivo su ogni ingresso: PDF.js **detacha** l'ArrayBuffer che riceve, e la
 * seconda misura sullo stesso `Uint8Array` leggerebbe zero byte senza dire niente
 * (stessa trappola documentata in `src/lib/protocolli/estrai.ts`).
 */
async function apri(pdf: Uint8Array) {
  const { getDocumentProxy } = await import('unpdf')
  return await getDocumentProxy(pdf.slice())
}

/** Ogni pezzo di testo del PDF con la sua posizione, pagina per pagina. */
export async function elementiTesto(pdf: Uint8Array): Promise<ElementoTesto[]> {
  const doc = await apri(pdf)
  const misure = await misurePagine(doc)
  const elementi: ElementoTesto[] = []
  for (let p = 1; p <= doc.numPages; p++) {
    const contenuto = await (await doc.getPage(p)).getTextContent()
    const altezza = misure.get(p)?.altezza ?? 0
    for (const item of contenuto.items as Array<{
      str?: string
      width?: number
      height?: number
      transform?: number[]
    }>) {
      if (typeof item.str !== 'string' || !item.str.trim()) continue
      const t = item.transform ?? [0, 0, 0, 0, 0, 0]
      elementi.push({
        pagina: p,
        testo: item.str,
        xMm: t[4] * MM_PER_PUNTO,
        larghezzaMm: (item.width ?? 0) * MM_PER_PUNTO,
        yMm: altezza - t[5] * MM_PER_PUNTO,
        // `height` di PDF.js è il corpo del carattere nello spazio del foglio: misurato
        // sul PDF vero, torna 7 sui 7 pt del piede e 16 sui 16 pt del titolo.
        corpoPt: item.height ?? 0,
      })
    }
  }
  return elementi
}

/**
 * L'ingombro di ogni percorso disegnato — bande, filetti, cornici, caselle.
 *
 * PDF.js consegna per ogni `constructPath` il riquadro di delimitazione già calcolato: è
 * il modo di misurare una CORNICE, che il testo estratto non racconta, ed è ciò che prova
 * che una banda verde a tutta pagina non c'è più.
 */
export async function ingombriPercorsi(pdf: Uint8Array): Promise<Ingombro[]> {
  const { getResolvedPDFJS } = await import('unpdf')
  const { OPS } = await getResolvedPDFJS()
  const doc = await apri(pdf)
  const misure = await misurePagine(doc)
  const ingombri: Ingombro[] = []
  for (let p = 1; p <= doc.numPages; p++) {
    const ops = await (await doc.getPage(p)).getOperatorList()
    const fnArray = ops.fnArray as number[]
    const argsArray = ops.argsArray as unknown[]
    const altezza = misure.get(p)?.altezza ?? 0
    for (let i = 0; i < fnArray.length; i++) {
      if (fnArray[i] !== OPS.constructPath) continue
      const limiti = (argsArray[i] as unknown[])[2] as ArrayLike<number> | undefined
      if (!limiti || limiti.length < 4) continue
      ingombri.push({
        pagina: p,
        xMm: limiti[0] * MM_PER_PUNTO,
        yMm: altezza - limiti[3] * MM_PER_PUNTO,
        larghezzaMm: (limiti[2] - limiti[0]) * MM_PER_PUNTO,
        altezzaMm: (limiti[3] - limiti[1]) * MM_PER_PUNTO,
      })
    }
  }
  return ingombri
}

/**
 * Dove finisce ogni immagine disegnata.
 *
 * Contare i DISEGNI, e non le risorse della pagina — jsPDF le tiene in un dizionario solo
 * e condiviso — è ciò che rende misurabile un «nessun logo»: il motore non ne disegna più
 * nessuno, perché il logo ce l'ha già la carta.
 */
export async function immaginiDisegnate(pdf: Uint8Array): Promise<Ingombro[]> {
  const { getResolvedPDFJS } = await import('unpdf')
  const { OPS } = await getResolvedPDFJS()
  const doc = await apri(pdf)
  const misure = await misurePagine(doc)
  const immagini: Ingombro[] = []
  for (let p = 1; p <= doc.numPages; p++) {
    const ops = await (await doc.getPage(p)).getOperatorList()
    const fnArray = ops.fnArray as number[]
    const argsArray = ops.argsArray as unknown[]
    const altezza = misure.get(p)?.altezza ?? 0
    for (let i = 0; i < fnArray.length; i++) {
      if (fnArray[i] !== OPS.paintImageXObject) continue
      // La posizione non sta negli argomenti del disegno ma nella matrice che lo precede.
      let matrice: number[] | null = null
      for (let j = i - 1; j >= 0 && j > i - 8; j--) {
        if (fnArray[j] === OPS.transform) {
          matrice = argsArray[j] as number[]
          break
        }
      }
      if (!matrice) continue
      const [larghezza, , , altezzaImm, x, yBasso] = matrice
      immagini.push({
        pagina: p,
        xMm: x * MM_PER_PUNTO,
        yMm: altezza - (yBasso + altezzaImm) * MM_PER_PUNTO,
        larghezzaMm: larghezza * MM_PER_PUNTO,
        altezzaMm: altezzaImm * MM_PER_PUNTO,
      })
    }
  }
  return immagini
}

/** Il numero di pagine, senza aprire due volte il documento nel test che chiama. */
export async function numeroPagine(pdf: Uint8Array): Promise<number> {
  return (await apri(pdf)).numPages
}

/** Le dimensioni di una pagina in millimetri (1-based). */
export async function dimensioniPagina(
  pdf: Uint8Array,
  pagina = 1
): Promise<{ larghezza: number; altezza: number }> {
  const doc = await apri(pdf)
  const view = (await doc.getPage(pagina)).view
  return {
    larghezza: (view[2] - view[0]) * MM_PER_PUNTO,
    altezza: (view[3] - view[1]) * MM_PER_PUNTO,
  }
}

/**
 * `true` se due rettangoli si toccano davvero (aree entrambe positive che si intersecano).
 *
 * Un filetto è alto zero: `sovrapposti` con `>` invece che `>=` lo escluderebbe sempre,
 * e un filetto stampato in mezzo al marchio della scuola è esattamente ciò che si cerca.
 * Perciò il confronto è **non stretto**, e chi vuole tolleranza la aggiunge al rettangolo.
 */
export function sovrapposti(a: Ingombro, b: { xMm: number; yMm: number; larghezzaMm: number; altezzaMm: number }): boolean {
  return (
    a.xMm <= b.xMm + b.larghezzaMm &&
    b.xMm <= a.xMm + a.larghezzaMm &&
    a.yMm <= b.yMm + b.altezzaMm &&
    b.yMm <= a.yMm + a.altezzaMm
  )
}
