import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { parseQuery } from '@/lib/validation/http'
import { buildGenitoriAlunni } from '@/lib/sidi/payload'
import { serializeGenitoriAlunni } from '@/lib/sidi/serializer'
import { sidiTransmit } from '@/lib/sidi/client'
import { loadSyncState, persistFaseStato } from '@/lib/sidi/sync-store'
import { puoInviarePiattaformaUnica } from '@/lib/sidi/sequenza'

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
const postQuerySchema = z.object({}) // nessun parametro in ingresso (il body non viene letto; userId è consumato dal gate)

const SCUOLA_ID_DEFAULT = '11111111-1111-1111-1111-111111111111'

type NestedCf = { codice_fiscale?: string | null } | { codice_fiscale?: string | null }[] | null
type NestedPf = { fiscal_code?: string | null } | { fiscal_code?: string | null }[] | null
const one = <T>(v: T | T[] | null): T | null => (Array.isArray(v) ? v[0] ?? null : v)

// POST /api/admin/sidi/piattaforma-unica?userId=  — Flusso associazioni Genitori-Alunni.
// Solo legami VALIDATI dalla Segreteria. Sequenza: dopo frequentanti `inviato`. GATED.
export async function POST(request: NextRequest) {
  const auth = await requireStaff(request, ['admin', 'coordinator'])
  if (auth.response) return auth.response
  const q = parseQuery(request, postQuerySchema)
  if ('response' in q) return q.response
  try {
    const supabase = await createAdminClient()
    const scuolaId = auth.user.scuola_id || SCUOLA_ID_DEFAULT

    const state = await loadSyncState(supabase, scuolaId)
    if (!puoInviarePiattaformaUnica(state.frequentanti_stato)) {
      return NextResponse.json(
        { error: 'Flusso frequentanti non ancora inviato: le associazioni vanno trasmesse dopo i frequentanti', stato: state.frequentanti_stato },
        { status: 409 }
      )
    }

    const { data: rows } = await supabase
      .from('student_parents')
      .select('relation_type, validato_sidi, student:alunni(codice_fiscale), parent:parents(fiscal_code)')
      .eq('validato_sidi', true)
    const { data: settings } = await supabase.from('admin_settings').select('sidi_config').eq('scuola_id', scuolaId).maybeSingle()

    const legami = ((rows ?? []) as { relation_type: string; student: NestedCf; parent: NestedPf }[]).map((r) => ({
      student_cf: one(r.student)?.codice_fiscale ?? null,
      parent_cf: one(r.parent)?.fiscal_code ?? null,
      relation_type: r.relation_type,
      validato: true,
    }))
    const flusso = buildGenitoriAlunni({ legami })
    const xml = serializeGenitoriAlunni(flusso)

    const result = await sidiTransmit((settings?.sidi_config as Record<string, unknown>) ?? {}, 'piattaforma_unica', xml)
    const stato = result.ok ? 'inviato' : 'errore'
    await persistFaseStato(supabase, scuolaId, 'piattaforma_unica', stato, result)

    if (!result.ok) return NextResponse.json({ ...result, stato }, { status: result.httpStatus })
    return NextResponse.json({ success: true, stato, associazioni: flusso.associazioni.length })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
