import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireParentOfStudent } from '@/lib/auth/require-parent'
import { parseQuery } from '@/lib/validation/http'
import {
  calcolaOreAssenza,
  giornataDaCampanelle,
  type PresenzaInput,
  type StatoPresenza,
} from '@/lib/primaria/oreAssenza'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore } from '@/lib/logging/logger'

// ── Vista genitore (read-only) delle presenze del figlio. ────────────────────
// A differenza di `parent/primaria/assenze` (cronologia delle sole assenze),
// questo endpoint alimenta la HOME:
//  - `oggi`: stato dell'appello odierno → badge "A scuola" in dashboard;
//    `stato: null` = appello non ancora registrato dal docente.
//  - `riepilogo`: conteggi presenze/assenze/ritardi/uscite degli ultimi 30 giorni
//    (+ monte ore perse per la primaria, riusando il calcolo del registro).
// La tabella `presenze` è condivisa da tutti i gradi (UNIQUE alunno_id,data).
// Auth e scoping ricalcano la route sorella: identità via `getRequestUserId`
// (header/`userId`), lettura per `alunno_id` con service-role.

// studentId lasco (niente zUuid): un valore non-GUID produce lista vuota dalla
// query su `presenze` — stesso criterio di parent/primaria/assenze.
const getQuerySchema = z.object({
  studentId: z.string({ error: 'studentId obbligatorio' }).min(1, 'studentId obbligatorio'),
})

export const GET = withRoute('parent/presenze:GET', async (request: NextRequest) => {
  try {
    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const { studentId } = q.data

    const auth = await requireParentOfStudent(request, studentId)
    if (auth.response) return auth.response

    const supabase = await createAdminClient()

    const { data: alunno } = await supabase
      .from('alunni')
      .select('id, section_id, scuola_id')
      .eq('id', studentId)
      .maybeSingle()
    if (!alunno) return NextResponse.json({ error: 'Alunno non trovato' }, { status: 404 })

    // Tipo scuola della sezione (per la vista adattiva lato client).
    let schoolType: string | null = null
    if (alunno.section_id) {
      const { data: sez } = await supabase
        .from('sections')
        .select('school_type')
        .eq('id', alunno.section_id)
        .maybeSingle()
      schoolType = sez?.school_type ?? null
    }

    const oggiData = new Date().toISOString().slice(0, 10)
    const from = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10)

    const [{ data: oggiRow }, { data: periodo }] = await Promise.all([
      // Presenza di oggi (può non esistere se l'appello non è ancora stato fatto).
      supabase
        .from('presenze')
        .select('stato, orario_entrata, orario_uscita')
        .eq('alunno_id', studentId)
        .eq('data', oggiData)
        .maybeSingle(),
      // Presenze degli ultimi 30 giorni per il riepilogo.
      supabase
        .from('presenze')
        .select('stato, orario_entrata, orario_uscita, data')
        .eq('alunno_id', studentId)
        .gte('data', from)
        .lte('data', oggiData),
    ])

    const rows = (periodo ?? []) as {
      stato: string
      orario_entrata: string | null
      orario_uscita: string | null
    }[]
    const conteggi = { presenze: 0, assenze: 0, ritardi: 0, uscite: 0 }
    for (const r of rows) {
      if (r.stato === 'presente') conteggi.presenze++
      else if (r.stato === 'assente') conteggi.assenze++
      else if (r.stato === 'ritardo') conteggi.ritardi++
      else if (r.stato === 'uscita_anticipata') conteggi.uscite++
    }

    const riepilogo: Record<string, unknown> = { from, to: oggiData, ...conteggi }

    // Primaria: monte ore perse, riusando il calcolo del registro di classe.
    if (schoolType === 'primaria' && alunno.section_id) {
      const { data: campanelle } = await supabase
        .from('campanelle')
        .select('ora_inizio, ora_fine, tipo')
        .eq('section_id', alunno.section_id)
      const giornata = giornataDaCampanelle(campanelle ?? [])
      const presenzeInput: PresenzaInput[] = rows.map((r) => ({
        stato: r.stato as StatoPresenza,
        orario_entrata: r.orario_entrata,
        orario_uscita: r.orario_uscita,
      }))
      riepilogo.ore = calcolaOreAssenza(presenzeInput, giornata)
    }

    return NextResponse.json({
      success: true,
      data: {
        schoolType,
        oggi: {
          stato: (oggiRow?.stato ?? null) as StatoPresenza | null,
          orario_entrata: oggiRow?.orario_entrata ?? null,
          orario_uscita: oggiRow?.orario_uscita ?? null,
        },
        riepilogo,
      },
    })
  } catch (err) {
    logErrore({ operazione: 'parent/presenze:GET', stato: 500 }, err)
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
})
