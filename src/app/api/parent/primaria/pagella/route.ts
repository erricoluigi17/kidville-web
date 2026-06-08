import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { getRequestUserId } from '@/lib/auth/require-staff'

// GET /api/parent/primaria/pagella?studentId=&userId=
// Lista delle pagelle disponibili (scrutini chiusi) per il figlio, con i metadati
// del periodo. Il download del PDF avviene via /api/primaria/pagella.
export async function GET(request: NextRequest) {
  try {
    const studentId = new URL(request.url).searchParams.get('studentId')
    const userId = getRequestUserId(request)
    if (!userId) return NextResponse.json({ error: 'Non autenticato' }, { status: 401 })
    if (!studentId) return NextResponse.json({ error: 'studentId obbligatorio' }, { status: 400 })

    const supabase = await createAdminClient()

    const { data: alunno } = await supabase
      .from('alunni')
      .select('id, section_id')
      .eq('id', studentId)
      .single()
    if (!alunno?.section_id) return NextResponse.json({ success: true, data: [] })

    // Scrutini PUBBLICATI della sezione del figlio + periodo (la chiusura non
    // basta: i voti sono visibili solo dopo l'OK/pubblicazione del dirigente).
    const { data: scrutini } = await supabase
      .from('scrutini')
      .select('id, periodo_id, chiuso_il, stato, pubblicato, scrutinio_periodi(nome, anno_scolastico, ordine)')
      .eq('section_id', alunno.section_id)
      .eq('stato', 'chiuso')
      .eq('pubblicato', true)
      .order('chiuso_il', { ascending: false })

    const pagelle = (scrutini ?? []).map((s) => {
      const p = s.scrutinio_periodi as { nome?: string; anno_scolastico?: string; ordine?: number } | null
      return {
        scrutinioId: s.id,
        periodo: p?.nome ?? '',
        anno: p?.anno_scolastico ?? '',
        chiusoIl: s.chiuso_il,
      }
    })

    return NextResponse.json({ success: true, data: pagelle })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
