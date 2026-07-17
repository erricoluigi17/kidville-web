import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireParentOfStudent } from '@/lib/auth/require-parent'
import { parseQuery } from '@/lib/validation/http'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore } from '@/lib/logging/logger'

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
// studentId lasco (niente zUuid): un valore non-GUID oggi produce lista vuota
// dalla query su `presenze` — stesso criterio di parent/competenze.
// `limit`: parseInt storico preservato nell'handler (default 60, nessun clamp):
// NON zPaginazione, che cambierebbe default e limiti.
const getQuerySchema = z.object({
  studentId: z.string({ error: 'studentId obbligatorio' }).min(1, 'studentId obbligatorio'),
  limit: z.string().optional(),
})

// Stati contati nel riepilogo. `presente` INCLUSO di proposito: senza, un bambino
// presente resta indistinguibile da un appello non ancora fatto (falla del collaudo).
const STATI_RIEPILOGO = ['presente', 'assente', 'ritardo', 'uscita_anticipata'] as const
type StatoRiepilogo = (typeof STATI_RIEPILOGO)[number]

// GET /api/parent/primaria/assenze?studentId=&userId=&limit=30
// Restituisce:
//  - `data`: la cronologia dettagliata dei SOLI stati negativi (assenze, ritardi,
//    uscite anticipate) — quelli su cui il genitore può agire (giustifica);
//  - `riepilogo`: i conteggi per stato (incluso `presente`) calcolati con COUNT
//    aggregato lato DB, SENZA scaricare i ~180 giorni di presenza dell'anno.
export const GET = withRoute('parent/primaria/assenze:GET', async (request: NextRequest) => {
  try {
    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const { studentId } = q.data
    const limit = parseInt(q.data.limit ?? '60', 10)

    const auth = await requireParentOfStudent(request, studentId)
    if (auth.response) return auth.response

    const supabase = await createAdminClient()

    // Lista dettagliata dei soli stati negativi (comportamento invariato).
    const { data: presenze } = await supabase
      .from('presenze')
      .select('id, data, stato, orario_entrata, orario_uscita, giustificata, giustificazione_testo, giustificata_il, note_appello')
      .eq('alunno_id', studentId)
      .in('stato', ['assente', 'ritardo', 'uscita_anticipata'])
      .order('data', { ascending: false })
      .limit(limit)

    // Riepilogo: una query di conteggio per stato (`head: true` → nessuna riga
    // scaricata, solo il COUNT). PostgREST non lancia: su tabella/colonna assente
    // (E2E CI non migrato) `error` è valorizzato e `count` è null → il conteggio
    // degrada pulito a 0, e la risposta resta 200.
    const conteggi = await Promise.all(
      STATI_RIEPILOGO.map((stato) =>
        supabase
          .from('presenze')
          .select('id', { count: 'exact', head: true })
          .eq('alunno_id', studentId)
          .eq('stato', stato),
      ),
    )
    const riepilogo = STATI_RIEPILOGO.reduce((acc, stato, i) => {
      acc[stato] = conteggi[i]?.count ?? 0
      return acc
    }, {} as Record<StatoRiepilogo, number>)

    return NextResponse.json({ success: true, data: presenze ?? [], riepilogo })
  } catch (err) {
    logErrore({ operazione: 'parent/primaria/assenze:GET', stato: 500 }, err)
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
})
