import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { calcolaDelibera, type EsitoAmmissione } from '@/lib/forms/delibera'
import { parseBody, parseData } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'

const ESITI_VALIDI = ['ammesso', 'lista_attesa', 'non_ammesso'] as const satisfies readonly EsitoAmmissione[]

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
// Il body ha due forme (override singolo vs delibera bulk) discriminate dalla
// PRESENZA di submissionId: prima un parse loose del body, poi lo schema del
// ramo scelto (così i campi dell'altro ramo restano ignorati come prima).
const postBodySchema = z.looseObject({
  submissionId: z.unknown().optional(),
  modelId: z.unknown().optional(),
})

const postOverrideSchema = z.object({
  submissionId: zUuid,
  esito: z.enum(ESITI_VALIDI),
  note: z.unknown().optional(), // usato solo se stringa (comportamento invariato)
})

const postBulkSchema = z.object({
  modelId: zUuid,
  posti: z.unknown().optional(), // coercizione Number() nel handler (default 0)
  soglia: z.unknown().optional(), // coercizione Number() nel handler (default 0)
})

// POST /api/forms/delibera  (staff) — delibera ammissioni (DL-025).
//  • bulk:     { modelId, posti, soglia }  → calcola e assegna gli esiti
//  • override: { submissionId, esito, note? } → forza l'esito di un candidato
export async function POST(request: Request) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const parsed = await parseBody(request, postBodySchema)
    if ('response' in parsed) return parsed.response
    const body = parsed.data

    const supabase = await createAdminClient()
    const nowIso = new Date().toISOString()

    // ── Override singolo ──
    if (body.submissionId) {
      const o = parseData(postOverrideSchema, body)
      if ('response' in o) return o.response
      const { submissionId, esito, note } = o.data
      const { error } = await supabase
        .from('form_submissions')
        .update({
          esito_ammissione: esito,
          esito_il: nowIso,
          esito_da: auth.user.id,
          esito_note: typeof note === 'string' ? note : null,
        })
        .eq('id', submissionId)
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      return NextResponse.json({ success: true, data: { submissionId, esito } })
    }

    // ── Delibera bulk ──
    const bulk = parseData(postBulkSchema, body)
    if ('response' in bulk) return bulk.response
    const posti = Math.max(0, Number(bulk.data.posti ?? 0))
    const soglia = Number(bulk.data.soglia ?? 0)

    const { data: subs } = await supabase
      .from('form_submissions')
      .select('id, score')
      .eq('model_id', bulk.data.modelId)
      .eq('status', 'completed')
      .order('score', { ascending: false })

    const candidati = ((subs ?? []) as { id: string; score: number }[]).map((s) => ({
      id: s.id,
      score: Number(s.score ?? 0),
    }))
    const esiti = calcolaDelibera(candidati, { soglia, posti })

    for (const e of esiti) {
      await supabase
        .from('form_submissions')
        .update({ esito_ammissione: e.esito, esito_il: nowIso, esito_da: auth.user.id })
        .eq('id', e.id)
    }

    const conteggi = esiti.reduce<Record<string, number>>((acc, e) => {
      acc[e.esito] = (acc[e.esito] ?? 0) + 1
      return acc
    }, {})

    return NextResponse.json({ success: true, data: { totale: esiti.length, conteggi } })
  } catch (err) {
    console.error('Errore API POST delibera:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
