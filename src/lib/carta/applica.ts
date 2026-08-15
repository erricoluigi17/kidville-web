/**
 * La carta intestata reale sotto ogni pagina prodotta dall'app.
 *
 * ─── L'ORDINE È IL CUORE DI QUESTO MODULO ──────────────────────────────────────
 *
 * La carta è la BASE, il contenuto ci si posa SOPRA. Non è una preferenza di resa: jsPDF
 * non disegna un fondo bianco, quindi una carta stampata *sopra* il contenuto lo
 * coprirebbe con la propria filigrana — e sarebbe un difetto invisibile a ogni conteggio
 * (pagine giuste, dimensione giusta, testo estraibile giusto), visibile solo aprendo il
 * foglio. Il lock che lo misura è in `__tests__/lib/carta-applica.test.ts`.
 *
 * ─── UNA VOLTA SOLA, NON UNA VOLTA PER PAGINA ──────────────────────────────────
 *
 * `embedPdf()` incorpora la carta **una volta sola per documento**: tutte le pagine
 * riusano lo stesso form XObject. È la differenza fra 1,1 MB a documento e 1,1 MB a
 * pagina — un registro presenze di dodici pagine peserebbe 13 MB invece di 1,2.
 *
 * Il costo di ~1,1 MB a documento è il prezzo dichiarato e accettato della fedeltà 1:1
 * alla carta della scuola (spec §1.4).
 *
 * ─── PERCHÉ UN ERRORE QUI NON DEGRADA IN SILENZIO ──────────────────────────────
 *
 * Se la carta non si applica, la funzione **lancia** invece di restituire il documento
 * nudo. Sembra la scelta scortese, ed è quella giusta: a valle il chiamante protocolla e
 * archivia in un registro WORM: un certificato senza carta intestata, con il suo numero
 * di protocollo bruciato, resterebbe lì per sempre. Meglio un 500 che il genitore vede
 * subito — e ritenta — che un documento sbagliato e definitivo diretto all'INPS.
 *
 * ─── E LA SEGNATURA DI PROTOCOLLO PASSA DA QUI, NON DA `applicaSegnatura()` ────
 *
 * Questa riga, fino al 2026-08-15, diceva: *«a valle passa `applicaSegnatura()` di
 * `src/lib/protocolli/timbro.ts`, come già oggi»*. **Era falsa, ed era il difetto.**
 * Misurato componendo davvero i due passaggi: `applicaSegnatura()` dipinge una fascia
 * verde alta 64 pt in testa alla prima pagina — cioè sopra il marchio della scuola, che
 * finisce a 26,8 mm — ci mette dentro un SECONDO logo Kidville sopra il primo, e riscala
 * la carta di 777,89/841,89 = 0,924 ricentrandola, così il piede a quattro colonne non sta
 * più al fondo del foglio e compaiono due margini bianchi ai lati. Sono, alla lettera, i
 * difetti n. 1 e n. 2 della specifica: quelli per cui questo modulo esiste.
 *
 * Non è un errore di `applicaSegnatura()`: quella funzione nasce per i documenti
 * **acquisiti** — una scansione, una foto — che arrivano su un foglio bianco, dove la
 * fascia non copre niente e riscalare è il modo di non nascondere una riga. Su una carta
 * intestata la segnatura è un'altra cosa, e la fa `applicaCartaIntestata(pdf, { segnatura })`:
 * una riga in 8 pt nell'aria che la carta lascia sotto il marchio (`CARTA.segnaturaRiga`),
 * senza fascia, senza logo e senza toccare la scala del foglio.
 *
 * Il lock che lo tiene è in `__tests__/lib/carta-applica.test.ts`, e vale la pena dire come
 * NON funziona: la sua prima versione vietava a un file di importare insieme
 * `applicaCartaIntestata` e `applicaSegnatura`, e passava a vuoto su tutto il repository
 * perché nessun file importava la prima delle due. Sorvegliava la composizione sbagliata
 * invece dell'assenza della carta. Ora il predicato è invertito: **ogni `route.ts` che
 * compone un prestampato deve importare `applicaCartaIntestata`**, e nessuna può importare
 * `applicaSegnatura`.
 */

import {
  PDFDocument,
  StandardFonts,
  degrees,
  rgb,
  type PDFEmbeddedPage,
  type PDFFont,
  type PDFPage,
} from 'pdf-lib'
import { logEvento } from '@/lib/logging/logger'
import { cartaIntestataBytes } from './asset'
import { CARTA } from './geometria'

/**
 * Sotto questa frazione di foglio coperto, la carta lascia fasce bianche visibili: il
 * formato non è un A4 né un A4 girato, e chi stampa se ne accorgerà. Non è un motivo per
 * far sparire un foglio — è un motivo per lasciare una riga di log.
 */
const COPERTURA_MINIMA = 0.98

const PUNTI_PER_MM = 72 / 25.4
/** Il grigio-inchiostro del prodotto, #2D2D2D: la segnatura si legge, non grida. */
const INCHIOSTRO = rgb(45 / 255, 45 / 255, 45 / 255)
const CORPO_SEGNATURA = 8
/** Sotto questo corpo la segnatura non si legge più: meglio accorciarla che rimpicciolirla. */
const CORPO_SEGNATURA_MINIMO = 6

/**
 * La segnatura di protocollo da apporre sul foglio.
 *
 * `righe` sono le stesse tre che produce `righeSegnatura()` di
 * `src/lib/protocolli/segnatura.ts` — ente, numero e tipo, data e ora. Qui si stampano su
 * una riga sola, unite da ` · `: l'aria sotto il marchio è alta 13,2 mm e tre righe ci
 * starebbero solo a filo, cioè finché nessuno tocca `contenutoInizio`.
 */
export interface SegnaturaCarta {
  righe: readonly string[]
}

export interface OpzioniCarta {
  /** Assente o `null`: il foglio esce senza segnatura, che è il caso di ogni anteprima. */
  segnatura?: SegnaturaCarta | null
}

/**
 * Il testo che il font sa davvero scrivere.
 *
 * Helvetica standard codifica WinAnsi e nient'altro: su un carattere fuori tabella
 * `drawText` **lancia**. Non è un caso di scuola con conseguenze piccole — quando si
 * arriva qui il numero di protocollo è già stato consumato dal registro, quindi
 * un'eccezione lascerebbe un buco nella numerazione per un ideogramma nel nome di una
 * sede. Si ripiega su una versione senza i caratteri che il font non conosce, e lo si
 * dice: una segnatura mutilata va vista, non subita.
 */
function testoSegnatura(font: PDFFont, riga: string): string {
  try {
    font.encodeText(riga)
    return riga
  } catch (errore) {
    logEvento(
      'modulistica',
      'warn',
      { operazione: 'carta/segnatura', esito: 'ripiego-ascii', n: riga.length },
      errore
    )
  }

  const ripiego = riga
    .normalize('NFKD')
    .replace(/[^ -~]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
  if (!ripiego) {
    logEvento('modulistica', 'error', {
      operazione: 'carta/segnatura',
      esito: 'non-stampabile',
      n: riga.length,
    })
    return ''
  }

  try {
    font.encodeText(ripiego)
    return ripiego
  } catch (errore) {
    logEvento(
      'modulistica',
      'error',
      { operazione: 'carta/segnatura', esito: 'non-stampabile', n: riga.length },
      errore
    )
    return ''
  }
}

/**
 * Stampa la segnatura sulla prima pagina, allineata a destra come un timbro.
 *
 * Niente fascia, niente logo, niente riscalatura: il foglio resta quello che era e la
 * segnatura si posa nell'unico spazio che la carta tiene libero per essa.
 */
async function stampaSegnatura(
  documento: PDFDocument,
  pagina: PDFPage,
  segnatura: SegnaturaCarta
): Promise<void> {
  const riga = segnatura.righe
    .map((r) => (r ?? '').trim())
    .filter((r) => r.length > 0)
    .join(' · ')
  if (!riga) {
    // Una segnatura vuota non è un foglio senza protocollo: è un chiamante che credeva di
    // averne uno. Senza questa riga il documento uscirebbe non protocollato in silenzio.
    logEvento('modulistica', 'warn', { operazione: 'carta/segnatura', esito: 'righe-vuote' })
    return
  }

  const font = await documento.embedFont(StandardFonts.Helvetica)
  let testo = testoSegnatura(font, riga)
  if (!testo) return

  const larghezzaUtile = (CARTA.margineDx - CARTA.margineSx) * PUNTI_PER_MM
  let corpo = CORPO_SEGNATURA
  while (corpo > CORPO_SEGNATURA_MINIMO && font.widthOfTextAtSize(testo, corpo) > larghezzaUtile) {
    corpo -= 0.5
  }
  // Ultima risorsa: una segnatura lunghissima si accorcia invece di uscire dal margine.
  // Sul foglio deve restare il NUMERO, che è la prima cosa che qualcuno andrà a cercare.
  while (testo.length > 12 && font.widthOfTextAtSize(testo, corpo) > larghezzaUtile) {
    testo = `${testo.slice(0, -4).trimEnd()}...`
  }

  pagina.drawText(testo, {
    x: CARTA.margineDx * PUNTI_PER_MM - font.widthOfTextAtSize(testo, corpo),
    y: pagina.getSize().height - CARTA.segnaturaRiga * PUNTI_PER_MM,
    size: corpo,
    font,
    color: INCHIOSTRO,
  })
}

/**
 * Come stendere la carta su UNA pagina, senza mai deformarla.
 *
 * ⚠️ **IL MARCHIO DI UNA SCUOLA NON SI STIRA, MAI.** Fino al 2026-08-15 questa funzione
 * diceva `drawPage(carta, { width: larghezza, height: altezza })`, cioè «riempi il
 * foglio»: su A4 verticale era esatto per coincidenza — le proporzioni combaciano — e su
 * A4 **orizzontale** allargava la carta di 1,414× e la schiacciava di 0,707×. Reso e
 * guardato: il logotipo «Kidville» con le lettere grasse e piatte, la riga «NIDO ·
 * INFANZIA / PRIMARIA · CAMPO ESTIVO» compressa, il piede a quattro colonne al limite
 * della leggibilità. E non era un caso di scuola: il REGISTRO PRESENZE è in orizzontale e
 * passa da qui (spec §1.5).
 *
 * Due regole, in quest'ordine:
 *
 *  1. **la scala è uniforme** — mai due fattori diversi sui due assi;
 *  2. **fra dritta e girata di 90° vince quella che copre di più**. La carta è un foglio
 *     FISICO, e il foglio fisico è A4 verticale: un contenuto orizzontale ci si stampa
 *     sopra di traverso, quindi girare la carta è ciò che rimette il marchio in testa al
 *     foglio stampato. L'asset è vettoriale: la rotazione non costa un byte né un pixel.
 *
 * Il VERSO della rotazione è +90° (antiorario nelle coordinate PDF), e non è indifferente:
 * porta il bordo alto della carta sul bordo SINISTRO della pagina. Chi stampa un foglio
 * orizzontale su carta A4 lo gira in senso orario per leggerlo — è il gesto naturale, ed è
 * anche ciò che fa l'auto-rotazione delle stampanti — e in quel momento il marchio torna
 * in alto a sinistra, la riga «NIDO · INFANZIA / PRIMARIA · CAMPO ESTIVO» in alto a destra
 * e il piede a quattro colonne al fondo. Girata di -90° si otterrebbe la carta capovolta.
 * Verificato rendendo la pagina e guardandola (2026-08-15).
 *
 * Su un formato che non è né A4 né A4 girato non c'è una risposta giusta: la carta si
 * stende «contain» e centrata, e resta dell'aria ai lati. Aria bianca si vede e si
 * corregge; un marchio stirato passa per una scelta grafica.
 */
function stesuraCarta(
  carta: PDFEmbeddedPage,
  larghezza: number,
  altezza: number
): { x: number; y: number; larghezza: number; altezza: number; giro: 0 | 90; copertura: number } {
  const { width: w, height: h } = carta
  if (w <= 0 || h <= 0) return { x: 0, y: 0, larghezza, altezza, giro: 0, copertura: 0 }

  const dritta = Math.min(larghezza / w, altezza / h)
  const girata = Math.min(larghezza / h, altezza / w)
  const area = larghezza * altezza

  if (girata > dritta) {
    // Con `rotate: 90°` pdf-lib compone traslazione → rotazione → scala, quindi il form
    // ruota attorno al punto (x, y): la carta finisce a sinistra di `x`, e per riportarla
    // sul foglio `x` va spostato di tutta la sua altezza scalata.
    const usata = girata * h * girata * w
    return {
      x: (larghezza + girata * h) / 2,
      y: (altezza - girata * w) / 2,
      larghezza: girata * w,
      altezza: girata * h,
      giro: 90,
      copertura: usata / area,
    }
  }

  return {
    x: (larghezza - dritta * w) / 2,
    y: (altezza - dritta * h) / 2,
    larghezza: dritta * w,
    altezza: dritta * h,
    giro: 0,
    copertura: (dritta * w * dritta * h) / area,
  }
}

/** Stampa la carta e poi il contenuto: prima la base, poi ciò che ci si posa sopra. */
function componiPagina(
  pagina: PDFPage,
  carta: PDFEmbeddedPage,
  contenuto: PDFEmbeddedPage | undefined,
  larghezza: number,
  altezza: number
): number {
  const stesa = stesuraCarta(carta, larghezza, altezza)
  pagina.drawPage(carta, {
    x: stesa.x,
    y: stesa.y,
    width: stesa.larghezza,
    height: stesa.altezza,
    rotate: degrees(stesa.giro),
  })
  // Il contenuto, invece, si stende 1:1 sulla sua pagina: è nato con quel formato.
  if (contenuto) pagina.drawPage(contenuto, { x: 0, y: 0, width: larghezza, height: altezza })
  return stesa.copertura
}

/**
 * Una pagina senza flusso di contenuto è un foglio bianco, e pdf-lib **si rifiuta di
 * incorporarla** (`MissingPageContentsEmbeddingError`). Non è un caso di scuola: è ciò
 * che si ottiene salvando un `PDFDocument.create()` senza aggiungere pagine — che poi si
 * rilegge come UNA pagina priva di `Contents`.
 *
 * Il predicato è lo stesso che usa pdf-lib prima di lanciare. Su queste pagine si stende
 * la carta e basta: un foglio bianco sulla carta intestata della scuola resta un foglio
 * sensato, mentre farlo sparire — o far fallire l'intero documento — no.
 */
function haContenuto(pagina: PDFPage): boolean {
  return pagina.node.Contents() !== undefined
}

/**
 * Restituisce lo stesso documento, con la carta intestata della scuola sotto ogni pagina.
 *
 * Il formato di ciascuna pagina è conservato: la carta viene stesa sulla pagina così
 * com'è. Un documento senza pagine torna indietro immutato.
 *
 * Con `opzioni.segnatura` il foglio esce **già protocollato**: è l'unico modo giusto di
 * apporre la segnatura su carta intestata, e il motivo è nel commento in testa al file.
 * Non si compone «prima la carta, poi `applicaSegnatura()`»: quella strada ridipinge la
 * fascia verde sopra il marchio della scuola.
 */
export async function applicaCartaIntestata(
  pdfBytes: Uint8Array,
  opzioni: OpzioniCarta = {}
): Promise<Uint8Array> {
  const sorgente = await PDFDocument.load(pdfBytes)
  const totale = sorgente.getPageCount()

  if (totale === 0) {
    // Non è un errore da rilanciare — non c'è niente su cui stampare — ma nemmeno un
    // caso che possa restare muto: un generatore che produce zero pagine è rotto a monte,
    // e senza questa riga il documento vuoto arriverebbe alla famiglia senza traccia.
    logEvento('modulistica', 'warn', { pagine: 0, byte: pdfBytes.byteLength })
    return pdfBytes
  }

  try {
    const out = await PDFDocument.create()
    const carta = await PDFDocument.load(cartaIntestataBytes())

    // Le due incorporazioni sono ENTRAMBE una sola chiamata: la carta perché il suo peso
    // non si moltiplichi per le pagine, il contenuto perché pdf-lib possa condividere le
    // risorse fra le pagine che le condividono già (font in testa).
    const [cartaIncorporata] = await out.embedPdf(carta, [0])
    const daIncorporare = sorgente
      .getPages()
      .map((pagina, i) => (haContenuto(pagina) ? i : -1))
      .filter((i) => i >= 0)
    const incorporate = await out.embedPdf(sorgente, daIncorporare)
    // Dall'indice di pagina al suo contenuto incorporato: le pagine bianche non ci sono,
    // e leggerle da qui restituisce `undefined` — che è esattamente il caso previsto.
    const contenuti = new Map(daIncorporare.map((indice, posto) => [indice, incorporate[posto]]))

    let scoperte = 0

    for (let i = 0; i < totale; i++) {
      const { width, height } = sorgente.getPage(i).getSize()
      const pagina = out.addPage([width, height])
      const copertura = componiPagina(pagina, cartaIncorporata, contenuti.get(i), width, height)
      if (copertura < COPERTURA_MINIMA) scoperte++
    }

    // La segnatura va sulla PRIMA pagina soltanto, come il timbro sul cartaceo: è
    // l'atto di registrazione del documento, non un piè di pagina che si ripete.
    if (opzioni.segnatura) await stampaSegnatura(out, out.getPage(0), opzioni.segnatura)

    // Una riga sola per documento, non una per pagina: chi legge i log deve poterci
    // ancora leggere il resto.
    const bianche = totale - daIncorporare.length
    if (scoperte > 0 || bianche > 0) {
      logEvento('modulistica', 'warn', {
        pagine: totale,
        // Non più «deformate»: la carta non si deforma mai. Queste sono le pagine di un
        // formato che non è né A4 né A4 girato, dove la carta ci sta intera ma lascia
        // delle fasce bianche — e chi stampa se ne accorge.
        pagine_scoperte: scoperte,
        pagine_bianche: bianche,
      })
    }

    return await out.save()
  } catch (errore) {
    // Il corpo dell'errore non si butta via: distingue «l'asset non è arrivato nel
    // bundle» da «il PDF in ingresso è corrotto», che sono due guasti lontanissimi e
    // che la riga generica di `withRoute` non separerebbe.
    logEvento('modulistica', 'error', { pagine: totale, byte: pdfBytes.byteLength }, errore)
    throw errore
  }
}
