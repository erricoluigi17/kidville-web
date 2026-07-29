import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { sealDangerous } from '@/lib/security/seal'
import { parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore } from '@/lib/logging/logger'

const getQuerySchema = z.object({
  parentId: zUuid,
})

export const GET = withRoute('debug/scrutini:GET', async (request: NextRequest) => {
  const sealed = await sealDangerous(request)
  if (sealed) return sealed
  const q = parseQuery(request, getQuerySchema)
  if ('response' in q) return q.response
  const { parentId } = q.data
  try {
    const supabase = await createAdminClient()
    const result: Record<string, unknown> = {}

    // 1. Figli collegati al genitore
    // ⚠️ GREZZA DI PROPOSITO (A6): route diagnostica. Deve mostrare il contenuto
    // REALE di `legame_genitori_alunni`, non l'unione con `student_parents`:
    // serve proprio a vedere quando le due sorgenti non coincidono.
    const { data: legami } = await supabase
      .from('legame_genitori_alunni')
      .select('alunno_id')
      .eq('genitore_id', parentId)
    result.legami = legami

    const figliIds = (legami ?? []).map(l => l.alunno_id)

    // 2. Dati alunni collegati
    if (figliIds.length) {
      const { data: figli } = await supabase
        .from('alunni')
        .select('id, nome, cognome, section_id, classe_sezione')
        .in('id', figliIds)
      result.figli = figli

      // 3. Per ogni figlio con section_id, cerca scrutini pubblicati
      for (const f of figli ?? []) {
        if (!f.section_id) {
          result[`scrutini_${f.nome}_${f.cognome}_NO_SECTION`] = 'section_id è null!'
          continue
        }
        const { data: scrutini, error: sErr } = await supabase
          .from('scrutini')
          .select('id, section_id, stato, pubblicato, chiuso_il, scrutinio_periodi(nome, anno_scolastico)')
          .eq('section_id', f.section_id)
          .eq('stato', 'chiuso')
          .eq('pubblicato', true)
        result[`scrutini_${f.nome}_${f.cognome}_${f.classe_sezione}`] = { data: scrutini, error: sErr?.message }
      }
    } else {
      result.msg = 'Nessun figlio collegato al genitore!'
    }

    // 4. Tutti gli scrutini per riferimento
    const { data: tutti } = await supabase
      .from('scrutini')
      .select('id, section_id, stato, pubblicato')
    result.tuttiScrutini = tutti

    // 5. Cosa restituisce /api/parent/students (auto-resolve)
    // ⚠️ GREZZA DI PROPOSITO (A6), come sopra: `/api/parent/students` usa ormai
    // l'unione, e qui si vuole vedere la differenza fra le due — non nasconderla.
    const { data: studentsApi } = await supabase
      .from('legame_genitori_alunni')
      .select('alunno_id, alunni(id, nome, cognome, section_id, classe_sezione)')
      .eq('genitore_id', parentId)
    result.autoResolve = studentsApi

    return NextResponse.json(result)
  } catch (err) {
    logErrore({ operazione: 'debug/scrutini:GET', stato: 500 }, err)
    return NextResponse.json({ crash: String(err) }, { status: 500 })
  }
})
