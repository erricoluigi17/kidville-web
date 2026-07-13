import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireDocente } from '@/lib/auth/require-staff'
import { assertSezioneInScope } from '@/lib/auth/scope'
import { parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore } from '@/lib/logging/logger'

const getQuerySchema = z.object({
  sectionId: zUuid,
})

// GET /api/primaria/orario?sectionId=&userId=
// Orario settimanale in SOLA LETTURA (personale docente/segreteria): campanelle + griglia.
// (Il genitore consulta l'orario dalle proprie pagine /api/parent/**.)
export const GET = withRoute('primaria/orario:GET', async (request: NextRequest) => {
  try {
    const auth = await requireDocente(request)
    if (auth.response) return auth.response

    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const { sectionId } = q.data

    const supabase = await createAdminClient()
    const scopeErr = await assertSezioneInScope(supabase, auth.user, sectionId)
    if (scopeErr) return scopeErr
    const [{ data: campanelle }, { data: orario }] = await Promise.all([
      supabase.from('campanelle').select('*').eq('section_id', sectionId).order('giorno_settimana').order('ordine'),
      supabase
        .from('orario_settimanale')
        .select('id, giorno_settimana, campanella_id, materia_id, docente_id, note, materie(nome, codice), utenti(nome, cognome)')
        .eq('section_id', sectionId),
    ])

    return NextResponse.json({ success: true, data: { campanelle: campanelle ?? [], orario: orario ?? [] } })
  } catch (err) {
    logErrore({ operazione: 'primaria/orario:GET', stato: 500 }, err)
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
})
