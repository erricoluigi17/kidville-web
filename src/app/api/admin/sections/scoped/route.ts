import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireDocente } from '@/lib/auth/require-staff'
import { scuoleDiUtente } from '@/lib/auth/scope'
import { sezioniDiUtente } from '@/lib/sezioni/docenti'
import { parseQuery } from '@/lib/validation/http'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore } from '@/lib/logging/logger'

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
// `grado`: csv di school_type ammessi (es. 'nido,infanzia'); assente = tutti.
// `userId` in query è consumato dal gate identità (requireDocente), non dall'handler.
const getQuerySchema = z.object({
  grado: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z
      .string()
      .regex(/^(nido|infanzia|primaria)(,(nido|infanzia|primaria))*$/)
      .optional()
  ),
})

// GET /api/admin/sections/scoped?grado=nido,infanzia
// Sezioni dei plessi consentiti all'utente, raggruppate per scuola: la fonte
// plesso-corretta per i selettori sede/sezione del cockpit (diario, avvisi,
// anagrafica, armadietto). Scoping identico al resto delle funzioni docente:
//  - educator: solo le sezioni assegnate (utenti_sezioni), nel proprio plesso;
//  - segreteria/coordinator: tutte le sezioni del proprio plesso;
//  - admin: tutti i plessi (utenti_scuole). Mai cross-tenant.
export const GET = withRoute('admin/sections/scoped:GET', async (request: NextRequest) => {
  try {
    const auth = await requireDocente(request)
    if (auth.response) return auth.response
    const user = auth.user

    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response

    const supabase = await createAdminClient()
    const plessi = await scuoleDiUtente(supabase, user)
    if (plessi.length === 0) {
      return NextResponse.json({ success: true, data: [] })
    }

    const types = q.data.grado ? q.data.grado.split(',') : null
    let query = supabase
      .from('sections')
      .select('id, name, school_type, scuola_id')
      .in('scuola_id', plessi)
      .order('name')
    if (types) query = query.in('school_type', types)
    const { data: sections, error } = await query
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    let visibili = (sections ?? []) as { id: string; name: string; school_type: string; scuola_id: string }[]
    if (user.role === 'educator') {
      const mie = await sezioniDiUtente(supabase, user.id)
      visibili = visibili.filter((s) => mie.includes(s.id))
    }

    const { data: schools } = await supabase.from('schools').select('id, nome').in('id', plessi)
    const nomi = new Map((schools ?? []).map((s: { id: string; nome: string | null }) => [s.id, s.nome ?? '']))

    // Gruppi anche vuoti: chi consuma decide se mostrarli (es. creare la prima
    // sezione di una sede nuova dall'anagrafica).
    const data = plessi.map((scuolaId) => ({
      scuolaId,
      scuolaNome: nomi.get(scuolaId) || 'Sede',
      sezioni: visibili
        .filter((s) => s.scuola_id === scuolaId)
        .map(({ id, name, school_type }) => ({ id, name, school_type })),
    }))

    return NextResponse.json({ success: true, data })
  } catch (err) {
    logErrore({ operazione: 'admin/sections/scoped:GET', stato: 500 }, err)
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
})
