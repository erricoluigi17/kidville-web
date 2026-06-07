import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'

// ============================================================
// Obiettivi di apprendimento (curricolo) — materia × livello.
// ============================================================

// GET /api/admin/primaria/obiettivi?scuolaId=&materiaCodice=&livello=
export async function GET(request: NextRequest) {
  try {
    const sp = new URL(request.url).searchParams
    const scuolaId = sp.get('scuolaId')
    const materiaCodice = sp.get('materiaCodice')
    const livello = sp.get('livello')
    if (!scuolaId) return NextResponse.json({ error: 'scuolaId obbligatorio' }, { status: 400 })

    const supabase = await createAdminClient()
    let query = supabase
      .from('obiettivi_apprendimento')
      .select('*')
      .eq('scuola_id', scuolaId)
      .order('livello', { ascending: true })
      .order('materia_codice', { ascending: true })
    if (materiaCodice) query = query.eq('materia_codice', materiaCodice)
    if (livello) query = query.eq('livello', Number(livello))

    const { data, error } = await query
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true, data: data ?? [] })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

// POST /api/admin/primaria/obiettivi
//   body: { scuolaId, materiaCodice, livello, codice?, descrizione }
export async function POST(request: NextRequest) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const body = await request.json()
    const { scuolaId, materiaCodice, livello, codice, descrizione } = body
    if (!scuolaId || !materiaCodice || !livello || !descrizione) {
      return NextResponse.json({ error: 'scuolaId, materiaCodice, livello, descrizione obbligatori' }, { status: 400 })
    }

    const supabase = await createAdminClient()
    const { data, error } = await supabase
      .from('obiettivi_apprendimento')
      .insert({
        scuola_id: scuolaId,
        materia_codice: materiaCodice,
        livello: Number(livello),
        codice: codice ?? null,
        descrizione,
      })
      .select()
      .single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true, data }, { status: 201 })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

// PATCH /api/admin/primaria/obiettivi  body: { id, ...updates }
export async function PATCH(request: NextRequest) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const { id, ...updates } = await request.json()
    if (!id) return NextResponse.json({ error: 'id obbligatorio' }, { status: 400 })
    delete updates.scuola_id

    const supabase = await createAdminClient()
    const { data, error } = await supabase
      .from('obiettivi_apprendimento')
      .update(updates)
      .eq('id', id)
      .select()
      .single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true, data })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

// DELETE /api/admin/primaria/obiettivi?id=
export async function DELETE(request: NextRequest) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const id = new URL(request.url).searchParams.get('id')
    if (!id) return NextResponse.json({ error: 'id obbligatorio' }, { status: 400 })

    const supabase = await createAdminClient()
    const { error } = await supabase.from('obiettivi_apprendimento').delete().eq('id', id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
