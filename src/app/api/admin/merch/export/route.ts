import { NextResponse } from 'next/server'
import { z } from 'zod'
import * as XLSX from 'xlsx'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { scuoleDiUtente } from '@/lib/auth/scope'
import { parseQuery } from '@/lib/validation/http'

// GET /api/admin/merch/export — XLSX flat delle righe Merchandise (una riga per
// riga d'ordine) per segreteria/magazzino. Degrada a foglio vuoto su DB non migrato.

const SCHEMA_MANCANTE = new Set(['42P01', '42703', 'PGRST204', 'PGRST205'])
const getQuerySchema = z.object({})
const uno = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null))

const STATO_LABEL: Record<string, string> = {
  da_ordinare: 'Da ordinare', ordinato: 'Ordinato', arrivato: 'Arrivato', consegnato: 'Consegnato', annullato: 'Annullato',
}
const dataIt = (s?: string | null) => (s ? new Date(s).toLocaleDateString('it-IT') : '')

interface OrdineEmbed {
  scuola_id?: string | null
  creato_il?: string | null
  alunni?: { nome?: string; cognome?: string; classe_sezione?: string | null } | { nome?: string; cognome?: string; classe_sezione?: string | null }[] | null
  pagamento?: { stato?: string | null } | { stato?: string | null }[] | null
}
interface RigaExport {
  articolo_nome: string; taglia: string | null; quantita: number; prezzo_unitario: number
  stato?: string | null; origine?: string | null; ordinato_il?: string | null; arrivato_il?: string | null; consegnato_il?: string | null
  ordine_fornitore?: { numero?: string | null } | { numero?: string | null }[] | null
  ordine?: OrdineEmbed | OrdineEmbed[] | null
}

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

export async function GET(request: Request) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response

    const supabase = await createAdminClient()
    const plessi = await scuoleDiUtente(supabase, auth.user)
    const oggi = new Date().toISOString().slice(0, 10)
    if (plessi.length === 0) {
      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([]), 'Merchandise')
      return xlsxResponse(wb, `merchandise-${oggi}.xlsx`)
    }

    const { data, error } = await supabase
      .from('divise_ordini_righe')
      .select('articolo_nome, taglia, quantita, prezzo_unitario, stato, origine, ordinato_il, arrivato_il, consegnato_il, ' +
        'ordine_fornitore:ordine_fornitore_id ( numero ), ' +
        'ordine:ordine_id ( scuola_id, creato_il, alunni:alunno_id ( nome, cognome, classe_sezione ), pagamento:pagamento_id ( stato ) )')
      .limit(5000)
    const righe = error
      ? (SCHEMA_MANCANTE.has(error.code ?? '') ? [] : null)
      : ((data as unknown as RigaExport[]) ?? []).filter((r) => {
          const sc = uno(r.ordine)?.scuola_id
          return sc != null && plessi.includes(sc)
        })
    if (righe === null) return NextResponse.json({ error: error?.message }, { status: 500 })

    const rows = righe.map((r) => {
      const o = uno(r.ordine)
      const al = uno(o?.alunni)
      const pag = uno(o?.pagamento)
      return {
        Alunno: [al?.nome, al?.cognome].filter(Boolean).join(' '),
        Sezione: al?.classe_sezione ?? '',
        Articolo: r.articolo_nome,
        Taglia: r.taglia ?? '',
        'Q.tà': Number(r.quantita),
        'Prezzo €': Number(r.prezzo_unitario),
        'Totale €': Number(r.prezzo_unitario) * Number(r.quantita),
        Stato: STATO_LABEL[String(r.stato ?? 'da_ordinare')] ?? r.stato ?? '',
        Origine: r.origine ?? 'fornitore',
        PO: uno(r.ordine_fornitore)?.numero ?? '',
        Pagamento: pag?.stato ?? '',
        'Data ordine': dataIt(o?.creato_il),
        Ordinato: dataIt(r.ordinato_il),
        Arrivato: dataIt(r.arrivato_il),
        Consegnato: dataIt(r.consegnato_il),
      }
    })

    const ws = XLSX.utils.json_to_sheet(rows)
    ws['!cols'] = [{ wch: 22 }, { wch: 10 }, { wch: 22 }, { wch: 8 }, { wch: 6 }, { wch: 10 }, { wch: 10 }, { wch: 12 }, { wch: 10 }, { wch: 12 }, { wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 }]
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Merchandise')
    return xlsxResponse(wb, `merchandise-${oggi}.xlsx`)
  } catch (err) {
    console.error('Errore API GET merch/export:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
