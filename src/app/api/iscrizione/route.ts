import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { rateLimit, clientIp } from '@/lib/security/rate-limit'
import { parseBody } from '@/lib/validation/http'
import type { EnrollmentSubmissionData } from '@/types/database.types'

const DEFAULT_SCUOLA_ID = '11111111-1111-1111-1111-111111111111'

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
// `data` viene inserito INTERO nella colonna JSONB enrollment_submissions.data:
// .loose() preserva le chiavi extra del wizard. Gli elementi di children/adults
// restano liberi (oggi nessun vincolo sulla loro forma).
// `scuola_id` resta unknown: oggi QUALSIASI valore falsy (assente, '', null, …)
// ricade sul default, gestito nel codice con || come prima.
const postBodySchema = z.object({
  scuola_id: z.unknown().optional(),
  data: z
    .object(
      {
        children: z
          .array(z.unknown(), { error: 'Dati iscrizione non validi' })
          .min(1, 'Inserire almeno un bambino'),
        adults: z
          .array(z.unknown(), { error: 'Dati iscrizione non validi' })
          .min(1, 'Inserire almeno un adulto'),
      },
      { error: 'Dati iscrizione non validi' }
    )
    .loose(),
})

// POST: il genitore invia l'iscrizione dal form pubblico (service-role).
export async function POST(request: NextRequest) {
  try {
    // Rotta pubblica → rate-limit anti-abuso (5 invii / 10 min per IP).
    const rl = rateLimit(`iscrizione:${clientIp(request)}`, { limit: 5, windowMs: 10 * 60 * 1000 })
    if (!rl.ok) {
      return NextResponse.json(
        { error: 'Troppe richieste. Riprova tra qualche minuto.' },
        { status: 429, headers: { 'Retry-After': String(Math.ceil(rl.retryAfterMs / 1000)) } }
      )
    }

    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response
    const { data } = b.data

    const supabase = await createAdminClient()
    const { data: row, error } = await supabase
      .from('enrollment_submissions')
      .insert({
        scuola_id: (b.data.scuola_id as string | undefined) || DEFAULT_SCUOLA_ID,
        data: data as EnrollmentSubmissionData,
        status: 'pending',
      })
      .select('id')
      .single()

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ id: row.id }, { status: 201 })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg || 'Errore interno' }, { status: 500 })
  }
}
