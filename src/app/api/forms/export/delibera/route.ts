import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { jsPDF } from 'jspdf'
import { parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore } from '@/lib/logging/logger'

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
const getQuerySchema = z.object({
  modelId: zUuid,
})

const ESITO_LABEL: Record<string, string> = {
  ammesso: 'AMMESSO',
  lista_attesa: "LISTA D'ATTESA",
  non_ammesso: 'NON AMMESSO',
}

function candidatoLabel(data: Record<string, unknown>): string {
  const nome = (data['nome_alunno'] ?? data['child_first_name'] ?? data['nome'] ?? '') as string
  const cognome = (data['cognome_alunno'] ?? data['child_last_name'] ?? data['cognome'] ?? '') as string
  if (nome || cognome) return `${cognome} ${nome}`.trim()
  const pn = (data['parent_first_name'] ?? data['nome_genitore'] ?? '') as string
  const ps = (data['parent_last_name'] ?? data['cognome_genitore'] ?? '') as string
  return `${ps} ${pn}`.trim() || 'Candidato'
}

// GET /api/forms/export/delibera?modelId=&userId=  (staff) — PDF della delibera (DL-025).
export const GET = withRoute('forms/export/delibera:GET', async (request: Request) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const { modelId } = q.data

    const supabase = await createAdminClient()
    const { data: model } = await supabase.from('form_models').select('title').eq('id', modelId).maybeSingle()
    if (!model) return NextResponse.json({ error: 'Modello non trovato' }, { status: 404 })
    const { data: subs } = await supabase
      .from('form_submissions')
      .select('id, score, esito_ammissione, data')
      .eq('model_id', modelId)
      .eq('status', 'completed')
      .order('score', { ascending: false })

    const righe = (subs ?? []) as { id: string; score: number; esito_ammissione: string | null; data: Record<string, unknown> }[]
    const titolo = (model as { title?: string } | null)?.title ?? 'Modulo'

    const doc = new jsPDF()
    doc.setFontSize(16)
    doc.text('Kidville — Delibera di ammissione', 20, 22)
    doc.setFontSize(11)
    doc.setTextColor(90)
    doc.text(titolo, 20, 30)
    doc.text(`Data delibera: ${new Date().toISOString().slice(0, 10)}`, 20, 37)

    // intestazione tabella
    doc.setTextColor(0)
    doc.setFontSize(9)
    let y = 50
    doc.text('Pos.', 20, y)
    doc.text('Candidato', 36, y)
    doc.text('Punti', 140, y)
    doc.text('Esito', 162, y)
    doc.setDrawColor(200)
    doc.line(20, y + 2, 190, y + 2)
    y += 9

    righe.forEach((r, i) => {
      if (y > 270) { doc.addPage(); y = 22 }
      doc.text(String(i + 1), 20, y)
      doc.text(candidatoLabel(r.data ?? {}).slice(0, 55), 36, y)
      doc.text(String(r.score ?? 0), 140, y)
      doc.text(ESITO_LABEL[r.esito_ammissione ?? ''] ?? '—', 162, y)
      y += 7
    })

    y = Math.min(y + 16, 285)
    doc.setTextColor(120)
    doc.setFontSize(9)
    doc.text('Il Dirigente Scolastico __________________________', 20, y)

    const pdf = Buffer.from(doc.output('arraybuffer'))
    return new NextResponse(pdf, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="delibera-${modelId.slice(0, 8)}.pdf"`,
      },
    })
  } catch (err) {
    logErrore({ operazione: 'forms/export/delibera:GET', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
