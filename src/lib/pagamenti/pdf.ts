import { jsPDF } from 'jspdf'
import type { DatiStruttura } from './fiscale'

// Builder jsPDF dei documenti della contabilità (ricevute; attestazioni in
// pdf-attestazione). Nessun accesso a DB: input già risolto e snapshot-abile.

const METODO_LABEL: Record<string, string> = {
    contanti: 'Contanti',
    bonifico: 'Bonifico',
    pos: 'POS / Carta',
    assegno: 'Assegno',
    altro: 'Altro',
}

export interface RicevutaPdfInput {
    numero?: number | null
    anno?: number | null
    struttura: Partial<DatiStruttura>
    intestatario?: { nome?: string | null; codice_fiscale?: string | null } | null
    alunno: string
    descrizione: string
    periodo?: string | null
    importo: number
    incassi: { importo: number | string; data_incasso?: string | null; metodo?: string | null }[]
    tracciabile: boolean
    bollo: boolean
    dicituraBollo?: string | null
    emessaIl?: string
}

const dataIt = (d?: string | null) => (d ? new Date(d).toLocaleDateString('it-IT') : null)

export interface AttestazionePdfInput {
    anno: number
    struttura: Partial<DatiStruttura>
    intestatario?: { nome?: string | null; codice_fiscale?: string | null } | null
    alunno: string
    codiceFiscaleAlunno?: string | null
    righe: { descrizione: string; importo: number; tracciabile: boolean; escluso: boolean }[]
    versato: number
    detraibile: number
    nonTracciabile: number
    escluso: number
}

export function buildAttestazionePdf(i: AttestazionePdfInput) {
    const doc = new jsPDF()
    let y = 20

    doc.setFontSize(15)
    doc.text(i.struttura.denominazione || 'Attestazione dei pagamenti', 20, y)
    y += 6
    doc.setFontSize(9)
    doc.setTextColor(110)
    const fiscali = [
        i.struttura.piva ? `P.IVA ${i.struttura.piva}` : null,
        i.struttura.codice_fiscale ? `CF ${i.struttura.codice_fiscale}` : null,
    ].filter(Boolean).join(' · ')
    if (fiscali) { doc.text(fiscali, 20, y); y += 5 }
    doc.setTextColor(0)
    y += 7

    doc.setFontSize(15)
    doc.text(`ATTESTAZIONE DEI PAGAMENTI — ANNO ${i.anno}`, 20, y)
    y += 7
    doc.setFontSize(9)
    doc.setTextColor(110)
    doc.text(`Rilasciata il ${new Date().toLocaleDateString('it-IT')} ai fini della dichiarazione dei redditi.`, 20, y)
    y += 9
    doc.setTextColor(0)

    doc.setFontSize(11)
    if (i.intestatario?.nome) {
        doc.text(`Intestatario: ${i.intestatario.nome}${i.intestatario.codice_fiscale ? ` — CF ${i.intestatario.codice_fiscale}` : ''}`, 20, y)
        y += 7
    }
    doc.text(`Alunno: ${i.alunno || '—'}${i.codiceFiscaleAlunno ? ` — CF ${i.codiceFiscaleAlunno}` : ''}`, 20, y)
    y += 9

    doc.setFontSize(10)
    for (const r of i.righe) {
        if (y > 265) { doc.addPage(); y = 20 }
        const note = r.escluso ? ' (servizio non detraibile)' : r.tracciabile ? '' : ' (quote in contanti: non detraibile)'
        doc.text(`• ${r.descrizione} — € ${r.importo.toFixed(2)}${note}`, 24, y)
        y += 6
    }
    y += 4

    doc.setFontSize(12)
    doc.text(`Totale versato nell'anno: € ${i.versato.toFixed(2)}`, 20, y); y += 7
    doc.setTextColor(0, 106, 95)
    doc.text(`di cui pagato con strumenti tracciabili (detraibile): € ${i.detraibile.toFixed(2)}`, 20, y); y += 7
    doc.setTextColor(0)
    doc.setFontSize(10)
    if (i.nonTracciabile > 0) { doc.text(`Quote non tracciabili (non detraibili): € ${i.nonTracciabile.toFixed(2)}`, 20, y); y += 6 }
    if (i.escluso > 0) { doc.text(`Servizi esclusi dalla detrazione (es. divise/materiale): € ${i.escluso.toFixed(2)}`, 20, y); y += 6 }
    y += 4

    doc.setFontSize(8.5)
    doc.setTextColor(110)
    const note = doc.splitTextToSize(
        'La detrazione delle spese (art. 15 TUIR) spetta solo per i pagamenti eseguiti con strumenti tracciabili (art. 1, c. 679-680, L. 160/2019). Il presente documento attesta i versamenti registrati dalla struttura nell\'anno solare indicato e non sostituisce la documentazione di spesa originale.',
        170,
    ) as string[]
    doc.text(note, 20, y)

    return Buffer.from(doc.output('arraybuffer'))
}

export function buildRicevutaPdf(i: RicevutaPdfInput) {
    const doc = new jsPDF()
    let y = 20

    doc.setFontSize(15)
    doc.text(i.struttura.denominazione || 'Ricevuta di pagamento', 20, y)
    y += 6
    doc.setFontSize(9)
    doc.setTextColor(110)
    const fiscali = [
        i.struttura.piva ? `P.IVA ${i.struttura.piva}` : null,
        i.struttura.codice_fiscale ? `CF ${i.struttura.codice_fiscale}` : null,
    ].filter(Boolean).join(' · ')
    if (fiscali) { doc.text(fiscali, 20, y); y += 5 }
    const indirizzo = [
        i.struttura.indirizzo,
        [i.struttura.cap, i.struttura.comune, i.struttura.provincia].filter(Boolean).join(' '),
    ].filter(Boolean).join(' — ')
    if (indirizzo) { doc.text(indirizzo, 20, y); y += 5 }
    doc.setTextColor(0)
    y += 7

    doc.setFontSize(16)
    doc.text(i.numero ? `RICEVUTA n. ${i.numero}/${i.anno}` : 'RICEVUTA DI PAGAMENTO (documento di cortesia)', 20, y)
    y += 7
    doc.setFontSize(9)
    doc.setTextColor(110)
    doc.text(`Emessa il ${i.emessaIl ?? new Date().toLocaleDateString('it-IT')}`, 20, y)
    y += 9
    doc.setTextColor(0)

    doc.setFontSize(11)
    if (i.intestatario?.nome) {
        doc.text(`Intestatario: ${i.intestatario.nome}${i.intestatario.codice_fiscale ? ` — CF ${i.intestatario.codice_fiscale}` : ''}`, 20, y)
        y += 7
    }
    doc.text(`Alunno: ${i.alunno || '—'}`, 20, y); y += 7
    doc.text(`Causale: ${i.descrizione || '—'}`, 20, y); y += 7
    if (i.periodo) { doc.text(`Mensilità/periodo: ${i.periodo}`, 20, y); y += 7 }
    y += 2

    doc.setFontSize(14)
    doc.text(`Importo: € ${i.importo.toFixed(2)} — PAGATO`, 20, y)
    y += 9

    doc.setFontSize(10)
    for (const inc of i.incassi) {
        const negativo = Number(inc.importo) < 0
        const label = negativo ? 'Storno' : (METODO_LABEL[inc.metodo ?? ''] ?? inc.metodo ?? '—')
        const quando = dataIt(inc.data_incasso)
        doc.text(`• ${negativo ? '−' : ''}€ ${Math.abs(Number(inc.importo)).toFixed(2)} — ${label}${quando ? ` il ${quando}` : ''}`, 24, y)
        y += 6
    }
    y += 4

    doc.setFontSize(9)
    doc.setTextColor(110)
    if (i.tracciabile) {
        doc.text('Pagamento eseguito con strumenti tracciabili (art. 1, c. 679, L. 160/2019).', 20, y)
        y += 5
    } else {
        doc.text('Pagamento con quote in contanti: importo non detraibile ai fini fiscali (art. 1, c. 679, L. 160/2019).', 20, y)
        y += 5
    }
    if (i.bollo && i.dicituraBollo) {
        const righe = doc.splitTextToSize(i.dicituraBollo, 170) as string[]
        doc.text(righe, 20, y)
        y += righe.length * 4.5 + 2
    }
    doc.text('Documento non fiscale. Per la fattura elettronica usare l’apposita funzione.', 20, y)

    return Buffer.from(doc.output('arraybuffer'))
}
