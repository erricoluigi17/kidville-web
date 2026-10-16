import { jsPDF } from 'jspdf'
import autoTable from 'jspdf-autotable'
import { CARTA, fasceVietate } from '@/lib/carta/geometria'
import type { ColonnaStorico, DocumentoStorico, SezioneStorico } from './tipi'

export const testoPdf = (v: unknown) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')

/** Le date archiviate restano intatte; solo la loro rappresentazione è italiana. */
export function valorePdf(v: unknown): string {
  if (typeof v === 'boolean') return v ? 'Sì' : 'No'
  const s = testoPdf(v)
  const giorno = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (giorno) return `${giorno[3]}/${giorno[2]}/${giorno[1]}`
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) {
    const d = new Date(s)
    if (Number.isFinite(d.getTime())) return new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d)
  }
  const date = s.split(/\s*;\s*/)
  if (date.length > 1 && date.every(d => /^\d{4}-\d{2}-\d{2}(T.*)?$/.test(d))) return date.map(valorePdf).join('; ')
  return s
}

/** La carta orizzontale ha logo e piede ai lati, non in testa e in fondo. */
export function areaPdf(orizzontale: boolean) {
  const { marchio, piede } = fasceVietate(297, 210)
  return orizzontale
    ? { sx: marchio.sinistra + marchio.larghezza + 4, dx: piede.sinistra - 4, titoloY: 16, fondo: 195, altezza: 210, servizio: 201 }
    : { sx: CARTA.margineSx, dx: CARTA.margineDx, titoloY: CARTA.contenutoInizio, fondo: CARTA.contenutoFine, altezza: 297, servizio: CARTA.rigaServizio }
}

/** Flusso dei contenuti descrittivi: righe intere, corpo fisso e nessun taglio. */
export class ImpaginazioneStoricoPdf {
  readonly doc = new jsPDF({ unit: 'mm', format: 'a4' })
  private y = 0
  private titolo = ''
  private riferimento = ''

  constructor(private documento: Pick<DocumentoStorico, 'scuolaNome' | 'dal' | 'al'>) {}

  private testata(titolo: string, disegna = true): number {
    const area = areaPdf(this.doc.internal.pageSize.getWidth() > this.doc.internal.pageSize.getHeight())
    const larghezza = area.dx - area.sx
    this.doc.setFont('helvetica', 'bold').setFontSize(15)
    const righe = this.doc.splitTextToSize(testoPdf(titolo), larghezza) as string[]
    if (disegna) this.doc.text(righe, area.sx, area.titoloY, { lineHeightFactor: 1.2 })
    const y = area.titoloY + righe.length * 6.35
    this.doc.setFont('helvetica', 'normal').setFontSize(10)
    const contesto = this.doc.splitTextToSize(`${this.documento.scuolaNome} · ${valorePdf(this.documento.dal)} / ${valorePdf(this.documento.al)}`, larghezza) as string[]
    if (disegna) this.doc.text(contesto, area.sx, y, { lineHeightFactor: 1.2 })
    return y + contesto.length * 4.24 + 5
  }

  nuovaPagina(titolo: string, prima = false) {
    if (!prima) this.doc.addPage('a4', 'portrait')
    this.titolo = titolo
    this.riferimento = ''
    this.y = this.testata(titolo)
  }

  private continua() {
    this.doc.addPage('a4', 'portrait')
    this.y = this.testata(this.titolo)
    if (this.riferimento) {
      this.doc.setFont('helvetica', 'bold').setFontSize(11)
      this.doc.text(`${this.riferimento} (continua)`, CARTA.margineSx, this.y)
      this.y += 7
    }
    this.doc.setFont('helvetica', 'normal').setFontSize(10)
  }

  testo(valore: unknown, titolo?: string) {
    const area = areaPdf(false)
    this.doc.setFont('helvetica', 'normal').setFontSize(10)
    const righe = this.doc.splitTextToSize(valorePdf(valore) || '—', area.dx - area.sx) as string[]
    // L'etichetta e le prime righe del blocco restano sullo stesso foglio.
    if (this.y + (titolo ? 6 : 0) + Math.min(2, righe.length) * 5 > area.fondo) this.continua()
    if (titolo) {
      this.doc.setFont('helvetica', 'bold').setFontSize(10)
      const etichetta = this.doc.splitTextToSize(testoPdf(titolo), area.dx - area.sx) as string[]
      for (const riga of etichetta) {
        if (this.y + 5 > area.fondo) this.continua()
        this.doc.text(riga, area.sx, this.y)
        this.y += 5
      }
    }
    this.doc.setFont('helvetica', 'normal').setFontSize(10)
    for (const riga of righe) {
      if (this.y + 5 > area.fondo) {
        this.continua()
        if (titolo) {
          this.doc.setFont('helvetica', 'bold').setFontSize(10)
          this.doc.text(`${titolo} (continua)`, area.sx, this.y)
          this.y += 6
          this.doc.setFont('helvetica', 'normal').setFontSize(10)
        }
      }
      this.doc.text(riga, area.sx, this.y)
      this.y += 5
    }
    this.y += 3
  }

  private schede(sezione: SezioneStorico, colonne = sezione.colonne, riepilogo: ColonnaStorico[] = []) {
    sezione.righe.forEach((riga, i) => {
      if (this.y + 25 > CARTA.contenutoFine) this.continua()
      this.riferimento = `Registrazione ${i + 1}`
      this.doc.setFont('helvetica', 'bold').setFontSize(12).setTextColor(27, 90, 65)
      this.doc.text(this.riferimento, CARTA.margineSx, this.y)
      this.doc.setTextColor(0)
      this.y += 8
      for (const c of [...riepilogo, ...colonne]) {
        const valore = valorePdf(riga[c.chiave])
        const lungo = valore.length > 120 || /[\r\n]/.test(valore) || /^(argomento|compiti|testo|nota|note|contenuto|corpo|descrizione)$/i.test(c.chiave)
        if (lungo) this.testo(valore, c.titolo)
        else this.testo(`${c.titolo}: ${valore || '—'}`)
      }
      this.riferimento = ''
      this.y += 4
    })
  }

  sezione(sezione: SezioneStorico) {
    const narrativa = sezione.categoria.startsWith('diario_') || sezione.colonne.some(c => /^(argomento|compiti)$/.test(c.chiave)) || sezione.categoria === 'primaria_note'
    if (!sezione.righe.length || !sezione.colonne.length || narrativa) {
      this.nuovaPagina(sezione.titolo)
      if (!sezione.righe.length || !sezione.colonne.length) this.testo(sezione.allegati.length || sezione.generati?.length
        ? 'Nessuna registrazione tabellare; gli allegati sono inclusi nella raccolta, con eventuali avvertenze di completezza nell’indice.'
        : 'Nessuna registrazione disponibile nel periodo scelto.')
      else this.schede(sezione)
      return
    }
    const estese = sezione.colonne.filter(c => sezione.righe.some(r => valorePdf(r[c.chiave]).length > 120 || /[\r\n]/.test(valorePdf(r[c.chiave]))))
    const compatte = sezione.colonne.filter(c => !estese.includes(c))
    const tabella = compatte.slice(0, 7)
    const dettagli = [...compatte.slice(7), ...estese]
    if (tabella.length) {
      this.doc.addPage('a4', 'landscape')
      const area = areaPdf(true)
      const startY = this.testata(sezione.titolo, false)
      autoTable(this.doc, {
        startY,
        head: [[...(dettagli.length ? ['N.'] : []), ...tabella.map(c => testoPdf(c.titolo))]],
        body: sezione.righe.map((r, i) => [...(dettagli.length ? [String(i + 1)] : []), ...tabella.map(c => valorePdf(r[c.chiave]))]),
        margin: { left: area.sx, right: 297 - area.dx, top: startY, bottom: area.altezza - area.fondo },
        styles: { fontSize: 10, cellPadding: 2, overflow: 'linebreak', valign: 'top' },
        headStyles: { fillColor: [27, 90, 65], fontSize: 10 },
        showHead: 'everyPage',
        rowPageBreak: 'avoid',
        willDrawPage: () => { this.testata(sezione.titolo) },
      })
    }
    if (dettagli.length) {
      this.nuovaPagina(`${sezione.titolo} · Dettagli delle registrazioni`)
      this.schede(sezione, dettagli, tabella.slice(0, 3))
    }
  }
}
