import { jsPDF } from 'jspdf'
import autoTable from 'jspdf-autotable'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import * as XLSX from 'xlsx'
import sharp from 'sharp'
import type { SupabaseClient } from '@supabase/supabase-js'
import { applicaCartaIntestata } from '@/lib/carta/applica'
import { CARTA } from '@/lib/carta/geometria'
import { logEvento } from '@/lib/logging/logger'
import type { DocumentoStorico } from './tipi'

export function creaExcelStorico(documento: DocumentoStorico): Uint8Array {
  const libro = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(libro, XLSX.utils.aoa_to_sheet([
    ['Storici e stampe', documento.titolo], ['Sede', documento.scuolaNome],
    ['Dal', documento.dal], ['Al', documento.al], ['Generato il', documento.generatoIl],
    ...documento.avvisi.map(a => ['Avvertenza', a]),
  ]), 'Riepilogo')
  documento.sezioni.forEach((sezione, index) => {
    const righe = [sezione.colonne.map(c => c.titolo), ...sezione.righe.map(r => sezione.colonne.map(c => r[c.chiave] ?? ''))]
    // aoa_to_sheet conserva le stringhe come stringhe, comprese quelle che iniziano con =.
    const foglio = XLSX.utils.aoa_to_sheet(righe)
    foglio['!cols'] = sezione.colonne.map(() => ({ wch: 28 }))
    const nome = `${index + 1} ${sezione.titolo}`.replace(/[\\/?*\[\]:]/g, ' ').slice(0, 31)
    XLSX.utils.book_append_sheet(libro, foglio, nome)
  })
  const avvisi = documento.sezioni.flatMap(s => s.avvisi.map(a => [s.titolo, a]))
  if (avvisi.length) XLSX.utils.book_append_sheet(libro, XLSX.utils.aoa_to_sheet([['Sezione', 'Avvertenza'], ...avvisi]), 'Avvertenze')
  return new Uint8Array(XLSX.write(libro, { type: 'buffer', bookType: 'xlsx' }))
}

const testo = (v: unknown) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
const BUCKET_ALLEGATI = new Set(['registro-allegati', 'pagelle', 'certificati-competenze', 'form_attachments', 'certificati-medici', 'sensitive_documents', 'fatture', 'avvisi_allegati', 'chat-allegati', 'gallery', 'news', 'protocollo'])

export async function creaPdfStorico(documento: DocumentoStorico, db: SupabaseClient): Promise<{ bytes: Uint8Array; avvisi: string[] }> {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' })
  const indice: Array<[string, number]> = []
  const avvisi = [...documento.avvisi, ...documento.sezioni.flatMap(s => s.avvisi)]
  function testata(titolo: string) {
    doc.setFont('helvetica', 'bold').setFontSize(14)
    const righe = doc.splitTextToSize(testo(titolo), CARTA.margineDx - CARTA.margineSx)
    doc.text(righe, CARTA.margineSx, CARTA.contenutoInizio)
    const y = CARTA.contenutoInizio + righe.length * 6
    doc.setFont('helvetica', 'normal').setFontSize(9)
    doc.text(doc.splitTextToSize(`${documento.scuolaNome} · ${documento.dal} / ${documento.al}`, 166), CARTA.margineSx, y)
    return y + 9
  }
  const y = testata(documento.titolo)
  autoTable(doc, {
    startY: y, head: [['Storici e stampe']],
    body: [[`Generato il ${documento.generatoIl}`], ['Documento riservato allo staff autorizzato.'], ...avvisi.map(a => [testo(a)])],
    margin: { left: CARTA.margineSx, right: 22, top: CARTA.contenutoInizio, bottom: 34 },
    styles: { fontSize: 9, overflow: 'linebreak' }, headStyles: { fillColor: [27, 90, 65] },
  })
  for (const sezione of documento.sezioni) {
    doc.addPage()
    indice.push([sezione.titolo, doc.getNumberOfPages()])
    const startY = testata(sezione.titolo)
    autoTable(doc, {
      startY, head: [sezione.colonne.length ? sezione.colonne.map(c => testo(c.titolo)) : ['Contenuto']],
      body: sezione.righe.length ? sezione.righe.map(r => sezione.colonne.map(c => testo(r[c.chiave]))) : [['Nessuna registrazione disponibile nel periodo scelto.']],
      margin: { left: CARTA.margineSx, right: 22, top: CARTA.contenutoInizio, bottom: 34 },
      styles: { fontSize: 8, cellPadding: 2, overflow: 'linebreak' }, headStyles: { fillColor: [27, 90, 65] },
      didDrawPage: () => { doc.setFontSize(7); doc.text(testo(sezione.titolo), CARTA.margineSx, CARTA.contenutoInizio - 4) },
    })
    if (sezione.avvisi.length) {
      doc.addPage()
      autoTable(doc, { startY: testata(`${sezione.titolo}: avvertenze`), body: sezione.avvisi.map(a => [testo(a)]), margin: { left: CARTA.margineSx, right: 22, top: CARTA.contenutoInizio, bottom: 34 }, styles: { fontSize: 9 } })
    }
  }
  const generato = await applicaCartaIntestata(new Uint8Array(doc.output('arraybuffer')))
  const finale = await PDFDocument.load(generato)
  const gia = new Set<string>()
  const originali = documento.sezioni.flatMap(sezione => [
    ...sezione.allegati.map(a => ({ ...a, base64: null as string | null })),
    ...(sezione.generati ?? []).map(g => ({ bucket: 'generato', percorso: `${g.alunnoId ?? ''}/${g.nome}`, nome: g.nome, mime: g.mime, base64: g.base64 })),
  ])
  for (const allegato of originali) {
    const chiave = `${allegato.bucket}/${allegato.percorso}`
    if (gia.has(chiave)) continue
    gia.add(chiave)
    try {
      if (allegato.mime?.startsWith('video/') || /\.(mp4|mov|webm)$/i.test(allegato.nome)) {
        const scheda = new jsPDF({ unit: 'mm', format: 'a4' })
        scheda.setFontSize(14).text('Video — scheda di riferimento', CARTA.margineSx, CARTA.contenutoInizio)
        autoTable(scheda, { startY: CARTA.contenutoInizio + 9, head: [['Riferimento', 'Consultazione']], body: [[testo(allegato.nome), 'Video conservato nella relativa scheda della galleria o della news. La raccolta cartacea riporta il riferimento.']], margin: { left: CARTA.margineSx, right: 22, top: CARTA.contenutoInizio, bottom: 34 }, styles: { fontSize: 9, overflow: 'linebreak' }, headStyles: { fillColor: [27, 90, 65] } })
        indice.push([`Video: ${allegato.nome}`, finale.getPageCount() + 1])
        const schedaPdf = await PDFDocument.load(await applicaCartaIntestata(new Uint8Array(scheda.output('arraybuffer'))))
        for (const p of await finale.copyPages(schedaPdf, schedaPdf.getPageIndices())) finale.addPage(p)
        continue
      }
      let bytes: Uint8Array
      if (allegato.base64) bytes = new Uint8Array(Buffer.from(allegato.base64, 'base64'))
      else {
        if (!BUCKET_ALLEGATI.has(allegato.bucket) || !allegato.percorso || allegato.percorso.startsWith('/') || allegato.percorso.split('/').includes('..') || /^https?:/i.test(allegato.percorso)) throw new Error('Percorso allegato non ammesso')
        const { data, error } = await db.storage.from(allegato.bucket).download(allegato.percorso)
        if (error || !data) throw error ?? new Error('Allegato non disponibile')
        bytes = new Uint8Array(await data.arrayBuffer())
      }
      const paginaIniziale = finale.getPageCount() + 1
      if (bytes[0] === 0x25 && bytes[1] === 0x50) {
        const originale = await PDFDocument.load(bytes)
        const pagine = await finale.copyPages(originale, originale.getPageIndices())
        pagine.forEach(p => finale.addPage(p))
      } else {
        let png = bytes[0] === 0x89 && bytes[1] === 0x50
        const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8
        if (!png && !jpeg) {
          // La galleria conserva anche WebP; GIF/TIFF stampabili diventano una
          // copia PNG per la raccolta, senza alterare il file originale privato.
          bytes = new Uint8Array(await sharp(bytes, { limitInputPixels: 80_000_000 }).rotate().png().toBuffer())
          png = true
        }
        const immagine = png ? await finale.embedPng(bytes) : await finale.embedJpg(bytes)
        const pagina = finale.addPage([595.28, 841.89])
        const scala = Math.min(535 / immagine.width, 740 / immagine.height)
        const larghezza = immagine.width * scala, altezza = immagine.height * scala
        pagina.drawImage(immagine, { x: (595.28 - larghezza) / 2, y: (841.89 - altezza) / 2, width: larghezza, height: altezza })
      }
      indice.push([`Allegato: ${allegato.nome}`, paginaIniziale])
    } catch (error) {
      avvisi.push(`Originale non incorporato: ${allegato.nome}. Consultare il documento nella sua scheda.`)
      logEvento('registro', 'warn', { operazione: 'storici/allegato', esito: 'originale-non-incorporato', bucket: allegato.bucket }, error)
    }
  }
  const toc = new jsPDF({ unit: 'mm', format: 'a4' })
  toc.setFontSize(14).text('Indice del dossier', CARTA.margineSx, CARTA.contenutoInizio)
  autoTable(toc, { startY: CARTA.contenutoInizio + 8, head: [['Sezione o allegato', 'Pagina']], body: indice.map(([titolo, pagina]) => [testo(titolo), String(pagina)]), margin: { left: CARTA.margineSx, right: 22, top: CARTA.contenutoInizio, bottom: 34 }, styles: { fontSize: 9 }, headStyles: { fillColor: [27, 90, 65] } })
  if (avvisi.length) {
    toc.addPage()
    autoTable(toc, { startY: CARTA.contenutoInizio, head: [['Avvertenze di completezza']], body: [...new Set(avvisi)].map(a => [testo(a)]), margin: { left: CARTA.margineSx, right: 22, top: CARTA.contenutoInizio, bottom: 34 }, styles: { fontSize: 9 } })
  }
  const indicePdf = await PDFDocument.load(await applicaCartaIntestata(new Uint8Array(toc.output('arraybuffer'))))
  for (const p of await finale.copyPages(indicePdf, indicePdf.getPageIndices())) finale.addPage(p)
  const font = await finale.embedFont(StandardFonts.Helvetica)
  const totale = finale.getPageCount()
  // La numerazione è un'aggiunta della raccolta; i file originali archiviati restano intatti.
  finale.getPages().forEach((p, i) => p.drawText(`${i + 1} / ${totale}`, { x: 24, y: 15, size: 7, font, color: rgb(.35, .35, .35) }))
  return { bytes: await finale.save(), avvisi: [...new Set(avvisi)] }
}
