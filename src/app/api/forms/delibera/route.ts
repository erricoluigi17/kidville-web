import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { calcolaDelibera, type EsitoAmmissione } from '@/lib/forms/delibera'

const ESITI_VALIDI: EsitoAmmissione[] = ['ammesso', 'lista_attesa', 'non_ammesso']

// POST /api/forms/delibera  (staff) — delibera ammissioni (DL-025).
//  • bulk:     { modelId, posti, soglia }  → calcola e assegna gli esiti
//  • override: { submissionId, esito, note? } → forza l'esito di un candidato
export async function POST(request: Request) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const body = await request.json()
    const supabase = await createAdminClient()
    const nowIso = new Date().toISOString()

    // ── Override singolo ──
    if (body.submissionId) {
      if (!ESITI_VALIDI.includes(body.esito)) {
        return NextResponse.json({ error: 'Esito non valido' }, { status: 400 })
      }
      const { error } = await supabase
        .from('form_submissions')
        .update({
          esito_ammissione: body.esito,
          esito_il: nowIso,
          esito_da: auth.user.id,
          esito_note: typeof body.note === 'string' ? body.note : null,
        })
        .eq('id', body.submissionId)
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      return NextResponse.json({ success: true, data: { submissionId: body.submissionId, esito: body.esito } })
    }

    // ── Delibera bulk ──
    if (!body.modelId) {
      return NextResponse.json({ error: 'modelId o submissionId obbligatorio' }, { status: 400 })
    }
    const posti = Math.max(0, Number(body.posti ?? 0))
    const soglia = Number(body.soglia ?? 0)

    const { data: subs } = await supabase
      .from('form_submissions')
      .select('id, score')
      .eq('model_id', body.modelId)
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
