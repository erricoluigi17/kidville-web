import ExcelJS from 'exceljs'
import { jsPDF } from 'jspdf'
import { logEvento } from '@/lib/logging/logger'
import type { CellaStorico, DocumentoStorico } from './tipi'

const VERDE = 'FF1B5A41'
const BIANCO = 'FFFFFFFF'
const metriche = new jsPDF({ unit: 'pt' })
metriche.setFont('helvetica', 'normal').setFontSize(11)

/** Colonne Excel in caratteri standard (7px), metriche proporzionali e margine prudente. */
function lineeExcel(testo: string, larghezza: number): string[] {
  const limite = Math.max(12, (larghezza - 1) * 7 * .75)
  const misura = (s: string) => metriche.getTextWidth(s.replace(/\t/g, '    ')) * 1.12
  const linee: string[] = []
  let corrente = '', usata = 0
  for (const token of testo.match(/\r\n|\r|\n|[^\S\r\n]+|[^\s]+/gu) ?? []) {
    if (/^[\r\n]+$/.test(token)) { linee.push(corrente + token); corrente = ''; usata = 0; continue }
    const ampiezza = misura(token)
    // Una parola che entra nel foglio prosegue intera sulla riga successiva.
    if (!/^\s+$/.test(token) && ampiezza <= limite && usata > 0 && usata + ampiezza > limite) {
      linee.push(corrente); corrente = ''; usata = 0
    }
    for (const carattere of token) {
      const ampiezzaCarattere = misura(carattere)
      if (usata + ampiezzaCarattere > limite && corrente) { linee.push(corrente); corrente = ''; usata = 0 }
      corrente += carattere
      usata += ampiezzaCarattere
    }
  }
  linee.push(corrente)
  return linee
}

/** Frammenti esatti, inclusi spazi e a capo: Excel non mostra righe oltre 409 punti. */
function frammenti(valore: ExcelJS.CellValue, larghezza: number): ExcelJS.CellValue[] {
  if (typeof valore !== 'string') return [valore]
  const pezzi: string[] = [], linee = lineeExcel(valore, larghezza)
  for (let i = 0; i < linee.length; i += 24) pezzi.push(linee.slice(i, i + 24).join(''))
  return pezzi
}

/** Excel visualizza gli istanti nel giorno e nell'ora della scuola, senza dipendere dal server. */
function valoreExcel(valore: CellaStorico): { valore: ExcelJS.CellValue; formato?: string } {
  if (typeof valore !== 'string') return { valore }
  if (/^\d{4}-\d{2}-\d{2}$/.test(valore)) {
    const data = new Date(`${valore}T00:00:00Z`)
    if (Number.isFinite(data.getTime()) && data.toISOString().startsWith(valore)) return { valore: data, formato: 'dd/mm/yyyy' }
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(valore)) {
    const data = new Date(valore)
    if (Number.isFinite(data.getTime())) {
      const parti = new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(data)
      const n = (tipo: Intl.DateTimeFormatPartTypes) => Number(parti.find(p => p.type === tipo)?.value)
      return { valore: new Date(Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second'))), formato: 'dd/mm/yyyy hh:mm' }
    }
  }
  // Una stringa resta una stringa, anche se comincia con =, +, - oppure @.
  return { valore }
}

function formattaFoglio(foglio: ExcelJS.Worksheet, larghezze: number[], tabellare: boolean): void {
  foglio.columns = larghezze.map(width => ({ width }))
  foglio.views = [{ state: 'frozen', ySplit: 1, showGridLines: false }]
  // Nessuna riduzione automatica: una tabella larga prosegue su altri fogli A4.
  foglio.pageSetup = { paperSize: 9, orientation: tabellare ? 'landscape' : 'portrait', fitToPage: true, fitToWidth: 0, fitToHeight: 0, scale: 100, printTitlesRow: '1:1', printTitlesColumn: tabellare ? 'A:A' : undefined, margins: { left: .35, right: .35, top: .5, bottom: .5, header: .2, footer: .2 } }
  foglio.headerFooter.oddFooter = '&LPagina &P di &N&RKidville'
  if (tabellare && foglio.columnCount) foglio.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, foglio.rowCount), column: foglio.columnCount } }
  foglio.eachRow((riga, indice) => {
    let linee = 1
    riga.eachCell({ includeEmpty: true }, (cella, colonna) => {
      cella.font = { name: 'Calibri', size: 11, bold: indice === 1, color: { argb: indice === 1 ? BIANCO : 'FF202C27' } }
      cella.alignment = { wrapText: true, vertical: 'top' }
      cella.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: indice === 1 ? VERDE : indice % 2 ? 'FFF1F5F3' : BIANCO } }
      const testo = cella.value instanceof Date ? (cella.numFmt.includes('hh') ? '00/00/0000 00:00' : '00/00/0000') : String(cella.value ?? '')
      linee = Math.max(linee, lineeExcel(testo, larghezze[colonna - 1] ?? 20).length)
    })
    riga.height = Math.min(409, Math.max(indice === 1 ? 30 : 24, linee * 15 + 8))
  })
}

export async function creaExcelStorico(documento: DocumentoStorico): Promise<Uint8Array> {
  const libro = new ExcelJS.Workbook()
  libro.creator = 'Kidville'
  const riepilogo = libro.addWorksheet('Riepilogo')
  riepilogo.addRows([
    ['Storici e stampe', documento.titolo], ['Sede', documento.scuolaNome],
    ['Dal', valoreExcel(documento.dal).valore], ['Al', valoreExcel(documento.al).valore], ['Generato il', valoreExcel(documento.generatoIl).valore],
    ...documento.avvisi.map(a => ['Avvertenza', a]),
  ])
  riepilogo.getCell('B3').numFmt = riepilogo.getCell('B4').numFmt = 'dd/mm/yyyy'
  riepilogo.getCell('B5').numFmt = 'dd/mm/yyyy hh:mm'
  formattaFoglio(riepilogo, [22, 68], false)
  documento.sezioni.forEach((sezione, indice) => {
    const nome = `${indice + 1} ${sezione.titolo}`.replace(/[\\/?*\[\]:]/g, ' ').slice(0, 31).replace(/^'|'$/g, '')
    const foglio = libro.addWorksheet(nome)
    const larghezze = sezione.colonne.map(c => {
      const massima = Math.max(c.titolo.length, ...sezione.righe.slice(0, 200).map(r => String(r[c.chiave] ?? '').split(/\r?\n/).reduce((max, t) => Math.max(max, t.length), 0)))
      return Math.min(64, Math.max(12, massima + 3))
    })
    const registrazioni = sezione.righe.map(fonte => {
      const valori = sezione.colonne.map(c => valoreExcel(fonte[c.chiave] ?? null))
      const parti = valori.map((v, i) => frammenti(v.valore, larghezze[i]))
      return { valori, parti, numero: Math.max(1, ...parti.map(p => p.length)) }
    })
    const continuazioni = registrazioni.some(r => r.numero > 1)
    foglio.addRow([...sezione.colonne.map(c => c.titolo), ...(continuazioni ? ['Record', 'Parte'] : [])])
    registrazioni.forEach((registrazione, record) => {
      for (let parte = 0; parte < registrazione.numero; parte++) {
        const celle = registrazione.parti.map((pezzi, i) => pezzi[parte] ?? (
          ['data', 'alunno', 'classe', 'ora', 'materia'].includes(sezione.colonne[i].chiave) ? pezzi[0] : null))
        const riga = foglio.addRow([...celle, ...(continuazioni ? [record + 1, `${parte + 1}/${registrazione.numero}`] : [])])
        registrazione.valori.forEach((v, i) => { if (v.formato) riga.getCell(i + 1).numFmt = v.formato })
      }
    })
    if (continuazioni) larghezze.push(12, 12)
    formattaFoglio(foglio, larghezze, true)
  })
  const avvisi = documento.sezioni.flatMap(s => s.avvisi.map(a => [s.titolo, a]))
  if (avvisi.length) {
    const foglio = libro.addWorksheet('Avvertenze')
    foglio.addRows([['Sezione', 'Avvertenza'], ...avvisi])
    formattaFoglio(foglio, [36, 90], true)
  }
  const bytes = new Uint8Array(await libro.xlsx.writeBuffer())
  logEvento('registro', 'info', { operazione: 'storici/render-excel', n: documento.sezioni.length, byte: bytes.byteLength })
  return bytes
}
