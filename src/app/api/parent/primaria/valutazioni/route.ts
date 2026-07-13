import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireParentOfStudent } from '@/lib/auth/require-parent'
import { parseQuery } from '@/lib/validation/http'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore } from '@/lib/logging/logger'

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
// studentId lasco (niente zUuid): un valore non-GUID oggi degrada a 404 dalla
// query su `alunni` — stesso criterio di parent/competenze.
const getQuerySchema = z.object({
  studentId: z.string({ error: 'studentId obbligatorio' }).min(1, 'studentId obbligatorio'),
})

// GET /api/parent/primaria/valutazioni?studentId=&userId=
// Valutazioni in itinere del figlio, raggruppate per materia.
// NB: nessuna media numerica nella risposta. La media (associazione numerica
// nascosta dei giudizi) è strumento di lavoro del docente e NON va MAI esposta
// al genitore — O.M. 3/2025, PRD §4 (#1/#3) e §4.5.
// Visibilità A TEMPO: il genitore vede una valutazione solo trascorso il buffer
// (notif_buffer_valutazioni_min, default 10') dalla creazione (PRD §4.5).
export const GET = withRoute('parent/primaria/valutazioni:GET', async (request: NextRequest) => {
  try {
    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const { studentId } = q.data

    const auth = await requireParentOfStudent(request, studentId)
    if (auth.response) return auth.response

    const supabase = await createAdminClient()

    const { data: alunno } = await supabase
      .from('alunni')
      .select('section_id, scuola_id')
      .eq('id', studentId)
      .maybeSingle()
    if (!alunno) return NextResponse.json({ error: 'Alunno non trovato' }, { status: 404 })

    // Buffer visibilità
    const { data: settings } = await supabase
      .from('admin_settings')
      .select('notif_buffer_valutazioni_min')
      .eq('scuola_id', alunno.scuola_id)
      .maybeSingle()
    const bufferMin = settings?.notif_buffer_valutazioni_min ?? 10
    const soglia = new Date(Date.now() - bufferMin * 60_000).toISOString()

    const [{ data: valutazioni }, { data: materie }] = await Promise.all([
      supabase
        .from('valutazioni')
        .select('id, materia_id, tipo, modalita, giudizio_sintetico, giudizio_testo, creato_il, argomento')
        .eq('alunno_id', studentId)
        // Buffer a tempo: visibile solo se creata da più di `bufferMin`, così il
        // docente ha la finestra di correzione. Nessun filtro `pubblicato`: per le
        // valutazioni in itinere non viene mai impostato a true (PRD §4.5).
        .lte('creato_il', soglia)
        .order('creato_il', { ascending: false }),
      supabase
        .from('materie')
        .select('id, nome')
        .eq('section_id', alunno.section_id)
        .eq('attiva', true)
        .order('ordine'),
    ])

    // Raggruppa per materia. Nessuna media: è riservata al docente (vedi nota in testa).
    const perMateria = new Map<string, { valutazioni: unknown[] }>()
    for (const v of valutazioni ?? []) {
      const entry = perMateria.get(v.materia_id) ?? { valutazioni: [] }
      entry.valutazioni.push(v)
      perMateria.set(v.materia_id, entry)
    }

    const data = (materie ?? [])
      .filter((m) => perMateria.has(m.id))
      .map((m) => {
        const entry = perMateria.get(m.id)!
        return {
          materiaId: m.id,
          nome: m.nome,
          valutazioni: entry.valutazioni,
        }
      })

    return NextResponse.json({ success: true, data })
  } catch (err) {
    logErrore({ operazione: 'parent/primaria/valutazioni:GET', stato: 500 }, err)
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
})
