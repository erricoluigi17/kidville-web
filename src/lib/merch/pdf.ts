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
 * stampate sopra la ragione sociale della scuola. Ora il limite è `CARTA.contenutoFine`,
 * e vale anche per il totale e per le note — che prima potevano uscire dal foglio.
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
  y += 2
  spazioPer(11)
  doc.setDrawColor(200)
  doc.line(X_ARTICOLO, y, X_QUANTITA, y)
  y += 6
  scrivi(`Totale pezzi: ${totaleQ}`, X_ARTICOLO, 11)
  y += 9

  if (i.note) {
    doc.setTextColor(GRIGIO)
    doc.setFontSize(9)
    const righe = doc.splitTextToSize(`Note: ${i.note}`, CARTA.margineDx - CARTA.margineSx) as string[]
    for (const riga of righe) {
      spazioPer(9)
      doc.setFontSize(9)
      doc.setTextColor(GRIGIO)
      doc.text(riga, X_ARTICOLO, y)
      y += 4.5
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
