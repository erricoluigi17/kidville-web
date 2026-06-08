import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { getRequestUserId } from '@/lib/auth/require-staff'
import { calcolaOreAssenza, giornataDaCampanelle, type PresenzaInput } from '@/lib/primaria/oreAssenza'

// GET /api/primaria/ore-assenza?sectionId=&from=&to=&alunnoId=&userId=
// Monte ore di assenza (assenze intere + ritardi + permessi) per alunno.
export async function GET(request: NextRequest) {
  try {
    const sp = new URL(request.url).searchParams
    const sectionId = sp.get('sectionId')
    const from = sp.get('from')
    const to = sp.get('to')
    const alunnoId = sp.get('alunnoId')
    if (!getRequestUserId(request)) return NextResponse.json({ error: 'Non autenticato' }, { status: 401 })
    if (!sectionId) return NextResponse.json({ error: 'sectionId obbligatorio' }, { status: 400 })

    const supabase = await createAdminClient()

    // Giornata scolastica dedotta dalle campanelle della sezione.
    const { data: campanelle } = await supabase
      .from('campanelle')
      .select('ora_inizio, ora_fine, tipo')
      .eq('section_id', sectionId)
    const giornata = giornataDaCampanelle(campanelle ?? [])

    // Alunni della sezione (per includere anche chi non ha assenze).
    let alunniQuery = supabase.from('alunni').select('id, nome, cognome').eq('section_id', sectionId).order('cognome')
    if (alunnoId) alunniQuery = alunniQuery.eq('id', alunnoId)
    const { data: alunni } = await alunniQuery

    // Presenze nel periodo.
    let presQuery = supabase
      .from('presenze')
      .select('alunno_id, stato, orario_entrata, orario_uscita')
      .eq('section_id', sectionId)
      .in('stato', ['assente', 'ritardo', 'uscita_anticipata'])
    if (from) presQuery = presQuery.gte('data', from)
    if (to) presQuery = presQuery.lte('data', to)
    if (alunnoId) presQuery = presQuery.eq('alunno_id', alunnoId)
    const { data: presenze } = await presQuery

    const perAlunno = new Map<string, PresenzaInput[]>()
    for (const p of presenze ?? []) {
      const arr = perAlunno.get(p.alunno_id) ?? []
      arr.push({ stato: p.stato, orario_entrata: p.orario_entrata, orario_uscita: p.orario_uscita })
      perAlunno.set(p.alunno_id, arr)
    }

    const data = (alunni ?? []).map((a) => ({
      alunnoId: a.id,
      nome: a.nome,
      cognome: a.cognome,
      ...calcolaOreAssenza(perAlunno.get(a.id) ?? [], giornata),
    }))

    return NextResponse.json({ success: true, data, giornata })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
