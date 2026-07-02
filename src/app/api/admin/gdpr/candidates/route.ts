import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'

// Lista "diritto all'oblio" (DL-034): alunni NON iscritti e non ancora
// anonimizzati, con i genitori collegati. Riservata alla Direzione.

const DIREZIONE = ['admin', 'coordinator'] as const

export async function GET(request: Request) {
  const auth = await requireStaff(request, [...DIREZIONE])
  if (auth.response) return auth.response

  const supabase = await createAdminClient()

  const { data: alunni, error } = await supabase
    .from('alunni')
    .select('id, nome, cognome, classe_sezione, stato')
    .neq('stato', 'iscritto')
    .is('anonimizzato_il', null)
    .order('cognome', { ascending: true })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const ids = (alunni ?? []).map((a: { id: string }) => a.id)
  let links: { student_id: string; parent_id: string }[] = []
  let parents: { id: string; first_name: string | null; last_name: string | null }[] = []
  if (ids.length > 0) {
    const { data: l } = await supabase
      .from('student_parents')
      .select('student_id, parent_id')
      .in('student_id', ids)
    links = (l as typeof links) ?? []
    const parentIds = Array.from(new Set(links.map((x) => x.parent_id)))
    if (parentIds.length > 0) {
      const { data: p } = await supabase
        .from('parents')
        .select('id, first_name, last_name')
        .in('id', parentIds)
      parents = (p as typeof parents) ?? []
    }
  }

  const parentById = new Map(parents.map((p) => [p.id, p]))
  const result = (alunni ?? []).map((a: { id: string }) => {
    const genitori = links
      .filter((x) => x.student_id === a.id)
      .map((x) => parentById.get(x.parent_id))
      .filter(Boolean)
      .map((p) => ({ id: p!.id, nome: `${p!.first_name ?? ''} ${p!.last_name ?? ''}`.trim() }))
    return { ...a, genitori }
  })

  return NextResponse.json(result)
}
