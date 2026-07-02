import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'

// ============================================================
// Obiettivo associato a una materia di una classe (sezione).
// Un solo obiettivo per (section_id, materia_id), mostrato in pagella.
// ============================================================

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
/** '' equivale ad assente (i check truthy pre-esistenti restano invariati). */
const vuotoComeAssente = (v: unknown) => (v === '' ? undefined : v)

const getQuerySchema = z.object({
  sectionId: zUuid, // obbligatorio (sostituisce il 400 manuale)
})

const postBodySchema = z.object({
  sectionId: zUuid,
  materiaId: zUuid,
  // null/''/assente → rimuove l'associazione (check falsy preservato nel codice).
  obiettivoId: z.preprocess(vuotoComeAssente, zUuid.nullish()),
})

// GET /api/admin/primaria/materia-obiettivo?sectionId=
// Ritorna la mappa materia_id → obiettivo_id per la sezione.
export async function GET(request: NextRequest) {
  const q = parseQuery(request, getQuerySchema)
  if ('response' in q) return q.response
  const { sectionId } = q.data
  try {
    const supabase = await createAdminClient()
    const { data, error } = await supabase
      .from('sezione_materia_obiettivo')
      .select('materia_id, obiettivo_id')
      .eq('section_id', sectionId)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true, data: data ?? [] })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

// POST /api/admin/primaria/materia-obiettivo
//   body: { sectionId, materiaId, obiettivoId | null }
// obiettivoId null/"" → rimuove l'associazione.
export async function POST(request: NextRequest) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response
    const { sectionId, materiaId, obiettivoId } = b.data

    const supabase = await createAdminClient()

    if (!obiettivoId) {
      const { error } = await supabase
        .from('sezione_materia_obiettivo')
        .delete()
        .eq('section_id', sectionId)
        .eq('materia_id', materiaId)
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      return NextResponse.json({ success: true, data: null })
    }

    const { data, error } = await supabase
      .from('sezione_materia_obiettivo')
      .upsert({ section_id: sectionId, materia_id: materiaId, obiettivo_id: obiettivoId }, { onConflict: 'section_id,materia_id' })
      .select()
      .single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true, data }, { status: 201 })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
