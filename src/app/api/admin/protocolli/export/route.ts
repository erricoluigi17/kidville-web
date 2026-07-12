import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import * as XLSX from 'xlsx'
import { jsPDF } from 'jspdf'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { resolveScuoleAttive } from '@/lib/auth/scope'
import { logScrittura } from '@/lib/audit/scrittura'
import { parseQuery } from '@/lib/validation/http'
import { zUuid, zDataYMD } from '@/lib/validation/common'
import { annoFiscale } from '@/lib/format/fiscal-date'
import { SCHEMA_MANCANTE } from '@/lib/protocolli/store'
import {
  TIPO_LABEL,
  dataOraItaliana,
  formatNumeroProtocollo,
  type TipoProtocollo,
} from '@/lib/protocolli/segnatura'
import { denominazioneScuola, rispostaErroreProtocollo } from '@/lib/protocolli/server'

// Export del registro (decisioni #13/#14): XLSX per elaborazioni + PDF
// impaginato per stampa/verifiche, sui filtri attivi (il "registro giornaliero"
// è l'export con da=a=giorno). Le righe annullate restano visibili con motivo
// (art. 54). logScrittura: convenzione dell'app sugli export di dati personali.

const getQuerySchema = z.object({
  formato: z.enum(['xlsx', 'pdf']).default('xlsx'),
  anno: z.preprocess(
    (v) => (v === '' || v === null ? undefined : v),
    z.coerce.number().int().min(2000).max(2100).optional()
  ),
  tipo: z.preprocess(
    (v) => (v === '' || v === null ? undefined : v),
    z.enum(['ingresso', 'uscita', 'interno']).optional()
  ),
  categoria_id: z.preprocess((v) => (v === '' || v === null ? undefined : v), zUuid.optional()),
  da: z.preprocess((v) => (v === '' || v === null ? undefined : v), zDataYMD.optional()),
  a: z.preprocess((v) => (v === '' || v === null ? undefined : v), zDataYMD.optional()),
})

type RigaExport = {
  anno: number
  numero: number
  tipo: TipoProtocollo
  data_registrazione: string
  oggetto: string
  mittente: string | null
  destinatario: string | null
  mezzo: string | null
  rif_prot_mittente: string | null
  rif_data_mittente: string | null
  impronta_sha256: string
  allegati_descrizione: string | null
  emergenza: boolean
  annullata_at: string | null
  annullo_motivo: string | null
  categoria: { nome: string } | { nome: string }[] | null
}

const uno = <T,>(v: T | T[] | null | undefined): T | null =>
  Array.isArray(v) ? (v[0] ?? null) : (v ?? null)

function xlsxResponse(wb: XLSX.WorkBook, filename: string) {
  const rawBuffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as unknown
  const nb = rawBuffer as { buffer: ArrayBuffer; byteOffset: number; byteLength: number }
  const arrayBuffer = nb.buffer.slice(nb.byteOffset, nb.byteOffset + nb.byteLength)
  return new NextResponse(new Uint8Array(arrayBuffer as ArrayBuffer), {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  })
}

export async function GET(request: NextRequest) {
  try {
    const auth = await requireStaff(request, ['admin', 'segreteria'])
    if (auth.response) return auth.response
    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response

    const supabase = await createAdminClient()
    const sedi = await resolveScuoleAttive(request, supabase, auth.user)
    const anno = q.data.anno ?? annoFiscale()

    let righe: RigaExport[] = []
    if (sedi.length > 0) {
      // Accountability GDPR: l'export contiene dati personali (mittenti/destinatari).
      await logScrittura(supabase, {
        attore: auth.user,
        entitaTipo: 'export_protocolli',
        azione: 'insert',
        scuolaId: sedi[0] ?? null,
        valoreDopo: { formato: q.data.formato, anno, plessi: sedi },
      })

      let query = supabase
        .from('protocolli')
        .select(
          'anno, numero, tipo, data_registrazione, oggetto, mittente, destinatario, mezzo, ' +
            'rif_prot_mittente, rif_data_mittente, impronta_sha256, allegati_descrizione, ' +
            'emergenza, annullata_at, annullo_motivo, categoria:protocolli_categorie(nome)'
        )
        .in('scuola_id', sedi)
        .eq('anno', anno)
        .order('numero', { ascending: true })
        .limit(5000)
      if (q.data.tipo) query = query.eq('tipo', q.data.tipo)
      if (q.data.categoria_id) query = query.eq('categoria_id', q.data.categoria_id)
      if (q.data.da) query = query.gte('data_registrazione', `${q.data.da}T00:00:00`)
      if (q.data.a) query = query.lte('data_registrazione', `${q.data.a}T23:59:59.999`)

      const { data, error } = await query
      if (error && !SCHEMA_MANCANTE.has(error.code ?? '')) {
        return NextResponse.json({ error: error.message }, { status: 500 })
      }
      righe = (data as unknown as RigaExport[]) ?? []
      if (righe.length === 5000) {
        console.warn('Export protocolli: raggiunto il limite di 5000 righe, risultato troncato')
      }
    }

    const nomeBase = `registro-protocollo-${anno}${q.data.da ? `-dal-${q.data.da}` : ''}${q.data.a ? `-al-${q.data.a}` : ''}`

    if (q.data.formato === 'xlsx') {
      const rows = righe.map((r) => ({
        Numero: formatNumeroProtocollo(r.numero, r.anno),
        Data: dataOraItaliana(new Date(r.data_registrazione)).data,
        Ora: dataOraItaliana(new Date(r.data_registrazione)).ora,
        Tipo: TIPO_LABEL[r.tipo] ?? r.tipo,
        Oggetto: r.oggetto,
        Mittente: r.mittente ?? '',
        Destinatario: r.destinatario ?? '',
        Mezzo: r.mezzo ?? '',
        Categoria: uno(r.categoria)?.nome ?? '',
        'Prot. mittente': r.rif_prot_mittente ?? '',
        'Data doc. mittente': r.rif_data_mittente ?? '',
        Allegati: r.allegati_descrizione ?? '',
        Emergenza: r.emergenza ? 'Sì' : '',
        Stato: r.annullata_at ? `ANNULLATA: ${r.annullo_motivo ?? ''}` : 'Attiva',
        Impronta: r.impronta_sha256,
      }))
      const ws = XLSX.utils.json_to_sheet(rows)
      ws['!cols'] = [
        { wch: 14 }, { wch: 11 }, { wch: 6 }, { wch: 10 }, { wch: 48 }, { wch: 28 },
        { wch: 28 }, { wch: 14 }, { wch: 22 }, { wch: 14 }, { wch: 14 }, { wch: 24 },
        { wch: 10 }, { wch: 28 }, { wch: 40 },
      ]
      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, ws, `Protocollo ${anno}`)
      return xlsxResponse(wb, `${nomeBase}.xlsx`)
    }

    // PDF impaginato (orizzontale) con intestazione scuola e righe annullate evidenziate.
    const scuolaNome = sedi.length > 0 ? await denominazioneScuola(supabase, sedi[0]) : 'Kidville'
    const { default: autoTable } = await import('jspdf-autotable')
    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' })
    doc.setFillColor(0, 106, 95)
    doc.rect(0, 0, 297, 22, 'F')
    doc.setTextColor(253, 196, 0)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(14)
    doc.text(scuolaNome.toUpperCase(), 14, 10)
    doc.setTextColor(255, 255, 255)
    doc.setFontSize(11)
    const periodo =
      q.data.da || q.data.a
        ? ` (${q.data.da ? `dal ${q.data.da.split('-').reverse().join('/')}` : ''}${q.data.a ? ` al ${q.data.a.split('-').reverse().join('/')}` : ''})`
        : ''
    doc.text(`Registro di protocollo — Anno ${anno}${periodo}`, 14, 17)
    const generato = dataOraItaliana(new Date())
    doc.setFontSize(8)
    doc.text(`Generato il ${generato.data} alle ${generato.ora}`, 283, 17, { align: 'right' })

    autoTable(doc, {
      startY: 27,
      head: [['Numero', 'Data', 'Tipo', 'Oggetto', 'Mittente / Destinatario', 'Categoria', 'Stato']],
      body: righe.map((r) => {
        const quando = dataOraItaliana(new Date(r.data_registrazione))
        return [
          formatNumeroProtocollo(r.numero, r.anno),
          `${quando.data} ${quando.ora}`,
          TIPO_LABEL[r.tipo] ?? r.tipo,
          r.oggetto,
          r.mittente ?? r.destinatario ?? '',
          uno(r.categoria)?.nome ?? '',
          r.annullata_at
            ? `ANNULLATA: ${r.annullo_motivo ?? ''}`
            : r.emergenza
              ? 'Da emergenza'
              : '',
        ]
      }),
      styles: { font: 'helvetica', fontSize: 8, cellPadding: 1.6, overflow: 'linebreak' },
      headStyles: { fillColor: [0, 106, 95], textColor: [255, 255, 255], fontStyle: 'bold' },
      alternateRowStyles: { fillColor: [254, 241, 228] },
      columnStyles: {
        0: { cellWidth: 26 },
        1: { cellWidth: 26 },
        2: { cellWidth: 20 },
        3: { cellWidth: 90 },
        4: { cellWidth: 56 },
        5: { cellWidth: 32 },
        6: { cellWidth: 24 },
      },
      didParseCell: (hook) => {
        if (hook.section !== 'body') return
        const riga = righe[hook.row.index]
        if (riga?.annullata_at) {
          hook.cell.styles.textColor = [150, 150, 150]
          if (hook.column.index === 6) hook.cell.styles.fontStyle = 'bold'
        }
      },
    })

    const pdfBytes = new Uint8Array(doc.output('arraybuffer'))
    return new NextResponse(pdfBytes, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${nomeBase}.pdf"`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (err) {
    console.error('Errore API GET protocolli/export:', err)
    return rispostaErroreProtocollo(err)
  }
}
