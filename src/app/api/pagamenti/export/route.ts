import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import * as XLSX from 'xlsx'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { resolveScuoleAttive } from '@/lib/auth/scope'

// ─── Schemi di validazione input ─────────────────────────────────────────────
const zUuidQueryOpzionale = z.preprocess((v) => (v === '' ? undefined : v), zUuid.optional())

const getQuerySchema = z.object({
  tipo: z.enum(['scadenzario']),
  scuola_id: zUuidQueryOpzionale,
  stato: z.string().optional(),
  categoria_id: zUuidQueryOpzionale,
})

const STATO_LABEL: Record<string, string> = {
  da_pagare: 'Da pagare', parziale: 'Parziale', pagato: 'Pagato', scaduto: 'Scaduto',
}
const FATTURA_LABEL: Record<string, string> = {
  non_richiesta: 'Da fatturare', in_attesa: 'In attesa SDI', emessa: 'Fatturata', scartata: 'Scartata',
}

interface RigaPagamento {
  descrizione: string
  importo: number
  importo_pagato: number | null
  scadenza: string | null
  periodo_competenza: string | null
  stato: string
  tipo: string
  fattura_stato: string | null
  alunni?: { nome?: string; cognome?: string; classe_sezione?: string | null } | null
  payment_categories?: { nome?: string } | null
}

// GET /api/pagamenti/export?tipo=scadenzario — XLSX per la segreteria/commercialista
export async function GET(request: NextRequest) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const { user } = auth

    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const { scuola_id: scuolaId, stato, categoria_id: categoriaId } = q.data

    const supabase = await createAdminClient()
    const sediAttive = await resolveScuoleAttive(request, supabase, user)

    let query = supabase
      .from('pagamenti')
      .select(`
        descrizione, importo, importo_pagato, scadenza, periodo_competenza, stato, tipo, fattura_stato,
        payment_categories ( nome ),
        alunni ( nome, cognome, classe_sezione )
      `)
      .in('scuola_id', sediAttive)
      .order('scadenza', { ascending: true })
    if (scuolaId && sediAttive.includes(scuolaId)) query = query.eq('scuola_id', scuolaId)
    if (stato) query = query.eq('stato', stato)
    if (categoriaId) query = query.eq('categoria_id', categoriaId)

    const { data, error } = await query
    if (error) {
      console.error('Errore export pagamenti:', error)
      return NextResponse.json({ error: 'Errore nel recupero dei pagamenti' }, { status: 500 })
    }

    // I contenitori padre non sono voci esigibili: nell'export contano le rate.
    const righe = ((data || []) as unknown as RigaPagamento[])
      .filter((p) => p.tipo !== 'padre')
      .map((p) => ({
        Alunno: [p.alunni?.nome, p.alunni?.cognome].filter(Boolean).join(' '),
        Sezione: p.alunni?.classe_sezione ?? '',
        Categoria: p.payment_categories?.nome ?? '',
        Descrizione: p.descrizione,
        Scadenza: p.scadenza ?? '',
        'Importo €': Number(p.importo),
        'Pagato €': Number(p.importo_pagato || 0),
        'Residuo €': Math.max(0, Number(p.importo) - Number(p.importo_pagato || 0)),
        Stato: STATO_LABEL[p.stato] ?? p.stato,
        Fattura: p.stato === 'pagato' ? (FATTURA_LABEL[p.fattura_stato ?? 'non_richiesta'] ?? '') : '',
      }))

    const ws = XLSX.utils.json_to_sheet(righe)
    ws['!cols'] = [{ wch: 24 }, { wch: 12 }, { wch: 12 }, { wch: 34 }, { wch: 12 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 14 }]
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Scadenzario')

    // SheetJS ritorna Buffer in Node: cast ad ArrayBuffer per NextResponse
    const rawBuffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as unknown
    const nodeBuffer = rawBuffer as { buffer: ArrayBuffer; byteOffset: number; byteLength: number }
    const arrayBuffer = nodeBuffer.buffer.slice(nodeBuffer.byteOffset, nodeBuffer.byteOffset + nodeBuffer.byteLength)
    const blob = new Blob([new Uint8Array(arrayBuffer as ArrayBuffer)], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    })

    const oggi = new Date().toISOString().slice(0, 10)
    return new NextResponse(blob, {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="scadenzario-${oggi}.xlsx"`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (err) {
    console.error('Errore API export pagamenti:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
