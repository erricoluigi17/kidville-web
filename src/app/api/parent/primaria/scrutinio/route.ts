import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { getRequestUserId } from '@/lib/auth/require-staff'

// GET /api/parent/primaria/scrutinio?scrutinioId=&studentId=&userId=
// Vista a schermo dello scrutinio per il genitore: giudizi per materia +
// comportamento + giudizio globale. Disponibile solo se lo scrutinio è
// pubblicato E il genitore ha firmato la ricezione (OTP). Altrimenti
// { firmato: false } (la UI mostra il flusso di firma).
export async function GET(request: NextRequest) {
  try {
    const sp = new URL(request.url).searchParams
    const scrutinioId = sp.get('scrutinioId')
    const studentId = sp.get('studentId')
    const userId = getRequestUserId(request)
    if (!userId) return NextResponse.json({ error: 'Non autenticato' }, { status: 401 })
    if (!scrutinioId || !studentId) {
      return NextResponse.json({ error: 'scrutinioId e studentId obbligatori' }, { status: 400 })
    }

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
