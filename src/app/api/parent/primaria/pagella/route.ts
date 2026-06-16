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
    console.log('[pagella GET] studentId=', studentId, 'alunno=', alunno)
    if (!alunno?.section_id) return NextResponse.json({ success: true, data: [] })

    // Scrutini PUBBLICATI della sezione del figlio + periodo (la chiusura non
    // basta: i voti sono visibili solo dopo l'OK/pubblicazione del dirigente).
    const { data: scrutini, error: scrutiniErr } = await supabase
      .from('scrutini')
      .select('id, periodo_id, chiuso_il, stato, pubblicato, scrutinio_periodi(nome, anno_scolastico, ordine)')
      .eq('section_id', alunno.section_id)
      .eq('stato', 'chiuso')
      .eq('pubblicato', true)
      .order('chiuso_il', { ascending: false })
    console.log('[pagella GET] section_id=', alunno.section_id, 'scrutini=', scrutini, 'err=', scrutiniErr)

    // Firme di ricezione del genitore per questo figlio (per il flag `firmato`).
    const scrutinioIds = (scrutini ?? []).map((s) => s.id)
    const firmati = new Set<string>()
    if (scrutinioIds.length) {
      const { data: firme } = await supabase
        .from('pagella_ricezioni')
        .select('scrutinio_id')
        .eq('alunno_id', studentId)
        .eq('genitore_id', userId)
        .in('scrutinio_id', scrutinioIds)
      for (const f of firme ?? []) firmati.add(f.scrutinio_id as string)
    }

    const pagelle = (scrutini ?? []).map((s) => {
      const p = s.scrutinio_periodi as { nome?: string; anno_scolastico?: string; ordine?: number } | null
      return {
        scrutinioId: s.id,
        periodo: p?.nome ?? '',
        anno: p?.anno_scolastico ?? '',
        chiusoIl: s.chiuso_il,
        firmato: firmati.has(s.id),
      }
    })

    return NextResponse.json({ success: true, data: pagelle })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
