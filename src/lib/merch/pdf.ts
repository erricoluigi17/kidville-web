/**
 * L'ordine d'acquisto (PO) al fornitore. Nessun accesso a DB: input già risolto.
 * Un PDF per fornitore (per costruzione: un PO = un fornitore).
 *
 * ⚠️ **DAL 2026-08-16 QUESTO FOGLIO ESCE SULLA CARTA INTESTATA REALE.** È il documento di
 * questo lotto che va a un TERZO — un fornitore che di Kidville vede solo questa pagina —
 * e finora partiva senza intestazione di sorta: il nome della scuola in 15 pt e via, senza
 * ragione sociale completa, senza P.IVA della cooperativa, senza le tre sedi. Adesso quelle
 * cose le porta la carta, e qui si impagina il solo CONTENUTO dentro la finestra che
 * `CARTA` dichiara.
 *
 * ⚠️ **Questi byte non sono un documento finito**: la carta la stende la rotta
 * (`src/app/api/admin/merch/ordini-fornitore/pdf/route.ts`) con `applicaCartaIntestata()`.
 * Chi consegna importa quella funzione; chi impagina legge solo i numeri di `CARTA`, che
 * non porta con sé pdf-lib né 1,1 MB di asset.
 *
 * Il salto di pagina scattava a `y > 270`: sulla carta è **dentro** il piede a quattro
 * colonne (272,1 → 285,1), quindi le ultime righe di un ordine lungo sarebbero state
 * stampate sopra la ragione sociale della scuola. Ora il limite è `CARTA.contenutoFine`.
 *
 * ⚠️ **Un limite giusto non basta: serve anche sapere COSA non si spezza.** Applicato riga
 * per riga, quel limite mandava la sola riga «Note: …» su un terzo foglio — cioè su una
 * pagina di carta intestata della scuola, con marchio e filigrana, spedita a un fornitore
 * con sopra una riga. Filetto, totale e note sono ora un blocco solo: vedi la chiusura di
 * `buildOrdineFornitorePdf`.
 *
 * ⚠️ **E IL NOME DELL'ARTICOLO SFONDAVA LA COLONNA «TAGLIA» IN SILENZIO.** Si accorciava
 * con `String(r.articolo).slice(0, 60)`: sessanta CARATTERI, cioè un numero che non ha
 * niente a che vedere con i millimetri della colonna. Misurato sul PDF generato con nomi da
 * catalogo scolastico veri — `divise_ordini_righe.articolo_nome` è `text NOT NULL`, senza
 * alcun limite — «GREMBIULE SCOLASTICO COTONE BIANCO RICAMATO LOGO KIDVILLE GI» arrivava a
 * **149,03 mm** su una colonna che finisce a 128, e ci si stampava sopra la sigla «4A»
 * (132,0 → 136,3); con sessanta maiuscole larghe arrivava a **211,82 mm** su un foglio
 * largo 210, cioè **usciva dal foglio**. E il taglio era MUTO: «…KIDVILLE GIUGLIANO»
 * diventava «…KIDVILLE GI», che sembra il nome vero dell'articolo — su un ordine d'acquisto
 * che il magazzino del fornitore deve poter leggere senza indovinare.
 *
 * Ora ogni cella si accorcia sulla LARGHEZZA della propria colonna, coi puntini di
 * sospensione, con la stessa funzione che usa il registro presenze: `accorcia()` sta in
 * `@/lib/carta/testo` per la stessa ragione per cui ci sta `quotaBloccoFinale()` — il terzo
 * motore che ne avrà bisogno la trova invece di riscoprirla a metà.
 *
 * Testato in `__tests__/lib/merch-pdf.test.ts`.
 */

import { jsPDF } from 'jspdf'
import { formattaIstante } from '@/i18n/config'
import { RIGHE_MINIME_IN_CODA, codaVuoleUnFoglioNuovo } from '@/lib/carta/blocco-finale'
import { CARTA, ingombroTesto } from '@/lib/carta/geometria'
import { accorcia } from '@/lib/carta/testo'

export interface OrdineFornitorePdfInput {
  numero: string
  data?: string | null
  committente: { denominazione?: string | null; piva?: string | null; indirizzo?: string | null; email?: string | null; telefono?: string | null }
  fornitore: { nome: string; referente?: string | null; email?: string | null; telefono?: string | null; indirizzo?: string | null; piva?: string | null }
  righe: { articolo: string; taglia: string; quantita: number }[]
  note?: string | null
}

const GRIGIO = 110
const NERO = 0

/** Le tre colonne della tabella articoli, dentro i margini della carta (22 → 188). */
const X_ARTICOLO = CARTA.margineSx
const X_TAGLIA = 132
const X_QUANTITA = CARTA.margineDx

/**
 * L'aria fra una colonna e la successiva. Quattro millimetri, e servono per DUE cose.
 *
 * La prima si vede: sotto, due celle contigue si leggono come una sola voce e il fornitore
 * deve indovinare dove finisce il nome dell'articolo e dove comincia la taglia.
 *
 * ⚠️ La seconda non si vede, ed è misurata: **jsPDF stima la larghezza un filo più stretta
 * di quanto il visualizzatore poi disegni.** Per le cifre di Helvetica usa 550 millesimi di
 * em dove lo standard — e PDF.js, e Anteprima, e Acrobat — usano 556; su un campione di
 * stringhe vere lo scarto va da +0,4% a +1,1%. `accorcia()` chiede la misura a jsPDF, quindi
 * una cella «giusta» può risultare fino a **1,2 mm** più larga su una colonna di 106. L'aria
 * è il budget di quello scarto: azzerarla farebbe toccare le celle senza che nessun conto
 * lo dica.
 */
const ARIA_COLONNA = 4
/**
 * Quanto la colonna «Q.tà» si prende verso sinistra: è allineata a destra, quindi cresce
 * in quella direzione. Quattordici millimetri tengono **sette cifre** a 10 pt (1,96 mm per
 * cifra, misurato): un ordine di divise scolastiche non arriva al milione di pezzi, e se ci
 * arrivasse il numero resterebbe comunque dentro la sua colonna.
 */
const LARGHEZZA_QUANTITA = 14

/**
 * Le tre colonne come le vede chi impagina — e come le misura il lock.
 *
 * Esportate perché `__tests__/lib/merch-pdf.test.ts` verifichi che ogni cella stia dentro
 * la PROPRIA colonna rifacendo il conto, invece di ricopiarne il risultato: un test che
 * riscrive il numero che sorveglia non sorveglia niente. Il lock precedente guardava i soli
 * margini esterni (22 / 188) e a 149 mm non scattava, perché 149 < 188.
 */
export const COLONNE_ORDINE = {
  articolo: { sinistra: X_ARTICOLO, larghezza: X_TAGLIA - ARIA_COLONNA - X_ARTICOLO },
  taglia: {
    sinistra: X_TAGLIA,
    larghezza: X_QUANTITA - LARGHEZZA_QUANTITA - ARIA_COLONNA - X_TAGLIA,
  },
  quantita: { sinistra: X_QUANTITA - LARGHEZZA_QUANTITA, larghezza: LARGHEZZA_QUANTITA },
} as const

/** Il passo di una riga articolo. */
const PASSO_RIGA = 6
/** L'aria fra l'ultima riga di merce e il filetto di chiusura. */
const STACCO_CHIUSURA = 2
/** Dal filetto di chiusura alla riga «Totale pezzi». */
const ALTEZZA_TOTALE = 6
/** Da «Totale pezzi» alla prima riga di nota, e il passo fra le righe di nota. */
const STACCO_NOTE = 9
const PASSO_NOTE = 4.5
/** Dall'intestazione delle colonne al suo filetto. */
const STACCO_FILETTO_TESTATA = 3
/**
 * Quanto costa ripetere l'intestazione delle colonne in cima a una pagina nuova: serve a
 * sapere, PRIMA di saltare, dove cadrebbe la prima riga sul foglio successivo.
 */
const ALTEZZA_TESTATA_TABELLA = STACCO_FILETTO_TESTATA + PASSO_RIGA

export function buildOrdineFornitorePdf(i: OrdineFornitorePdfInput) {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })
  let y = CARTA.contenutoInizio

  /** Una pagina nuova quando la prossima riga non ci sta più dentro la finestra. */
  const spazioPer = (corpoPt: number) => {
    if (ingombroTesto(y, corpoPt).fondo <= CARTA.contenutoFine) return
    doc.addPage()
    y = CARTA.contenutoInizio
  }
  const scrivi = (testo: string, x: number, corpoPt: number, opzioni: Parameters<jsPDF['text']>[3] = undefined) => {
    spazioPer(corpoPt)
    doc.setFontSize(corpoPt)
    doc.text(testo, x, y, opzioni)
  }

  // ── Committente (la scuola) ──────────────────────────────────────────────────
  doc.setTextColor(NERO)
  scrivi(i.committente.denominazione || 'Ordine di acquisto', X_ARTICOLO, 15)
  y += 6
  doc.setTextColor(GRIGIO)
  const fisc = [
    i.committente.piva ? `P.IVA ${i.committente.piva}` : null,
    i.committente.email || null,
    i.committente.telefono || null,
  ].filter(Boolean).join(' · ')
  if (fisc) { scrivi(fisc, X_ARTICOLO, 9); y += 5 }
  if (i.committente.indirizzo) { scrivi(i.committente.indirizzo, X_ARTICOLO, 9); y += 5 }
  doc.setTextColor(NERO)
  y += 6

  scrivi(`ORDINE D'ACQUISTO ${i.numero}`, X_ARTICOLO, 16)
  y += 7
  doc.setTextColor(GRIGIO)
  scrivi(`Data ${i.data ?? formattaIstante(new Date(), 'it')}`, X_ARTICOLO, 9)
  y += 9
  doc.setTextColor(NERO)

  // ── Fornitore ────────────────────────────────────────────────────────────────
  scrivi('Spett.le fornitore:', X_ARTICOLO, 11); y += 6
  scrivi(i.fornitore.nome || '—', X_ARTICOLO, 12); y += 6
  doc.setTextColor(GRIGIO)
  const contatti = [
    i.fornitore.referente ? `Ref. ${i.fornitore.referente}` : null,
    i.fornitore.email || null,
    i.fornitore.telefono || null,
  ].filter(Boolean).join(' · ')
  if (contatti) { scrivi(contatti, X_ARTICOLO, 9); y += 5 }
  if (i.fornitore.piva) { scrivi(`P.IVA ${i.fornitore.piva}`, X_ARTICOLO, 9); y += 5 }
  doc.setTextColor(NERO)
  y += 6

  // ── Tabella articoli ─────────────────────────────────────────────────────────
  const intestazioneTabella = () => {
    doc.setTextColor(GRIGIO)
    doc.setFontSize(10)
    doc.text('Articolo', X_ARTICOLO, y)
    doc.text('Taglia', X_TAGLIA, y)
    doc.text('Q.tà', X_QUANTITA, y, { align: 'right' })
    doc.setTextColor(NERO)
    y += STACCO_FILETTO_TESTATA
    doc.setDrawColor(200)
    doc.line(X_ARTICOLO, y, X_QUANTITA, y)
    y += PASSO_RIGA
  }
  spazioPer(10)
  intestazioneTabella()

  // ── Chiusura: filetto, totale e note sono UN BLOCCO SOLO ─────────────────────
  //
  // ⚠️ **QUI LA NOTA FINIVA DA SOLA SU UNA PAGINA (riparato il 2026-08-16).** Il limite di
  // pagina si chiedeva riga per riga, quindi il totale entrava sull'ultimo foglio e la nota
  // ne apriva un altro: misurato su un ordine reale, pag. 2 chiudeva con «Totale pezzi:
  // 1830» a 252,21 mm e pag. 3 conteneva la SOLA riga «Note: …» a 37,72 mm. Il salto
  // scattava per mezzo millimetro (264,01 contro un limite di 263,5), e il risultato era un
  // foglio di carta intestata della scuola — marchio, filigrana, le tre sedi — spedito a un
  // FORNITORE con sopra una riga.
  //
  // ⚠️ **E LA PRIMA RIPARAZIONE NON BASTAVA: TENEVA INSIEME LA CHIUSURA, NON L'ULTIMA
  // RIGA DI MERCE.** Il blocco filetto+totale+note viaggiava compatto, ma quando era
  // l'ultima riga articolo a riempire esattamente la pagina, il blocco intero traslocava
  // da solo: misurato su questo stesso ordine, a 23 · 24 · 25 · 26 · 59 · 60 articoli
  // l'ultimo foglio portava «Totale pezzi: 46» e «Note: …» e nient'altro. Da un foglio con
  // una riga sola a un foglio con due righe: lo stesso foglio di carta intestata spedito a
  // un terzo.
  //
  // La regola vera non è «totale e note insieme», è **una pagina non può portare solo la
  // chiusura**. Perciò l'altezza del blocco si calcola PRIMA di entrare nella tabella, e
  // sull'ULTIMA riga articolo il conto non è più «ci sta la riga» ma «ci stanno la riga E
  // la sua chiusura»: se non ci stanno, si va a pagina nuova prima di stampare la riga, e
  // l'ultimo articolo scende insieme al suo totale.
  // `splitTextToSize` misura col corpo CORRENTE: senza questa riga spezzerebbe la nota
  // sulle larghezze di 10 pt e ne verrebbe fuori un numero di righe che non è quello vero.
  doc.setFontSize(9)
  const righeNote = i.note
    ? (doc.splitTextToSize(`Note: ${i.note}`, CARTA.margineDx - CARTA.margineSx) as string[])
    : []

  /** Il fondo dell'inchiostro del blocco di chiusura, se il filetto cadesse a `cima`. */
  const fondoBlocco = (cima: number): number => {
    const yTotale = cima + ALTEZZA_TOTALE
    const fondoTotale = ingombroTesto(yTotale, 11).fondo
    if (righeNote.length === 0) return fondoTotale
    const ultimaNota = yTotale + STACCO_NOTE + (righeNote.length - 1) * PASSO_NOTE
    return Math.max(fondoTotale, ingombroTesto(ultimaNota, 9).fondo)
  }

  /**
   * `true` se, con l'ULTIMA riga di merce scritta a `quota`, la chiusura resta sul foglio.
   *
   * ⚠️ **NON BASTA CHE CI STIA UNA RIGA SOLA (alzato il 2026-08-16).** Fino a stamattina la
   * coda trascinata era una riga: formalmente nessun foglio portava «solo la chiusura», ma
   * un foglio di carta intestata spedito a un fornitore con sopra un articolo e «Totale
   * pezzi: 46» è lo stesso foglio quasi vuoto. La soglia è `RIGHE_MINIME_IN_CODA`, e sta in
   * `@/lib/carta/blocco-finale` insieme alla politica: i tre motori del lotto la ereditano
   * invece di riscoprirla ciascuno a modo suo.
   */
  const chiusuraSegueLaRigaA = (quota: number): boolean =>
    fondoBlocco(quota + PASSO_RIGA + STACCO_CHIUSURA) <= CARTA.contenutoFine

  let totaleQ = 0
  doc.setFontSize(10)
  for (let k = 0; k < i.righe.length; k++) {
    const r = i.righe[k]
    const fondoRiga = ingombroTesto(y, 10).fondo
    // Il salto anticipato ha senso solo se sulla pagina nuova le righe e la chiusura ci
    // stanno DAVVERO insieme: quel conto — e il degrado da tre righe a due a una — lo fa
    // `codaVuoleUnFoglioNuovo`. Il foglio nuovo comincia dopo l'intestazione delle colonne,
    // che si ripete: partire da `contenutoInizio` prometterebbe spazio che non c'è.
    const trascinaLaChiusura = codaVuoleUnFoglioNuovo({
      quota: y,
      righeRimaste: i.righe.length - k,
      righeMinimeInCoda: RIGHE_MINIME_IN_CODA,
      interlinea: PASSO_RIGA,
      inizioPagina: CARTA.contenutoInizio + ALTEZZA_TESTATA_TABELLA,
      bloccoRestaConLUltimaRigaA: chiusuraSegueLaRigaA,
    })
    if (fondoRiga > CARTA.contenutoFine || trascinaLaChiusura) {
      doc.addPage()
      y = CARTA.contenutoInizio
      // L'intestazione delle colonne si ripete: una pagina di quantità senza il nome
      // delle colonne è un elenco di numeri che il magazzino deve indovinare.
      intestazioneTabella()
      doc.setFontSize(10)
    }
    // Ogni cella dentro la PROPRIA colonna, misurata: `slice(0, 60)` tagliava a sessanta
    // caratteri — un numero che non ha niente a che vedere coi millimetri — e consegnava
    // «…KIDVILLE GI» al posto di «…KIDVILLE GIUGLIANO», senza dire che mancava qualcosa.
    doc.text(accorcia(doc, String(r.articolo), COLONNE_ORDINE.articolo.larghezza), X_ARTICOLO, y)
    doc.text(accorcia(doc, r.taglia || '—', COLONNE_ORDINE.taglia.larghezza), X_TAGLIA, y)
    // La quantità NON si accorcia: un numero coi puntini è un numero sbagliato, e su un
    // ordine d'acquisto è la quantità che il fornitore spedisce. La colonna è larga quanto
    // basta a sette cifre; se un giorno non bastasse, il rimedio è allargarla.
    doc.text(String(r.quantita), X_QUANTITA, y, { align: 'right' })
    totaleQ += r.quantita
    y += PASSO_RIGA
  }

  y += STACCO_CHIUSURA
  if (fondoBlocco(y) > CARTA.contenutoFine) {
    doc.addPage()
    y = CARTA.contenutoInizio
  }
  doc.setDrawColor(200)
  doc.line(X_ARTICOLO, y, X_QUANTITA, y)
  y += ALTEZZA_TOTALE
  doc.setTextColor(NERO)
  doc.setFontSize(11)
  doc.text(`Totale pezzi: ${totaleQ}`, X_ARTICOLO, y)
  y += STACCO_NOTE

  if (righeNote.length > 0) {
    doc.setTextColor(GRIGIO)
    doc.setFontSize(9)
    for (const riga of righeNote) {
      // Il «tieni insieme» non può diventare un modo di sfondare il piede: se il blocco non
      // ci sta nemmeno su una pagina vuota — una nota di quaranta righe — si spezza.
      if (ingombroTesto(y, 9).fondo > CARTA.contenutoFine) {
        doc.addPage()
        y = CARTA.contenutoInizio
        doc.setFontSize(9)
        doc.setTextColor(GRIGIO)
      }
      doc.text(riga, X_ARTICOLO, y)
      y += PASSO_NOTE
    }
    doc.setTextColor(NERO)
  }

  // «Pagina n di m» sulla riga di servizio (268,5 mm): nell'aria fra il contenuto e il
  // piede stampato sulla carta. Su una pagina sola non si scrive niente.
  const pagine = doc.getNumberOfPages()
  if (pagine > 1) {
    for (let p = 1; p <= pagine; p++) {
      doc.setPage(p)
      doc.setFont('helvetica', 'italic')
      doc.setFontSize(7)
      doc.setTextColor(GRIGIO)
      doc.text(`Pagina ${p} di ${pagine}`, CARTA.margineDx, CARTA.rigaServizio, { align: 'right' })
    }
  }

  return Buffer.from(doc.output('arraybuffer'))
}
