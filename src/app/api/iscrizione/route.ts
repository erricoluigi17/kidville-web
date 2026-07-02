import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { rateLimit, clientIp } from '@/lib/security/rate-limit'
import type { EnrollmentSubmissionData } from '@/types/database.types'

const DEFAULT_SCUOLA_ID = '11111111-1111-1111-1111-111111111111'

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

    const body = await request.json()
    const data = body.data as EnrollmentSubmissionData | undefined

    if (!data || !Array.isArray(data.children) || !Array.isArray(data.adults)) {
      return NextResponse.json({ error: 'Dati iscrizione non validi' }, { status: 400 })
    }
    if (data.children.length === 0) {
      return NextResponse.json({ error: 'Inserire almeno un bambino' }, { status: 400 })
    }
    if (data.adults.length === 0) {
      return NextResponse.json({ error: 'Inserire almeno un adulto' }, { status: 400 })
    }

    const supabase = await createAdminClient()
    const { data: row, error } = await supabase
      .from('enrollment_submissions')
      .insert({
        scuola_id: body.scuola_id || DEFAULT_SCUOLA_ID,
        data,
        status: 'pending',
      })
      .select('id')
      .single()

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ id: row.id }, { status: 201 })
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Errore interno' }, { status: 500 })
  }
}
