import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { logScrittura } from '@/lib/audit/scrittura'

// GET /api/admin/sidi/legami?userId=  — elenco associazioni Genitori-Alunni con
// stato di validazione (per la conferma Segreteria prima della Piattaforma Unica).
export async function GET(request: NextRequest) {
  const auth = await requireStaff(request)
  if (auth.response) return auth.response
  try {
    const supabase = await createAdminClient()
    const { data } = await supabase
      .from('student_parents')
      .select('student_id, parent_id, relation_type, is_primary, validato_sidi, alunni(nome, cognome), parents(first_name, last_name, fiscal_code)')
      .order('student_id', { ascending: true })
    return NextResponse.json({ success: true, data: data ?? [] })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

// PATCH /api/admin/sidi/legami?userId=  — valida/invalida un legame (Segreteria).
// body: { student_id, parent_id, validato: boolean }
export async function PATCH(request: NextRequest) {
  const auth = await requireStaff(request)
  if (auth.response) return auth.response
  try {
    const body = await request.json().catch(() => ({}))
    if (!body.student_id || !body.parent_id) return NextResponse.json({ error: 'student_id e parent_id obbligatori' }, { status: 400 })

    const supabase = await createAdminClient()
    const validato = body.validato !== false
    const { error } = await supabase
      .from('student_parents')
      .update({ validato_sidi: validato, validato_il: validato ? new Date().toISOString() : null, validato_da: validato ? auth.user.id : null })
      .eq('student_id', body.student_id)
      .eq('parent_id', body.parent_id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'legame_sidi',
      entitaId: `${body.student_id}:${body.parent_id}`,
      azione: 'update',
      scuolaId: auth.user.scuola_id ?? null,
      valoreDopo: { validato_sidi: validato },
    })
    return NextResponse.json({ success: true })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
