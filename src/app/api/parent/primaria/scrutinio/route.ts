import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireParentOfStudent } from '@/lib/auth/require-parent'
import { parseQuery } from '@/lib/validation/http'

// Id laschi (non zUuid): il comportamento attuale accetta qualsiasi stringa non
// vuota (il lookup su `scrutini` fa da gate con 404; uno studentId inesistente
// ricade nel ramo { firmato: false }).
const getQuerySchema = z.object({
  scrutinioId: z.string({ error: 'scrutinioId obbligatorio' }).min(1, 'scrutinioId obbligatorio'),
  studentId: z.string({ error: 'studentId obbligatorio' }).min(1, 'studentId obbligatorio'),
})

// GET /api/parent/primaria/scrutinio?scrutinioId=&studentId=&userId=
// Vista a schermo dello scrutinio per il genitore: giudizi per materia +
// comportamento + giudizio globale. Disponibile solo se lo scrutinio è
// pubblicato E il genitore ha firmato la ricezione (OTP). Altrimenti
// { firmato: false } (la UI mostra il flusso di firma).
export async function GET(request: NextRequest) {
  try {
    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const { scrutinioId, studentId } = q.data

    const auth = await requireParentOfStudent(request, studentId)
    if (auth.response) return auth.response
    const userId = auth.user.id

    const supabase = await createAdminClient()

    const { data: scrutinio } = await supabase
      .from('scrutini')
      .select('id, section_id, periodo_id, stato, pubblicato')
      .eq('id', scrutinioId)
      .maybeSingle()
    if (!scrutinio) return NextResponse.json({ error: 'Scrutinio non trovato' }, { status: 404 })
    if (scrutinio.stato !== 'chiuso' || !scrutinio.pubblicato) {
      return NextResponse.json({ error: 'Pagella non ancora pubblicata' }, { status: 403 })
    }

    // Gate firma: serve la presa visione del genitore (una volta per pagella).
    const { data: firma } = await supabase
      .from('pagella_ricezioni')
      .select('id, firmato_il')
      .eq('scrutinio_id', scrutinioId)
      .eq('alunno_id', studentId)
      .eq('genitore_id', userId)
      .maybeSingle()
    if (!firma) {
      return NextResponse.json({ success: true, data: { firmato: false } })
    }

    const [{ data: periodo }, { data: materie }, { data: giudizi }, { data: comp }] = await Promise.all([
      supabase.from('scrutinio_periodi').select('nome, anno_scolastico').eq('id', scrutinio.periodo_id).maybeSingle(),
      supabase.from('materie').select('id, nome, ordine').eq('section_id', scrutinio.section_id).eq('attiva', true).order('ordine'),
      supabase.from('scrutinio_giudizi').select('materia_id, giudizio_sintetico').eq('scrutinio_id', scrutinioId).eq('alunno_id', studentId),
      supabase.from('scrutinio_comportamento').select('giudizio_testo, giudizio_globale').eq('scrutinio_id', scrutinioId).eq('alunno_id', studentId).maybeSingle(),
    ])

    const giudMap = new Map((giudizi ?? []).map((g) => [g.materia_id, g.giudizio_sintetico]))
    const discipline = (materie ?? []).map((m) => ({ materia: m.nome, giudizio: giudMap.get(m.id) ?? '—' }))

    return NextResponse.json({
      success: true,
      data: {
        firmato: true,
        firmatoIl: firma.firmato_il,
        periodo: periodo?.nome ?? '',
        anno: periodo?.anno_scolastico ?? '',
        discipline,
        comportamento: comp?.giudizio_testo ?? null,
        giudizioGlobale: comp?.giudizio_globale ?? null,
      },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
