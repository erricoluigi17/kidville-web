import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'

// ============================================================
// Materie (discipline) per sezione — catalogo editabile derivato dal preset.
// ============================================================

// GET /api/admin/primaria/materie?sectionId=
export async function GET(request: NextRequest) {
  try {
    const sectionId = new URL(request.url).searchParams.get('sectionId')
    if (!sectionId) return NextResponse.json({ error: 'sectionId obbligatorio' }, { status: 400 })

    const supabase = await createAdminClient()
    const { data, error } = await supabase
      .from('materie')
      .select('*')
      .eq('section_id', sectionId)
      .order('ordine', { ascending: true })

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true, data: data ?? [] })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

// POST /api/admin/primaria/materie
//   body normale: { sectionId, nome, codice, e_civica?, turno_mensa?, ordine? }
//   apply-preset:  ?action=apply-preset  body: { sectionId, livello }
export async function POST(request: NextRequest) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const action = new URL(request.url).searchParams.get('action')
    const body = await request.json()
    const supabase = await createAdminClient()

    // Risolve la scuola dalla sezione (single source of truth).
    const sectionId: string | undefined = body.sectionId
    if (!sectionId) return NextResponse.json({ error: 'sectionId obbligatorio' }, { status: 400 })
    const { data: section } = await supabase
      .from('sections')
      .select('id, scuola_id')
      .eq('id', sectionId)
      .maybeSingle()
    if (!section) return NextResponse.json({ error: 'Sezione non trovata' }, { status: 404 })

    if (action === 'apply-preset') {
      const livello = Number(body.livello)
      if (!livello || livello < 1 || livello > 5) {
        return NextResponse.json({ error: 'livello (1-5) obbligatorio' }, { status: 400 })
      }
      const { data: preset, error: presetErr } = await supabase
        .from('materie_preset')
        .select('nome, codice, e_civica, turno_mensa, ordine')
        .eq('livello', livello)
        .eq('attivo', true)
      if (presetErr) return NextResponse.json({ error: presetErr.message }, { status: 500 })

      const rows = (preset ?? []).map((p) => ({
        scuola_id: section.scuola_id,
        section_id: sectionId,
        nome: p.nome,
        codice: p.codice,
        e_civica: p.e_civica,
        turno_mensa: p.turno_mensa,
        ordine: p.ordine,
      }))
      if (rows.length === 0) return NextResponse.json({ success: true, data: [] })

      // upsert idempotente su (section_id, codice)
      const { data, error } = await supabase
        .from('materie')
        .upsert(rows, { onConflict: 'section_id,codice', ignoreDuplicates: true })
        .select()
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      return NextResponse.json({ success: true, data: data ?? [] }, { status: 201 })
    }

    if (!body.nome || !body.codice) {
      return NextResponse.json({ error: 'nome e codice obbligatori' }, { status: 400 })
    }
    const { data, error } = await supabase
      .from('materie')
      .insert({
        scuola_id: section.scuola_id,
        section_id: sectionId,
        nome: body.nome,
        codice: body.codice,
        e_civica: body.e_civica ?? false,
        turno_mensa: body.turno_mensa ?? false,
        ordine: body.ordine ?? 0,
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

// PATCH /api/admin/primaria/materie  body: { id, ...updates }
export async function PATCH(request: NextRequest) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const { id, ...updates } = await request.json()
    if (!id) return NextResponse.json({ error: 'id obbligatorio' }, { status: 400 })
    // Non si modificano chiavi di tenancy via PATCH.
    delete updates.scuola_id
    delete updates.section_id

    const supabase = await createAdminClient()
    const { data, error } = await supabase
      .from('materie')
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

// DELETE /api/admin/primaria/materie?id=
export async function DELETE(request: NextRequest) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const id = new URL(request.url).searchParams.get('id')
    if (!id) return NextResponse.json({ error: 'id obbligatorio' }, { status: 400 })

    const supabase = await createAdminClient()
    const { error } = await supabase.from('materie').delete().eq('id', id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
