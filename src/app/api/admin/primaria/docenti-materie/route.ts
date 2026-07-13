import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore } from '@/lib/logging/logger'

// ============================================================
// Assegnazione DOCENTE × CLASSE × MATERIA (contitolarità + isolamento materia).
// Tabella: utenti_sezioni_materie.
// ============================================================

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
/** '' equivale ad assente (i check truthy pre-esistenti restano invariati). */
const vuotoComeAssente = (v: unknown) => (v === '' ? undefined : v)

const getQuerySchema = z.object({
  sectionId: zUuid, // obbligatorio (sostituisce il 400 manuale)
  // Filtro eq opzionale su utente_id ('' = nessun filtro, come prima).
  utenteId: z.preprocess(vuotoComeAssente, zUuid.optional()),
})

const postBodySchema = z.object({
  utenteId: zUuid,
  sectionId: zUuid,
  materiaId: zUuid,
  eContitolare: z.boolean().nullish(), // default false applicato nel codice (?? come prima)
})

const deleteQuerySchema = z.object({
  id: zUuid, // obbligatorio (sostituisce il 400 manuale)
})

// GET /api/admin/primaria/docenti-materie?sectionId=  (opz. &utenteId=)
export const GET = withRoute('admin/primaria/docenti-materie:GET', async (request: NextRequest) => {
  const q = parseQuery(request, getQuerySchema)
  if ('response' in q) return q.response
  const { sectionId, utenteId } = q.data
  try {
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
    logErrore({ operazione: 'admin/primaria/docenti-materie:GET', stato: 500 }, err)
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
})

// POST /api/admin/primaria/docenti-materie
//   body: { utenteId, sectionId, materiaId, eContitolare? }
export const POST = withRoute('admin/primaria/docenti-materie:POST', async (request: NextRequest) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response
    const { utenteId, sectionId, materiaId, eContitolare } = b.data

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
    logErrore({ operazione: 'admin/primaria/docenti-materie:POST', stato: 500 }, err)
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
})

// DELETE /api/admin/primaria/docenti-materie?id=
export const DELETE = withRoute('admin/primaria/docenti-materie:DELETE', async (request: NextRequest) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const q = parseQuery(request, deleteQuerySchema)
    if ('response' in q) return q.response
    const { id } = q.data

    const supabase = await createAdminClient()
    const { error } = await supabase.from('utenti_sezioni_materie').delete().eq('id', id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true })
  } catch (err) {
    logErrore({ operazione: 'admin/primaria/docenti-materie:DELETE', stato: 500 }, err)
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
})
