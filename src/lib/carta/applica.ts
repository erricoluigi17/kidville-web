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
 * finisce a 27,05 mm — ci mette dentro un SECONDO logo Kidville sopra il primo, e riscala
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
import { CARTA, stesuraCarta } from './geometria'

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
 *
 * ⚠️ Le quote (`segnaturaRiga`, `margineDx`) sono contate dal foglio, non dalla carta, e
 * sull'A4 ORIZZONTALE le due cose non coincidono più: lì la carta è girata, quindi l'aria
 * che riserva alla segnatura è una colonna verticale, mentre questa riga resta orizzontale
 * a 34 mm dal bordo alto. Misurato: su 297×210 finisce comunque fra le due fasce vietate
 * (x da ~120 a 188, la colonna del marchio si ferma a 27,05 e quella del piede comincia a
 * 272,1), quindi non tocca niente della carta — ma cade in mezzo all'area di lavoro, e un
 * motore orizzontale che protocolla deve lasciarle la riga libera. Il lock che lo misura è
 * in `__tests__/lib/carta-applica.test.ts`, sul verticale e sull'orizzontale.
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
 * Dove posare la carta su UNA pagina, tradotto nei termini che vuole `drawPage`.
 *
 * ⚠️ **LA REGOLA NON STA PIÙ QUI.** Fino al 2026-08-16 questa funzione decideva da sola
 * scala e rotazione, e il difetto non era la scelta: era che **la scelta non usciva da
 * questo file**. Sull'A4 orizzontale la carta viene girata di 90°, quindi il marchio non è
 * più una fascia in cima al foglio ma una colonna sul bordo sinistro — e chi impagina il
 * registro presenze (che è orizzontale, spec §1.5) leggeva `CARTA.brandFine`, una quota
 * verticale che sul foglio girato non vuol più dire niente, e ci stampava sopra. Reso e
 * guardato: la «R» di «REGISTRO PRESENZE» esattamente sulle lettere di «PRIMARIA ·».
 *
 * Ora la regola vive in `geometria.ts` — `stesuraCarta()` per dove va la carta,
 * `fasceVietate()` per dove NON può andare il contenuto — e qui resta solo la traduzione
 * in coordinate PDF. Un motore che deve impaginare su un formato qualunque chiede lì, senza
 * importare pdf-lib e senza i suoi 1,1 MB di asset.
 *
 * La traduzione, che è l'unica cosa non ovvia rimasta: `width`/`height` di `drawPage` sono
 * misurati sugli assi DELLA CARTA, non del foglio, quindi non si scambiano quando c'è il
 * giro; `x`/`y` sono il perno della rotazione, e con `rotate: 90°` pdf-lib compone
 * traslazione → rotazione → scala, cioè il form finisce a SINISTRA di `x`. Perciò `x` è il
 * bordo destro del riquadro quando la carta è girata, e quello sinistro quando è dritta.
 * Che questa traduzione corrisponda alla dichiarazione di `geometria.ts` non è affidato a
 * questo commento: `__tests__/lib/carta-applica.test.ts` misura dove finisce l'INCHIOSTRO
 * del marchio sul foglio composto e lo confronta con `fasceVietate()`.
 */
function posaCarta(
  larghezza: number,
  altezza: number
): { x: number; y: number; larghezza: number; altezza: number; giro: 0 | 90; copertura: number } {
  const stesa = stesuraCarta(larghezza / PUNTI_PER_MM, altezza / PUNTI_PER_MM)
  const { riquadro } = stesa
  return {
    x: (stesa.giro === 90 ? riquadro.sinistra + riquadro.larghezza : riquadro.sinistra) * PUNTI_PER_MM,
    y: (altezza / PUNTI_PER_MM - (riquadro.alto + riquadro.altezza)) * PUNTI_PER_MM,
    larghezza: stesa.scala * CARTA.larghezzaPagina * PUNTI_PER_MM,
    altezza: stesa.scala * CARTA.altezzaPagina * PUNTI_PER_MM,
    giro: stesa.giro,
    copertura: stesa.copertura,
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
  const stesa = posaCarta(larghezza, altezza)
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
    // Tutta la geometria — la stesura, le due fasce vietate, il giro sull'orizzontale — è
    // calcolata sulle misure che `CARTA` dichiara, non su quelle dell'asset che si sta
    // stendendo. Finché coincidono è la stessa cosa; se un giorno non coincidessero,
    // `fasceVietate()` direbbe il falso a ogni motore che la interroga, e lo direbbe in
    // silenzio. Il lock sul SHA-256 dell'asset dovrebbe arrivare prima: questa riga è la
    // seconda rete, e costa un confronto per documento.
    const attesaX = CARTA.larghezzaPagina * PUNTI_PER_MM
    const attesaY = CARTA.altezzaPagina * PUNTI_PER_MM
    if (
      Math.abs(cartaIncorporata.width - attesaX) > 0.5 ||
      Math.abs(cartaIncorporata.height - attesaY) > 0.5
    ) {
      logEvento('modulistica', 'error', {
        operazione: 'carta/asset-fuori-misura',
        larghezza: Math.round(cartaIncorporata.width),
        altezza: Math.round(cartaIncorporata.height),
      })
    }
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
