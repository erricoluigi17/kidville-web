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
 * Testato in `__tests__/lib/merch-pdf.test.ts`.
 */

import { jsPDF } from 'jspdf'
import { formattaIstante } from '@/i18n/config'
import { CARTA, ingombroTesto } from '@/lib/carta/geometria'

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
    y += 3
    doc.setDrawColor(200)
    doc.line(X_ARTICOLO, y, X_QUANTITA, y)
    y += 6
  }
  spazioPer(10)
  intestazioneTabella()

  let totaleQ = 0
  doc.setFontSize(10)
  for (const r of i.righe) {
    if (ingombroTesto(y, 10).fondo > CARTA.contenutoFine) {
      doc.addPage()
      y = CARTA.contenutoInizio
      // L'intestazione delle colonne si ripete: una pagina di quantità senza il nome
      // delle colonne è un elenco di numeri che il magazzino deve indovinare.
      intestazioneTabella()
      doc.setFontSize(10)
    }
    doc.text(String(r.articolo).slice(0, 60), X_ARTICOLO, y)
    doc.text(r.taglia || '—', X_TAGLIA, y)
    doc.text(String(r.quantita), X_QUANTITA, y, { align: 'right' })
    totaleQ += r.quantita
    y += 6
  }
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
  // La regola del limite era giusta: mancava il «tieni insieme» che il motore dei
  // protocolli ha già per il blocco firma (`ALTEZZA_FIRMA`, `documento-pdf.ts`). Qui
  // l'altezza del blocco si calcola PRIMA di stamparlo e il salto si chiede una volta sola:
  // o ci stanno insieme, o vanno insieme sulla pagina nuova.
  const ALTEZZA_TOTALE = 6
  const STACCO_NOTE = 9
  const PASSO_NOTE = 4.5

  // `splitTextToSize` misura col corpo CORRENTE: senza questa riga spezzerebbe la nota
  // sulle larghezze di 10 pt e ne verrebbe fuori un numero di righe che non è quello vero.
  doc.setFontSize(9)
  const righeNote = i.note
    ? (doc.splitTextToSize(`Note: ${i.note}`, CARTA.margineDx - CARTA.margineSx) as string[])
    : []

  /** Il fondo dell'inchiostro del blocco, se il filetto cadesse a `cima`. */
  const fondoBlocco = (cima: number): number => {
    const yTotale = cima + ALTEZZA_TOTALE
    const fondoTotale = ingombroTesto(yTotale, 11).fondo
    if (righeNote.length === 0) return fondoTotale
    const ultimaNota = yTotale + STACCO_NOTE + (righeNote.length - 1) * PASSO_NOTE
    return Math.max(fondoTotale, ingombroTesto(ultimaNota, 9).fondo)
  }

  y += 2
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
