/**
 * Il documento su richiesta (decisione #22): certificato di frequenza/iscrizione, nulla
 * osta o testo libero, generato dalla segreteria e protocollato in uscita.
 *
 * ─── QUESTO FILE NON DISEGNA PIÙ LA TESTATA (2026-08-16) ────────────────────────
 *
 * Fino a ieri qui c'erano una banda verde `rect(0, 0, 210, 30)`, un logo bianco a 14/7,5,
 * l'intestazione di sede a 38, il titolo a 58 e un piede a 287. Sono, riga per riga, le
 * stesse misure che `src/lib/prestampati/impaginazione.ts` aveva alle sue — due copie
 * della stessa testata, e infatti avevano già cominciato a divergere: 38 contro 40 per la
 * prima riga, 58 contro 60 per il titolo. Nessuno se ne sarebbe accorto guardando un
 * foglio solo.
 *
 * Adesso la testata non la disegna nessuno dei due: **è stampata sulla carta**
 * (`src/lib/carta/asset/carta-intestata.pdf`), col marchio della scuola in cima e il piede
 * a quattro colonne — ragione sociale, P.IVA, le tre sedi — in fondo. Qui si impagina il
 * solo CONTENUTO, dentro la finestra che `CARTA` dichiara, e le misure si leggono da lì:
 * un posto solo, e chi lo cambia lo cambia per tutti e cinque i motori.
 *
 * Si importa `carta/geometria` e non `carta/index`: il primo è una manciata di numeri
 * senza dipendenze, il secondo porterebbe dietro pdf-lib e la lettura da disco di 1,1 MB.
 *
 * ─── QUESTI BYTE NON SONO UN DOCUMENTO FINITO ──────────────────────────────────
 *
 * A valle DEVE passare `applicaCartaIntestata()`. Per questo documento lo fa
 * `registraProtocollo()` (`src/lib/protocolli/store.ts`), a cui la rotta passa
 * `componiTimbrato`: la carta e la segnatura si stendono **in una chiamata sola**, appena
 * il numero di protocollo esiste. Non si compone «prima la carta, poi `applicaSegnatura()`»:
 * quella funzione dipinge una fascia verde alta 64 pt in testa al foglio — esattamente
 * sopra il marchio della scuola — ed è il timbro dei documenti ACQUISITI, che arrivano su
 * un foglio bianco.
 *
 * ─── E IL TESTO LUNGO ADESSO VA A PAGINA NUOVA ─────────────────────────────────
 *
 * Lo schema della rotta accetta fino a 4.000 caratteri per il documento «libero», e questo
 * motore li stampava tutti su una pagina sola: ~45 righe da 6,2 mm a partire da 74 fanno
 * 353 mm su un foglio alto 297. Le ultime dieci righe finivano FUORI dal foglio — non
 * tagliate a metà, proprio assenti dalla stampa — e il difetto era invisibile a ogni
 * conteggio. Con la carta intestata sarebbe diventato peggio: prima di uscire dal foglio
 * il testo avrebbe attraversato il piede stampato con la P.IVA e le tre sedi.
 *
 * Testato in `__tests__/lib/protocolli-documento-pdf.test.ts`.
 */

import { jsPDF } from 'jspdf'
import { CARTA, ingombroTesto } from '@/lib/carta/geometria'
import {
  RIGHE_MINIME_IN_CODA,
  codaVuoleUnFoglioNuovo,
  quotaBloccoFinale,
} from '@/lib/carta/blocco-finale'

const VERDE: [number, number, number] = [0, 106, 95]
const GRIGIO: [number, number, number] = [100, 100, 100]
const INCHIOSTRO: [number, number, number] = [45, 45, 45]

const CENTRO_PAGINA = CARTA.larghezzaPagina / 2
const LARGHEZZA_UTILE = CARTA.margineDx - CARTA.margineSx

const CORPO_INTESTAZIONE = 9
const PASSO_INTESTAZIONE = 4.5
const CORPO_TITOLO = 16
const Y_TITOLO_MIN = CARTA.contenutoInizio + 20
const CORPO_TESTO = 12
const INTERLINEA = 6.2
const CORPO_FIRMA = 11

/**
 * Il passo fra due righe di TITOLO, e perché esiste come costante.
 *
 * ⚠️ **FINO AL 2026-08-16 IL TITOLO ANDAVA A CAPO DA SOLO E NESSUNO NE TENEVA IL CONTO.**
 * Si stampava con `maxWidth: LARGHEZZA_UTILE`, quindi jsPDF lo spezzava; ma il filetto si
 * disegnava a `y + 4` FISSO e il corpo ripartiva con `y += 16` FISSO — due numeri che
 * valgono solo per un titolo di una riga. Misurato su
 * «CERTIFICATO DI ISCRIZIONE E FREQUENZA PER BONUS ASILO NIDO INPS ANNO 2026» (73 caratteri):
 * la 2ª riga di titolo occupava 62,24 → 68,76 mm e il filetto cadeva a **65,00**, cioè in
 * mezzo all'inchiostro — una barra verde sul titolo. A 120 caratteri, che è il massimo che
 * lo schema zod della rotta ammette, il titolo va su TRE righe e la prima riga di CORPO
 * atterrava a 73,06 mentre la terza riga di titolo finiva a **75,25**: il testo del
 * documento stampato sopra il suo stesso titolo.
 *
 * È il motore dei CERTIFICATI PROTOCOLLATI — il foglio che va alla famiglia e all'INPS per
 * il Bonus Asilo Nido. Un titolo sbarrato da una riga verde non è una sfumatura
 * tipografica: è un atto che sembra annullato.
 *
 * Adesso il titolo si spezza QUI, con un passo dichiarato, e filetto e corpo si ancorano al
 * numero VERO di righe. Otto millimetri stanno larghi sull'inchiostro di una riga da 16 pt,
 * che ne occupa 6,52.
 */
const INTERLINEA_TITOLO = 8
/**
 * Il filetto verde sotto il titolo: **rientra di 18 mm per lato rispetto ai margini del
 * contenuto (22 / 188)**, cioè va da 40 a 170, per staccare il titolo dal corpo senza
 * arrivare largo quanto il testo.
 *
 * ⚠️ Fino al 2026-08-16 questa riga portava un commento che diceva l'esatto contrario di
 * ciò che il codice faceva: *«il filetto resta DENTRO i margini della carta: prima andava
 * da 40 a 170, cioè scentrato di 6 mm»*. Il codice sotto disegnava — e disegna — proprio da
 * 40 a 170, cioè il valore dichiarato come stato «prima»: la riparazione descritta non
 * aveva cambiato un millimetro. E la diagnosi era sbagliata pure lei, perché 40 e 170 sono
 * simmetrici su 105, che è insieme il centro del foglio e il centro dei margini 22/188:
 * scentrato non lo era mai stato. Un commento che promette un'aria che il codice non lascia
 * è la classe di difetto che questo progetto chiama incidente — e a maggior ragione lo è un
 * commento che dichiara fatta una riparazione che non c'è. Ora la misura la fa un lock,
 * `il filetto del titolo rientra dai margini, e resta centrato sulla pagina`.
 */
const RIENTRO_FILETTO = 18
/** Dalla linea di scrittura dell'ULTIMA riga di titolo al filetto. */
const STACCO_FILETTO = 4
/** Dal filetto alla prima riga di corpo. */
const STACCO_CORPO = 12

/**
 * Dal luogo/data alla riga su cui si firma: 14 mm. È l'altezza che il blocco firma
 * pretende TUTTA INTERA — spezzarlo fra due fogli lascerebbe «La Direzione» su una pagina
 * e il tratto su quella dopo.
 */
const ALTEZZA_FIRMA = 14
const X_FIRMA = 152
const FIRMA_TRATTO_SX = 128
const FIRMA_TRATTO_DX = 176

/**
 * L'aria fra la fine del corpo e il luogo/data, e quanto la si può stringere.
 *
 * ⚠️ **FINO AL 2026-08-16 ERA UN `+18` FISSO, E MANDAVA LA FIRMA SU UN FOGLIO DA SOLA.**
 * Scandagliato da 1 a 70 righe di corpo, succedeva a **25-30 e 61-66**: dodici lunghezze
 * su settanta, cioè una finestra di sei righe ogni trentasei. L'ultima pagina portava
 * soltanto «Giugliano, lì … — La Direzione — ______» su un foglio di carta intestata con
 * marchio, filigrana e le tre sedi. Su un CERTIFICATO PROTOCOLLATO diretto a una famiglia
 * o all'INPS, quel foglio non porta una sola parola dell'atto che firma.
 *
 * La regola — prima stringi l'aria, poi al limite cambia foglio — non è scritta qui: la
 * compie `quotaBloccoFinale()` in `@/lib/carta`, che è la stessa che usa il motore dei
 * prestampati. Erano due copie, e una delle due non c'era.
 */
const STACCO_FIRMA = 18
const STACCO_FIRMA_MINIMO = 5
/** Il blocco firma non risale mai sopra questa quota: sotto il testo ci vuole respiro. */
const FIRMA_Y_MIN = 150
/**
 * La quota più bassa a cui il blocco firma può COMINCIARE: il tratto su cui si firma cade
 * `ALTEZZA_FIRMA` più giù, e deve restare dentro la finestra della carta.
 */
const TETTO_FIRMA = CARTA.contenutoFine - ALTEZZA_FIRMA

/** `true` se una riga scritta a `y` con quel corpo ha ancora l'inchiostro dentro la finestra. */
function ciSta(y: number, corpoPt: number): boolean {
  return ingombroTesto(y, corpoPt).fondo <= CARTA.contenutoFine
}

/**
 * «Pagina n di m» sulla riga di servizio, a 268,5 mm: nell'aria fra il contenuto e il
 * piede stampato sulla carta, mai a 287 — che cade dentro l'elenco delle tre sedi.
 *
 * Su un documento di una pagina sola non si stampa niente: il numero di pagina di una
 * pagina sola è rumore su un atto che va a una famiglia o a un ente.
 */
function disegnaNumeriDiPagina(doc: jsPDF): void {
  const pagine = doc.getNumberOfPages()
  if (pagine < 2) return
  for (let p = 1; p <= pagine; p++) {
    doc.setPage(p)
    doc.setFont('helvetica', 'italic')
    doc.setFontSize(7)
    doc.setTextColor(...GRIGIO)
    doc.text(`Pagina ${p} di ${pagine}`, CARTA.margineDx, CARTA.rigaServizio, { align: 'right' })
  }
}

export function buildDocumentoRichiestaPdf(input: {
  intestazione: string[]
  titolo: string
  corpo: string
  luogoData: string
}): Uint8Array {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })

  // ─── Intestazione di sede (righe reali dal DB, omesse se mancanti) ────────────
  // Comincia a `contenutoInizio` e non a 38: sotto il marchio della carta ci vuole aria,
  // altrimenti l'intestazione sembra una didascalia del logo della scuola.
  let y: number = CARTA.contenutoInizio
  if (input.intestazione.length > 0) {
    doc.setTextColor(...GRIGIO)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(CORPO_INTESTAZIONE)
    for (const riga of input.intestazione) {
      // Le righe si spezzano QUI e non con `maxWidth`: jsPDF manderebbe a capo con il
      // proprio passo (~3,65 mm a 9 pt) mentre questo ciclo avanza di 4,5, e la seconda
      // metà di una riga lunga finirebbe SOTTO la riga successiva. Vale per la ragione
      // sociale estesa della cooperativa, che è lunga davvero.
      for (const spezzone of doc.splitTextToSize(riga, LARGHEZZA_UTILE) as string[]) {
        doc.text(spezzone, CENTRO_PAGINA, y, { align: 'center' })
        y += PASSO_INTESTAZIONE
      }
    }
  }

  // ─── Titolo ──────────────────────────────────────────────────────────────────
  //
  // Il titolo si spezza prima di disegnarlo, e filetto e corpo si ancorano al numero VERO
  // di righe: con `maxWidth` il capo lo faceva jsPDF e questi due numeri restavano quelli
  // di un titolo di una riga sola. Vedi `INTERLINEA_TITOLO`.
  y = Math.max(y + 12, Y_TITOLO_MIN)
  doc.setTextColor(...VERDE)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(CORPO_TITOLO)
  const righeTitolo = doc.splitTextToSize(input.titolo, LARGHEZZA_UTILE) as string[]
  for (let k = 0; k < righeTitolo.length; k++) {
    doc.text(righeTitolo[k], CENTRO_PAGINA, y + k * INTERLINEA_TITOLO, { align: 'center' })
  }
  const fondoTitolo = y + Math.max(0, righeTitolo.length - 1) * INTERLINEA_TITOLO
  doc.setDrawColor(...VERDE)
  doc.line(
    CARTA.margineSx + RIENTRO_FILETTO,
    fondoTitolo + STACCO_FILETTO,
    CARTA.margineDx - RIENTRO_FILETTO,
    fondoTitolo + STACCO_FILETTO
  )

  // ─── Corpo, riga per riga, con il salto di pagina dove serve ──────────────────
  y = fondoTitolo + STACCO_FILETTO + STACCO_CORPO
  doc.setTextColor(...INCHIOSTRO)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(CORPO_TESTO)
  const righeCorpo = doc.splitTextToSize(input.corpo, LARGHEZZA_UTILE) as string[]

  /**
   * `true` se, con l'ultima riga di corpo scritta a `quota`, il blocco firma resta su
   * questo foglio — anche a costo di stringere l'aria fino a `STACCO_FIRMA_MINIMO`.
   *
   * ⚠️ Stringere l'aria non basta da solo: quando è l'ULTIMA RIGA DI CORPO a riempire la
   * pagina, la firma trasloca comunque, e allora sull'ultimo foglio non resta niente del
   * documento. Perciò in coda il conto non è «ci sta la riga» ma «ci stanno le righe E la
   * loro firma»: se non ci stanno, si cambia foglio PRIMA di scriverle.
   *
   * ⚠️ **E LA CODA NON È UNA RIGA SOLA (alzata il 2026-08-16).** Con una riga la regola
   * teneva alla lettera — nessun foglio portava la sola firma — ma **a 21 righe di corpo**
   * l'ultima pagina conteneva «larghezza utile.», la data, «La Direzione», il tratto e
   * «Pagina 2 di 2»: un foglio intero di carta intestata con sopra due parole e una firma.
   * Succedeva anche a 22, 50 e 53 righe. Chi separa quel foglio dal fascicolo ha ancora in
   * mano una firma senza documento, che è lo scopo per cui la regola era stata scritta.
   * La soglia è `RIGHE_MINIME_IN_CODA` e la scelta la compie `codaVuoleUnFoglioNuovo()`,
   * in `@/lib/carta/blocco-finale`: gli altri due motori del lotto la ereditano da lì.
   */
  const firmaSegueLaRigaA = (quota: number): boolean =>
    Math.max(quota + INTERLINEA + STACCO_FIRMA_MINIMO, FIRMA_Y_MIN) <= TETTO_FIRMA

  for (let k = 0; k < righeCorpo.length; k++) {
    // Il salto anticipato si fa solo se sul foglio nuovo le righe e la firma ci starebbero
    // davvero: altrimenti costerebbe una pagina senza rimediare a niente.
    const trascinaLaFirma = codaVuoleUnFoglioNuovo({
      quota: y,
      righeRimaste: righeCorpo.length - k,
      righeMinimeInCoda: RIGHE_MINIME_IN_CODA,
      interlinea: INTERLINEA,
      inizioPagina: CARTA.contenutoInizio,
      bloccoRestaConLUltimaRigaA: firmaSegueLaRigaA,
    })
    if (!ciSta(y, CORPO_TESTO) || trascinaLaFirma) {
      doc.addPage()
      y = CARTA.contenutoInizio
      // Su una pagina nuova jsPDF non conserva lo stato del testo impostato sopra.
      doc.setTextColor(...INCHIOSTRO)
      doc.setFont('helvetica', 'normal')
      doc.setFontSize(CORPO_TESTO)
    }
    doc.text(righeCorpo[k], CARTA.margineSx, y)
    y += INTERLINEA
  }

  // ─── Luogo, data e firma: un blocco solo, sull'ultimo foglio ──────────────────
  // Il tratto su cui si firma cade a `y + ALTEZZA_FIRMA`: il tetto del blocco è quindi il
  // fondo della finestra meno quell'altezza, non la finestra intera.
  const firma = quotaBloccoFinale({
    dopoIlContenuto: y,
    stacco: STACCO_FIRMA,
    staccoMinimo: STACCO_FIRMA_MINIMO,
    quotaMinima: FIRMA_Y_MIN,
    tetto: TETTO_FIRMA,
    inizioPagina: CARTA.contenutoInizio,
  })
  if (firma.paginaNuova) doc.addPage()
  y = firma.y
  doc.setTextColor(...INCHIOSTRO)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(CORPO_FIRMA)
  doc.text(input.luogoData, CARTA.margineSx, y)
  doc.setFont('helvetica', 'bold')
  doc.text('La Direzione', X_FIRMA, y, { align: 'center' })
  doc.setDrawColor(...GRIGIO)
  doc.line(FIRMA_TRATTO_SX, y + ALTEZZA_FIRMA, FIRMA_TRATTO_DX, y + ALTEZZA_FIRMA)

  disegnaNumeriDiPagina(doc)

  return new Uint8Array(doc.output('arraybuffer'))
}
