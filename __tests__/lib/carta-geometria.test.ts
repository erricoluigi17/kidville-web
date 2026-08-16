// @vitest-environment node
/**
 * Le misure della carta intestata, in un posto solo — e verificate SULL'ASSET.
 *
 * ⚠️ Fino al 2026-08-16 questo file diceva «rilievo a 150 dpi sul rendering del PDF reale»
 * e poi si limitava a ripetere i numeri: `toBeCloseTo(26,8)` passa perché `geometria.ts`
 * scrive 26,8, non perché il marchio finisca lì. Era un test che confermava una copia, non
 * una misura — e la copia era **sbagliata di 0,23 mm**: l'inchiostro del marchio arriva a
 * 27,026 mm, cioè oltre il limite che il lock dichiarava sicuro.
 *
 * Ora i due numeri che contano si misurano dai TRACCIATI VETTORIALI dell'asset, che sono
 * il marchio: se qualcuno cambia la carta, o «arrotonda» una quota, il test lo dice.
 * L'ingombro esatto delle curve di Bézier coincide con il riquadro che PDF.js consegna
 * (verificato calcolando gli estremi analitici delle cubiche: 27,026 in entrambi i modi),
 * quindi qui si legge quello.
 */
import { describe, it, expect } from 'vitest'
import {
  CARTA,
  fasceVietate,
  ingombroTesto,
  stesuraCarta,
  type Rettangolo,
} from '@/lib/carta/geometria'
import { cartaIntestataBytes } from '@/lib/carta/asset'

const MM_PER_PUNTO = 25.4 / 72

/** Un pezzo d'inchiostro sull'asset: millimetri dal bordo alto-sinistro del foglio. */
interface Inchiostro {
  alto: number
  basso: number
  sinistra: number
  destra: number
}

/** `A × B` fra due matrici PDF: `cm` pre-concatena, quindi vanno composte tutte. */
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

/**
 * Ogni tracciato stampato sulla carta, con il suo ingombro sul foglio.
 *
 * La carta è vettoriale pura — zero elementi di testo estraibile, misurato — quindi il
 * marchio E il piede a quattro colonne sono percorsi, e questa è l'unica lettura possibile
 * della loro posizione vera. La matrice corrente si accumula davvero (`q`/`Q`/`cm`): senza,
 * i percorsi con coordinate negative finirebbero fuori foglio.
 */
async function inchiostroDellaCarta(): Promise<Inchiostro[]> {
  const { getDocumentProxy, getResolvedPDFJS } = await import('unpdf')
  const { OPS } = await getResolvedPDFJS()
  // `slice()` difensivo: PDF.js detacha l'ArrayBuffer che riceve.
  const doc = await getDocumentProxy(cartaIntestataBytes().slice())
  const pagina = await doc.getPage(1)
  const altezza = pagina.getViewport({ scale: 1 }).height
  const lista = await pagina.getOperatorList()
  const fn = lista.fnArray as number[]
  const args = lista.argsArray as unknown[]

  const pezzi: Inchiostro[] = []
  const pila: number[][] = []
  let corrente = IDENTITA

  for (let i = 0; i < fn.length; i++) {
    if (fn[i] === OPS.save) {
      pila.push(corrente)
      continue
    }
    if (fn[i] === OPS.restore) {
      corrente = pila.pop() ?? IDENTITA
      continue
    }
    if (fn[i] === OPS.transform) {
      corrente = per(args[i] as number[], corrente)
      continue
    }
    if (fn[i] !== OPS.constructPath) continue
    const limiti = (args[i] as unknown[])[2] as ArrayLike<number> | undefined
    if (!limiti || limiti.length < 4) continue
    const [a, b, c, d, e, f] = corrente
    const angoli = [
      [limiti[0], limiti[1]],
      [limiti[2], limiti[1]],
      [limiti[0], limiti[3]],
      [limiti[2], limiti[3]],
    ].map(([x, y]) => [a * x + c * y + e, b * x + d * y + f])
    const xs = angoli.map((p) => p[0] * MM_PER_PUNTO)
    const ys = angoli.map((p) => (altezza - p[1]) * MM_PER_PUNTO)
    pezzi.push({
      alto: Math.min(...ys),
      basso: Math.max(...ys),
      sinistra: Math.min(...xs),
      destra: Math.max(...xs),
    })
  }
  return pezzi
}

const cima = (p: Inchiostro[]) => Math.min(...p.map((i) => i.alto))
const fondo = (p: Inchiostro[]) => Math.max(...p.map((i) => i.basso))

describe('geometria della carta intestata — misurata sull’asset', () => {
  it('il foglio della carta è l’A4 che `CARTA` dichiara', async () => {
    // Tutto il resto — la stesura, le fasce vietate, la rotazione sull'orizzontale — è
    // calcolato da questi due numeri. Se l'asset non fosse più A4 sarebbero tutti falsi,
    // e lo sarebbero in silenzio.
    const { getDocumentProxy } = await import('unpdf')
    const doc = await getDocumentProxy(cartaIntestataBytes().slice())
    const { width, height } = (await doc.getPage(1)).getViewport({ scale: 1 })
    expect(width * MM_PER_PUNTO).toBeCloseTo(CARTA.larghezzaPagina, 2)
    expect(height * MM_PER_PUNTO).toBeCloseTo(CARTA.altezzaPagina, 2)
  })

  it('la fascia del marchio contiene l’inchiostro vero, e non un millimetro di più', async () => {
    const testa = (await inchiostroDellaCarta()).filter((i) => i.basso < 60)
    // Il marchio «Kidville» più la riga «NIDO · INFANZIA / PRIMARIA · CAMPO ESTIVO»: 41
    // tracciati, misurati. Se ne restassero due, il resto del test non proverebbe niente.
    expect(testa.length).toBeGreaterThan(30)

    expect(cima(testa), 'il marchio comincia più in alto di quanto CARTA dichiari').toBeGreaterThanOrEqual(
      CARTA.brandInizio
    )
    expect(fondo(testa), 'il marchio finisce PIÙ IN BASSO della fascia dichiarata').toBeLessThanOrEqual(
      CARTA.brandFine
    )
    // E la fascia non si «allarga per far passare il test»: dichiararla larga il doppio la
    // renderebbe vera e inutile, perché ruberebbe millimetri al contenuto.
    expect(CARTA.brandFine - fondo(testa)).toBeLessThan(0.5)
  })

  it('la fascia del piede stampato contiene l’inchiostro vero, e non un millimetro di più', async () => {
    const coda = (await inchiostroDellaCarta()).filter((i) => i.alto > 250)
    expect(coda.length).toBeGreaterThan(100)
    expect(cima(coda)).toBeGreaterThanOrEqual(CARTA.piedeInizio)
    expect(fondo(coda)).toBeLessThanOrEqual(CARTA.piedeFine)
    expect(CARTA.piedeFine - fondo(coda)).toBeLessThan(0.5)
  })
})

describe('geometria della carta intestata', () => {
  it('conosce dove sta il marchio e dove sta il piede', () => {
    expect(CARTA.brandInizio).toBeCloseTo(12.5, 1)
    expect(CARTA.brandFine).toBeCloseTo(27.05, 1)
    expect(CARTA.piedeInizio).toBeCloseTo(272.1, 1)
    expect(CARTA.piedeFine).toBeCloseTo(285.1, 1)
  })

  it("l'area libera non tocca né il marchio né il piede", () => {
    expect(CARTA.contenutoInizio).toBeGreaterThan(CARTA.brandFine)
    expect(CARTA.contenutoFine).toBeLessThan(CARTA.piedeInizio)
  })

  it('lascia almeno 5 mm di aria sopra il piede stampato', () => {
    expect(CARTA.piedeInizio - CARTA.contenutoFine).toBeGreaterThanOrEqual(5)
  })

  it('lascia aria anche fra il fondo del contenuto e le LETTERE della riga di servizio', () => {
    // ⚠️ Il difetto che questo test esiste per impedire, misurato il 2026-08-15 su pagina 2
    // di un certificato reale: il riquadro di verifica chiudeva a 266,00 mm e le maiuscole
    // di «Pagina 2 di 2» cominciavano a 266,73 — **0,73 mm**, cioè si toccavano a occhio.
    //
    // La causa non era un errore di calcolo: `contenutoFine` valeva 266 e la testata di
    // `geometria.ts` prometteva che i millimetri fra lui e il piede stampato bastassero
    // «perché dentro ci sta rigaServizio». Non bastavano: `rigaServizio` è la LINEA DI
    // SCRITTURA, e l'inchiostro le sta sopra. Quanto sopra non si tira a indovinare — la
    // prima versione di questo test scriveva `7 * 0,716` e il commento accanto diceva
    // «≈ 2,47 mm», che è il doppio del valore che quella riga calcola: lo dice
    // `ingombroTesto`, che tiene le metriche del carattere in un posto solo.
    const riga = ingombroTesto(CARTA.rigaServizio, 7)
    expect(riga.cima - CARTA.contenutoFine).toBeGreaterThanOrEqual(2)
    // E l'inchiostro della riga di servizio non entra nel piede stampato della carta.
    expect(riga.fondo).toBeLessThan(CARTA.piedeInizio)
  })

  it('la riga di servizio sta fra il contenuto e il piede della carta, non dentro nessuno dei due', () => {
    // Il piede dell'app — «Riservato — dati di minori · data · nome» e «Pagina n di m» —
    // stava a y=287, cioè DENTRO il piede a quattro colonne della carta (272,1→285,1).
    expect(CARTA.rigaServizio).toBeGreaterThan(CARTA.contenutoFine)
    expect(CARTA.rigaServizio).toBeLessThan(CARTA.piedeInizio)
  })

  it('riserva alla segnatura di protocollo l’aria fra il marchio e il contenuto', () => {
    // La segnatura NON è una fascia in testa al foglio: quella cadrebbe sopra il marchio
    // della scuola, che è il difetto n. 1 della specifica. Sta nell'aria che
    // `contenutoInizio` già lascia sotto il logo — 27,05 → 40 — e nessun motore ci scrive
    // dentro, perché `contenutoInizio` è per definizione dove l'app comincia.
    expect(CARTA.segnaturaRiga).toBeGreaterThan(CARTA.brandFine)
    expect(CARTA.segnaturaRiga).toBeLessThan(CARTA.contenutoInizio)
    // E si misura l'INCHIOSTRO della segnatura, non la sua linea di scrittura: in 8 pt le
    // maiuscole salgono 2,6 mm, che è esattamente lo spessore che il conto a occhio perde.
    expect(ingombroTesto(CARTA.segnaturaRiga, 8).cima).toBeGreaterThan(CARTA.brandFine)
  })

  it('i margini laterali stanno qui, e non in una seconda copia dentro ogni motore', () => {
    expect(CARTA.margineSx).toBeGreaterThan(0)
    expect(CARTA.margineDx).toBeLessThan(CARTA.larghezzaPagina)
    expect(CARTA.margineDx - CARTA.margineSx).toBe(166)
  })

  it('resta un foglio A4, e le misure stanno tutte dentro', () => {
    expect(CARTA.altezzaPagina).toBe(297)
    expect(CARTA.larghezzaPagina).toBe(210)
    expect(CARTA.piedeFine).toBeLessThan(CARTA.altezzaPagina)
    expect(CARTA.brandInizio).toBeGreaterThan(0)
  })
})

describe('ingombroTesto — l’inchiostro, non la linea di scrittura', () => {
  it('sale sopra la baseline e scende sotto, in proporzione al corpo', () => {
    const dodici = ingombroTesto(100, 12)
    expect(dodici.cima).toBeLessThan(100)
    expect(dodici.fondo).toBeGreaterThan(100)
    // Il doppio del corpo, il doppio dell'ingombro: è una proporzione, non una tabella.
    const ventiquattro = ingombroTesto(100, 24)
    expect(100 - ventiquattro.cima).toBeCloseTo(2 * (100 - dodici.cima), 6)
  })

  it('copre il glifo PIÙ ALTO del carattere, non la sola altezza delle maiuscole', () => {
    // Helvetica, `FontBBox [-166 -225 1000 931]`: la «È» maiuscola accentata arriva a
    // 0,931 em, cioè ben oltre `CapHeight` 0,718. Un limite tarato sulle maiuscole normali
    // lascerebbe fuori proprio le parole gridate in italiano — «È RISERVATO», «DELEGA» —
    // che sono quelle che i moduli mettono in cima alla pagina.
    const CORPO = 12
    const salita = 12 - ingombroTesto(12, CORPO).cima
    // L'ultima cifra del `double` non è una misura: 3,941233333333333 e
    // 3,9412333333333334 sono lo stesso millimetro, e un `>=` secco qui misurerebbe
    // l'ordine delle moltiplicazioni invece dell'ingombro.
    expect(salita).toBeGreaterThanOrEqual(0.931 * CORPO * MM_PER_PUNTO - 1e-9)
    expect(salita).toBeLessThan(1.05 * CORPO * MM_PER_PUNTO)
  })

  it('non lascia scoperte le discendenti: «g», «p», «(» scendono sotto la riga', () => {
    const CORPO = 10
    const discesa = ingombroTesto(50, CORPO).fondo - 50
    expect(discesa).toBeGreaterThanOrEqual(0.225 * CORPO * MM_PER_PUNTO)
  })
})

/**
 * DOVE CADE LA CARTA SU UN FOGLIO CHE NON È IL SUO — e dove cadono, di conseguenza, le
 * due fasce che l'app non può toccare.
 *
 * Questo blocco è la riparazione di un difetto vero: fino al 2026-08-16 il motore girava la
 * carta di 90° sull'A4 orizzontale, e **nessuno poteva sapere dove finivano il marchio e il
 * piede**. Il registro presenze — che è orizzontale — ci sarebbe finito sopra: la «R» di
 * «REGISTRO PRESENZE» cadeva esattamente sulle lettere di «PRIMARIA ·». I tre test
 * sull'orizzontale misuravano soltanto che la carta non si deformasse.
 */
describe('stesuraCarta — dove finisce la carta sul foglio', () => {
  it('sull’A4 verticale sta 1:1, senza scala e senza giro', () => {
    const s = stesuraCarta(CARTA.larghezzaPagina, CARTA.altezzaPagina)
    expect(s.scala).toBeCloseTo(1, 9)
    expect(s.giro).toBe(0)
    expect(s.copertura).toBeCloseTo(1, 9)
    expect(s.riquadro).toEqual({ sinistra: 0, alto: 0, larghezza: 210, altezza: 297 })
  })

  it('sull’A4 orizzontale si gira di 90° e copre il foglio intero', () => {
    // La scelta è dichiarata, non implicita: girare copre 297×210 senza una fascia bianca,
    // «contain» coprirebbe il 50% del foglio e lascerebbe 74 mm di bianco per lato.
    const s = stesuraCarta(297, 210)
    expect(s.giro).toBe(90)
    expect(s.scala).toBeCloseTo(1, 9)
    expect(s.copertura).toBeCloseTo(1, 9)
  })

  it('su un formato che non è A4 sta intera e centrata, mai deformata', () => {
    const s = stesuraCarta(150, 400)
    expect(s.giro).toBe(0)
    expect(s.scala).toBeCloseTo(150 / 210, 9)
    expect(s.riquadro.sinistra).toBeCloseTo(0, 9)
    expect(s.riquadro.alto).toBeCloseTo((400 - (150 / 210) * 297) / 2, 9)
    expect(s.copertura).toBeLessThan(1)
  })

  it('non esplode su un foglio degenere', () => {
    expect(stesuraCarta(0, 100).copertura).toBe(0)
    expect(stesuraCarta(100, -1).scala).toBe(0)
  })
})

/** Un rettangolo non ne tocca un altro: nessuna sovrapposizione, nemmeno di un bordo. */
function separati(a: Rettangolo, b: Rettangolo): boolean {
  return (
    a.sinistra + a.larghezza <= b.sinistra ||
    b.sinistra + b.larghezza <= a.sinistra ||
    a.alto + a.altezza <= b.alto ||
    b.alto + b.altezza <= a.alto
  )
}

describe('fasceVietate — le due fasce della carta, sul foglio davvero stampato', () => {
  it('sull’A4 verticale sono quelle che `CARTA` dichiara', () => {
    const { marchio, piede } = fasceVietate(CARTA.larghezzaPagina, CARTA.altezzaPagina)
    expect(marchio.alto).toBeCloseTo(CARTA.brandInizio, 6)
    expect(marchio.alto + marchio.altezza).toBeCloseTo(CARTA.brandFine, 6)
    expect(marchio.sinistra).toBeCloseTo(0, 6)
    expect(marchio.larghezza).toBeCloseTo(CARTA.larghezzaPagina, 6)
    expect(piede.alto).toBeCloseTo(CARTA.piedeInizio, 6)
    expect(piede.alto + piede.altezza).toBeCloseTo(CARTA.piedeFine, 6)
  })

  it('sull’A4 orizzontale diventano due strisce VERTICALI: marchio a sinistra, piede a destra', () => {
    // È la conseguenza del giro di 90°, ed è la cosa che il motore non diceva: su un foglio
    // orizzontale il marchio NON è una fascia in cima, è una colonna sul bordo sinistro. Un
    // contenuto che si tiene lontano dal bordo alto ci finisce dentro lo stesso.
    const { marchio, piede } = fasceVietate(297, 210)
    expect(marchio.sinistra).toBeCloseTo(CARTA.brandInizio, 6)
    expect(marchio.sinistra + marchio.larghezza).toBeCloseTo(CARTA.brandFine, 6)
    expect(marchio.alto).toBeCloseTo(0, 6)
    expect(marchio.altezza).toBeCloseTo(210, 6)

    expect(piede.sinistra).toBeCloseTo(CARTA.piedeInizio, 6)
    expect(piede.sinistra + piede.larghezza).toBeCloseTo(CARTA.piedeFine, 6)
    // Cioè: 11,9 mm dal bordo DESTRO del foglio.
    expect(297 - (piede.sinistra + piede.larghezza)).toBeCloseTo(297 - CARTA.piedeFine, 6)
  })

  it('le due fasce non si toccano mai fra loro, comunque sia fatto il foglio', () => {
    for (const [l, a] of [
      [210, 297],
      [297, 210],
      [150, 400],
      [500, 500],
    ]) {
      const { marchio, piede } = fasceVietate(l, a)
      expect(separati(marchio, piede), `foglio ${l}×${a}`).toBe(true)
    }
  })

  it('sull’orizzontale resta una striscia utile larga almeno 240 mm — ed è il motivo del giro', () => {
    // Il registro presenze mensile ha 31 colonne più il nome e i tre totali: oggi le
    // impagina in 281 mm (`MonthlyAttendanceTable.tsx`). Fra le due fasce ne restano 245:
    // le colonne si stringono a 5,9 mm e ci stanno. Con la carta stesa «contain» invece di
    // girata, la striscia bianca lascerebbe 148,5 mm di carta intestata e il registro
    // finirebbe per metà FUORI dal foglio della scuola.
    const { marchio, piede } = fasceVietate(297, 210)
    const utile = piede.sinistra - (marchio.sinistra + marchio.larghezza)
    expect(utile).toBeGreaterThanOrEqual(240)
  })

  it('su un foglio degenere non inventa fasce che non esistono', () => {
    const { marchio } = fasceVietate(0, 0)
    expect(marchio.larghezza).toBe(0)
    expect(marchio.altezza).toBe(0)
  })
})
