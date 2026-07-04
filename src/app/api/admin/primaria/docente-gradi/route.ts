import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff, requireDocente } from '@/lib/auth/require-staff'
import { scuoleDiUtente } from '@/lib/auth/scope'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'

const GRADI_VALIDI = ['nido', 'infanzia', 'primaria'] as const

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
/** '' equivale ad assente (i check truthy pre-esistenti restano invariati). */
const vuotoComeAssente = (v: unknown) => (v === '' ? undefined : v)

const getQuerySchema = z.object({
  // Filtro eq su utenti.scuola_id ('' = nessun filtro, come prima).
  scuolaId: z.preprocess(vuotoComeAssente, zUuid.optional()),
})

const patchBodySchema = z.object({
  utenteId: zUuid,
  // Sostituisce i 400 manuali (utenteId/gradi obbligatori + gradi non validi).
  gradi: z.array(z.enum(GRADI_VALIDI, { error: 'Grado non valido' })),
})

// GET /api/admin/primaria/docente-gradi?scuolaId=
// Elenco docenti/staff con i loro gradi (per la gestione classificazione).
export async function GET(request: NextRequest) {
  const auth = await requireDocente(request)
  if (auth.response) return auth.response

  const q = parseQuery(request, getQuerySchema)
  if ('response' in q) return q.response
  const { scuolaId } = q.data
  try {
    const supabase = await createAdminClient()
    const plessi = await scuoleDiUtente(supabase, auth.user)
    if (!plessi.length) return NextResponse.json({ success: true, data: [] })
    const target = scuolaId && plessi.includes(scuolaId) ? [scuolaId] : plessi
    let query = supabase
      .from('utenti')
      .select('id, nome, cognome, email, ruolo, role, gradi')
      .in('ruolo', ['maestra', 'educator', 'docente', 'coordinator', 'admin'])
      .order('cognome', { ascending: true })
    query = query.in('scuola_id', target)

    const { data, error } = await query
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true, data: data ?? [] })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

// PATCH /api/admin/primaria/docente-gradi  body: { utenteId, gradi: string[] }
export async function PATCH(request: NextRequest) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const b = await parseBody(request, patchBodySchema)
    if ('response' in b) return b.response
    const { utenteId, gradi } = b.data

    const supabase = await createAdminClient()
    const { data, error } = await supabase
      .from('utenti')
      .update({ gradi })
      .eq('id', utenteId)
      .select('id, nome, cognome, gradi')
      .single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true, data })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
