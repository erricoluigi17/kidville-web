import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore } from '@/lib/logging/logger'
import { scegliPaganteComune } from '@/lib/pagamenti/pagante-comune'

// ─── Ponte alunni→pagante per l'«Incasso unico» di famiglia (Riconciliazione v2) ─
// Dagli alunni riconosciuti per CF su un bonifico multi-figlio risale al genitore
// pagante comune a tutti (`student_parents`), preferendo l'intestatario di default.
// Sola lettura, gate staff. Il `parent_id` risultante viene poi passato a
// GET /api/pagamenti/famiglia (che riapplica lo scope di sede) per precompilare il
// wizard; `null` = nessun pagante comune → la UI apre allo step «scegli pagante».

const getQuerySchema = z.object({
  // lista di UUID separati da virgola (voci vuote tollerate), almeno uno.
  alunni: z
    .string()
    .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean))
    .pipe(z.array(zUuid).min(1, 'Almeno un alunno')),
})

export const GET = withRoute('pagamenti/pagante-comune:GET', async (request: NextRequest) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const alunni = q.data.alunni

    const supabase = await createAdminClient()

    // Legami anagrafici parents↔alunni (student_parents.parent_id == parents.id,
    // lo stesso spazio che GET /api/pagamenti/famiglia accetta come parent_id).
    const { data: sp, error: spErr } = await supabase
      .from('student_parents')
      .select('parent_id, student_id')
      .in('student_id', alunni)
    if (spErr) {
      logErrore({ operazione: 'pagamenti/pagante-comune:GET', stato: 500, evento: 'db' }, spErr)
      return NextResponse.json({ error: 'Errore nel recupero dei legami' }, { status: 500 })
    }
    const links = (sp ?? []) as { parent_id: string | null; student_id: string | null }[]

    // Intestatari di default fra i genitori candidati. Colonna assente sul DB E2E
    // non migrato (42703) → si degrada a «nessun default», non è un errore.
    const parentIds = [...new Set(links.map((l) => l.parent_id).filter(Boolean) as string[])]
    let defaults = new Set<string>()
    if (parentIds.length > 0) {
      const d = await supabase
        .from('parents')
        .select('id')
        .in('id', parentIds)
        .eq('intestatario_default', true)
      if (!d.error) defaults = new Set(((d.data ?? []) as { id: string }[]).map((r) => r.id))
    }

    const parentId = scegliPaganteComune(links, alunni, defaults)
    return NextResponse.json({ success: true, data: { parent_id: parentId } })
  } catch (err) {
    logErrore({ operazione: 'pagamenti/pagante-comune:GET', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
