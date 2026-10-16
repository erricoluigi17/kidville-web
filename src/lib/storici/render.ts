import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import sharp from 'sharp'
import type { SupabaseClient } from '@supabase/supabase-js'
import { applicaCartaIntestata } from '@/lib/carta/applica'
import { logEvento } from '@/lib/logging/logger'
import type { DocumentoStorico } from './tipi'
import { areaPdf, ImpaginazioneStoricoPdf, testoPdf, valorePdf } from './impaginazione-pdf'

export { creaExcelStorico } from './render-excel'

const BUCKET_ALLEGATI = new Set(['registro-allegati', 'pagelle', 'certificati-competenze', 'form_attachments', 'certificati-medici', 'sensitive_documents', 'fatture', 'avvisi_allegati', 'chat-allegati', 'gallery', 'news', 'protocollo'])

export async function creaPdfStorico(documento: DocumentoStorico, db: SupabaseClient): Promise<{ bytes: Uint8Array; avvisi: string[] }> {
  const impaginazione = new ImpaginazioneStoricoPdf(documento)
  const doc = impaginazione.doc
  const indice: Array<[string, number]> = []
  const avvisi = [...documento.avvisi, ...documento.sezioni.flatMap(s => s.avvisi)]
  impaginazione.nuovaPagina(documento.titolo, true)
  impaginazione.testo(`Generato il ${valorePdf(documento.generatoIl)}`, 'Storici e stampe')
  impaginazione.testo('Documento riservato allo staff autorizzato.')
  for (const avviso of [...new Set(avvisi)]) impaginazione.testo(avviso)
  for (const sezione of documento.sezioni) {
    indice.push([sezione.titolo, doc.getNumberOfPages() + 1])
    impaginazione.sezione(sezione)
    if (sezione.avvisi.length) {
      impaginazione.nuovaPagina(`${sezione.titolo}: avvertenze`)
      for (const avviso of sezione.avvisi) impaginazione.testo(avviso)
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
        const video = new ImpaginazioneStoricoPdf(documento)
        video.nuovaPagina('Video — scheda di riferimento', true)
        video.testo(allegato.nome, 'Riferimento')
        video.testo('Video conservato nella relativa scheda della galleria o della news. La raccolta cartacea riporta il riferimento.', 'Consultazione')
        indice.push([`Video: ${allegato.nome}`, finale.getPageCount() + 1])
        const schedaPdf = await PDFDocument.load(await applicaCartaIntestata(new Uint8Array(video.doc.output('arraybuffer'))))
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
  const sommario = new ImpaginazioneStoricoPdf(documento)
  sommario.nuovaPagina('Indice del dossier', true)
  for (const [titolo, pagina] of indice) sommario.testo(`${testoPdf(titolo)} · Pagina ${pagina}`)
  if (avvisi.length) {
    sommario.testo('Avvertenze di completezza')
    for (const avviso of [...new Set(avvisi)]) sommario.testo(avviso)
  }
  const indicePdf = await PDFDocument.load(await applicaCartaIntestata(new Uint8Array(sommario.doc.output('arraybuffer'))))
  for (const p of await finale.copyPages(indicePdf, indicePdf.getPageIndices())) finale.addPage(p)
  const font = await finale.embedFont(StandardFonts.Helvetica)
  const totale = finale.getPageCount()
  // La numerazione è un'aggiunta della raccolta; i file originali archiviati restano intatti.
  finale.getPages().forEach((p, i) => {
    const orizzontale = p.getWidth() > p.getHeight()
    const area = areaPdf(orizzontale)
    // Gli originali possono avere dimensioni diverse da A4: il riferimento si
    // adatta al loro foglio senza riscalarne o ridisegnarne i contenuti.
    p.drawText(`${i + 1} / ${totale}`, { x: area.sx / (orizzontale ? 297 : 210) * p.getWidth(), y: p.getHeight() * (1 - area.servizio / area.altezza), size: 7, font, color: rgb(.35, .35, .35) })
  })
  const bytes = await finale.save()
  logEvento('registro', 'info', { operazione: 'storici/pdf', esito: 'generato', n: totale, byte: bytes.byteLength })
  return { bytes, avvisi: [...new Set(avvisi)] }
}
