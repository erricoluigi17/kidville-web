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
 * A valle passa `applicaSegnatura()` di `src/lib/protocolli/timbro.ts`, come già oggi.
 */

import { PDFDocument, type PDFEmbeddedPage, type PDFPage } from 'pdf-lib'
import { logEvento } from '@/lib/logging/logger'
import { cartaIntestataBytes } from './asset'

/**
 * Oltre questo scarto fra le proporzioni della pagina e quelle della carta, la carta
 * arriva sul foglio visibilmente deformata (il caso vero: una pagina in orizzontale).
 * Non è un motivo per far sparire un foglio, ma è un motivo per lasciare una riga.
 */
const TOLLERANZA_PROPORZIONI = 0.02

/** Stampa la carta e poi il contenuto: prima la base, poi ciò che ci si posa sopra. */
function componiPagina(
  pagina: PDFPage,
  carta: PDFEmbeddedPage,
  contenuto: PDFEmbeddedPage | undefined,
  larghezza: number,
  altezza: number
): void {
  pagina.drawPage(carta, { x: 0, y: 0, width: larghezza, height: altezza })
  if (contenuto) pagina.drawPage(contenuto, { x: 0, y: 0, width: larghezza, height: altezza })
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
 */
export async function applicaCartaIntestata(pdfBytes: Uint8Array): Promise<Uint8Array> {
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

    const proporzioneCarta = cartaIncorporata.width / cartaIncorporata.height
    let deformate = 0

    for (let i = 0; i < totale; i++) {
      const { width, height } = sorgente.getPage(i).getSize()
      const pagina = out.addPage([width, height])
      componiPagina(pagina, cartaIncorporata, contenuti.get(i), width, height)
      if (Math.abs(width / height - proporzioneCarta) > TOLLERANZA_PROPORZIONI) deformate++
    }

    // Una riga sola per documento, non una per pagina: chi legge i log deve poterci
    // ancora leggere il resto.
    const bianche = totale - daIncorporare.length
    if (deformate > 0 || bianche > 0) {
      logEvento('modulistica', 'warn', {
        pagine: totale,
        pagine_deformate: deformate,
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
