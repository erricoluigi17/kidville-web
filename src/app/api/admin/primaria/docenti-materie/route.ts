import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'

// ============================================================
// Assegnazione DOCENTE × CLASSE × MATERIA (contitolarità + isolamento materia).
// Tabella: utenti_sezioni_materie.
// ============================================================

// GET /api/admin/primaria/docenti-materie?sectionId=  (opz. &utenteId=)
export async function GET(request: NextRequest) {
  try {
    const sp = new URL(request.url).searchParams
    const sectionId = sp.get('sectionId')
    const utenteId = sp.get('utenteId')
    if (!sectionId) return NextResponse.json({ error: 'sectionId obbligatorio' }, { status: 400 })

    const supabase = await createAdminClient()
    let query = supabase
      .from('utenti_sezioni_materie')
      .select('id, utente_id, section_id, materia_id, e_contitolare, utenti(nome, cognome), materie(nome, codice)')
      .eq('section_id', sectionId)
    if (utenteId) query = query.eq('utente_id', utenteId)

    const { data, error } = await query
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true, data: data ?? [] })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

// POST /api/admin/primaria/docenti-materie
//   body: { utenteId, sectionId, materiaId, eContitolare? }
export async function POST(request: NextRequest) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const { utenteId, sectionId, materiaId, eContitolare } = await request.json()
    if (!utenteId || !sectionId || !materiaId) {
      return NextResponse.json({ error: 'utenteId, sectionId, materiaId obbligatori' }, { status: 400 })
    }

    const supabase = await createAdminClient()

    // Garantisce anche il legame docente↔sezione (utenti_sezioni canonico).
    await supabase
      .from('utenti_sezioni')
      .upsert({ utente_id: utenteId, section_id: sectionId }, { onConflict: 'utente_id,section_id', ignoreDuplicates: true })

    const { data, error } = await supabase
      .from('utenti_sezioni_materie')
      .upsert(
        { utente_id: utenteId, section_id: sectionId, materia_id: materiaId, e_contitolare: eContitolare ?? false },
        { onConflict: 'utente_id,section_id,materia_id' }
      )
      .select()
      .single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true, data }, { status: 201 })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

// DELETE /api/admin/primaria/docenti-materie?id=
export async function DELETE(request: NextRequest) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const id = new URL(request.url).searchParams.get('id')
    if (!id) return NextResponse.json({ error: 'id obbligatorio' }, { status: 400 })

    const supabase = await createAdminClient()
    const { error } = await supabase.from('utenti_sezioni_materie').delete().eq('id', id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
