import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'

// ============================================================
// Obiettivi di apprendimento (curricolo) — materia × livello.
// ============================================================

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
/** '' equivale ad assente (i check truthy pre-esistenti restano invariati). */
const vuotoComeAssente = (v: unknown) => (v === '' ? undefined : v)

const getQuerySchema = z.object({
  scuolaId: zUuid, // obbligatorio (sostituisce il 400 manuale)
  // Filtri opzionali ('' = nessun filtro, come prima).
  materiaCodice: z.preprocess(vuotoComeAssente, z.string().optional()),
  livello: z.preprocess(vuotoComeAssente, z.coerce.number().optional()), // come Number(livello)
})

const postBodySchema = z.object({
  scuolaId: zUuid,
  materiaCodice: z.string().min(1, 'materiaCodice obbligatorio'),
  // Truthy-check pre-esistente preservato (falsy → 400), poi Number() come prima.
  livello: z.preprocess((v) => v || undefined, z.coerce.number({ error: 'livello obbligatorio' })),
  codice: z.string().nullish(), // default null applicato nel codice (?? come prima)
  descrizione: z.string().min(1, 'descrizione obbligatoria'),
})

// Il body (meno id e scuola_id) va in update(updates): .loose() preserva le chiavi extra.
const patchBodySchema = z.object({
  id: zUuid, // sostituisce il 400 manuale
}).loose()

const deleteQuerySchema = z.object({
  id: zUuid, // obbligatorio (sostituisce il 400 manuale)
})

// GET /api/admin/primaria/obiettivi?scuolaId=&materiaCodice=&livello=
export async function GET(request: NextRequest) {
  const q = parseQuery(request, getQuerySchema)
  if ('response' in q) return q.response
  const { scuolaId, materiaCodice, livello } = q.data
  try {
    const supabase = await createAdminClient()
    let query = supabase
      .from('obiettivi_apprendimento')
      .select('*')
      .eq('scuola_id', scuolaId)
      .order('livello', { ascending: true })
      .order('materia_codice', { ascending: true })
    if (materiaCodice) query = query.eq('materia_codice', materiaCodice)
    if (livello !== undefined) query = query.eq('livello', livello)

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

    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response
    const { scuolaId, materiaCodice, livello, codice, descrizione } = b.data

    const supabase = await createAdminClient()
    const { data, error } = await supabase
      .from('obiettivi_apprendimento')
      .insert({
        scuola_id: scuolaId,
        materia_codice: materiaCodice,
        livello,
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

    const b = await parseBody(request, patchBodySchema)
    if ('response' in b) return b.response
    const { id, ...updates } = b.data
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

    const q = parseQuery(request, deleteQuerySchema)
    if ('response' in q) return q.response
    const { id } = q.data

    const supabase = await createAdminClient()
    const { error } = await supabase.from('obiettivi_apprendimento').delete().eq('id', id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
