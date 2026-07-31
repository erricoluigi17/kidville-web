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
import { rispostaErroreProtocollo } from '@/lib/protocolli/server'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'

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
  scuola_id: string
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

export const GET = withRoute('admin/protocolli/export:GET', async (request: NextRequest) => {
    try {
      const auth = await requireStaff(request, ['admin', 'segreteria'])
      if (auth.response) return auth.response
      const q = parseQuery(request, getQuerySchema)
      if ('response' in q) return q.response

      const supabase = await createAdminClient()
      const sedi = await resolveScuoleAttive(request, supabase, auth.user)
      const anno = q.data.anno ?? annoFiscale()

      // Scope vuoto ⇒ si nega. Prima usciva un file VUOTO intestato a `'Kidville'`:
      // un registro di protocollo senza sede non è un documento, è un equivoco.
      if (sedi.length === 0) {
        logEvento('protocolli', 'warn', {
          operazione: 'admin/protocolli/export:GET',
          esito: 'export-senza-perimetro',
          utente: auth.user.id,
          ruolo: auth.user.role,
        })
        return NextResponse.json(
          { error: 'Nessuna sede selezionata: impossibile intestare il registro' },
          { status: 403 }
        )
      }

      // ── Le sedi hanno un NOME, e il documento lo deve dire ──────────────────
      // `protocolli` è UNIQUE su `(scuola_id, anno, numero)`: la numerazione
      // riparte da 1 in ogni plesso. Fino al 2026-07-31 l'export multi-sede
      // stampava numeri DUPLICATI senza una colonna che dicesse a chi
      // appartenessero, e intestava il tutto a `denominazioneScuola(sedi[0])`
      // (col ripiego al letterale `'Kidville'`): un documento di rilevanza
      // amministrativa — DPR 445 — che risultava falso.
      const { data: scuole, error: scuoleErr } = await supabase
        .from('schools')
        .select('id, nome')
        .in('id', sedi)
      if (scuoleErr) {
        // PostgREST non lancia: senza questo controllo il registro uscirebbe
        // senza intestazione e senza colonna sede, cioè di nuovo falso.
        logEvento('protocolli', 'error', {
          operazione: 'admin/protocolli/export:GET',
          esito: 'denominazioni-sedi-non-risolte',
          sedi: sedi.length,
        }, scuoleErr)
        return rispostaErroreProtocollo(scuoleErr)
      }
      const nomiPerSede = new Map<string, string>()
      for (const s of scuole ?? []) {
        const nome = String((s as { nome?: string }).nome ?? '').trim()
        if (nome) nomiPerSede.set(String((s as { id: string }).id), nome)
      }
      if (nomiPerSede.size !== sedi.length) {
        // Configurazione incompleta di una sede: va vista (F12), non ignorata.
        logEvento('protocolli', 'error', {
          operazione: 'admin/protocolli/export:GET',
          esito: 'sede-senza-denominazione',
          sedi: sedi.length,
          risolte: nomiPerSede.size,
        })
      }
      const nomeSede = (id: string) => nomiPerSede.get(id) ?? 'Sede senza denominazione'
      const sediOrdinate = [...sedi].sort((a, b) => nomeSede(a).localeCompare(nomeSede(b), 'it'))
      const intestazione = sediOrdinate.map(nomeSede).join(' · ')

      let righe: RigaExport[] = []
      // Accountability GDPR: l'export contiene dati personali (mittenti/destinatari).
      // UNA riga per SEDE: con `sedi[0]` la colonna `scuolaId` diceva che l'export
      // riguardava un plesso solo anche quando ne copriva tre.
      for (const sede of sediOrdinate) {
        await logScrittura(supabase, {
          attore: auth.user,
          entitaTipo: 'export_protocolli',
          azione: 'insert',
          scuolaId: sede,
          valoreDopo: { formato: q.data.formato, anno, plessi: sedi },
        })
      }

      let query = supabase
        .from('protocolli')
        .select(
          'scuola_id, anno, numero, tipo, data_registrazione, oggetto, mittente, destinatario, mezzo, ' +
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
      // Sede prima, numero poi: così il registro si legge plesso per plesso e
      // due «n. 1» non finiscono incolonnati uno sotto l'altro.
      righe = [...righe].sort(
        (x, y) =>
          nomeSede(String(x.scuola_id)).localeCompare(nomeSede(String(y.scuola_id)), 'it') ||
          x.anno - y.anno ||
          x.numero - y.numero
      )
      if (righe.length === 5000) {
        // Soglia, non guasto: l'export esce (200) ma TRONCATO — chi lo scarica crede di
        // avere il registro intero. `warn`, con i contatori, perché va contato nel tempo:
        // quando ricorre, il limite va alzato o l'export paginato.
        logEvento('protocolli', 'warn', {
          operazione: 'admin/protocolli/export:GET',
          esito: 'export-troncato-al-limite',
          righe: righe.length,
          limite: 5000,
          anno,
          formato: q.data.formato,
        })
      }

      const nomeBase = `registro-protocollo-${anno}${q.data.da ? `-dal-${q.data.da}` : ''}${q.data.a ? `-al-${q.data.a}` : ''}`

      if (q.data.formato === 'xlsx') {
        const rows = righe.map((r) => ({
          // La sede in TESTA: è la chiave che disambigua il numero, non un dettaglio.
          Sede: nomeSede(String(r.scuola_id)),
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
          { wch: 22 }, { wch: 14 }, { wch: 11 }, { wch: 6 }, { wch: 10 }, { wch: 48 },
          { wch: 28 }, { wch: 28 }, { wch: 14 }, { wch: 22 }, { wch: 14 }, { wch: 14 },
          { wch: 24 }, { wch: 10 }, { wch: 28 }, { wch: 40 },
        ]
        const wb = XLSX.utils.book_new()
        XLSX.utils.book_append_sheet(wb, ws, `Protocollo ${anno}`)
        return xlsxResponse(wb, `${nomeBase}.xlsx`)
      }

      // PDF impaginato (orizzontale) con intestazione scuola e righe annullate evidenziate.
      // L'intestazione elenca TUTTE le sedi esportate: intestarlo alla prima
      // significava firmare un registro che conteneva i numeri di altri plessi.
      const { default: autoTable } = await import('jspdf-autotable')
      const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' })
      doc.setFillColor(0, 106, 95)
      doc.rect(0, 0, 297, 22, 'F')
      doc.setTextColor(253, 196, 0)
      doc.setFont('helvetica', 'bold')
      doc.setFontSize(sediOrdinate.length > 2 ? 11 : 14)
      doc.text(intestazione.toUpperCase(), 14, 10)
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
        head: [['Sede', 'Numero', 'Data', 'Tipo', 'Oggetto', 'Mittente / Destinatario', 'Categoria', 'Stato']],
        body: righe.map((r) => {
          const quando = dataOraItaliana(new Date(r.data_registrazione))
          return [
            nomeSede(String(r.scuola_id)),
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
          0: { cellWidth: 30 },
          1: { cellWidth: 24 },
          2: { cellWidth: 24 },
          3: { cellWidth: 18 },
          4: { cellWidth: 72 },
          5: { cellWidth: 48 },
          6: { cellWidth: 28 },
          7: { cellWidth: 24 },
        },
        didParseCell: (hook) => {
          if (hook.section !== 'body') return
          const riga = righe[hook.row.index]
          if (riga?.annullata_at) {
            hook.cell.styles.textColor = [150, 150, 150]
            if (hook.column.index === 7) hook.cell.styles.fontStyle = 'bold'
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
      logErrore({ operazione: 'admin/protocolli/export:GET', stato: 500 }, err)
      return rispostaErroreProtocollo(err)
    }
})
