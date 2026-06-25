import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { getRequestUserId } from '@/lib/auth/require-staff'
import { sendOtp } from '@/lib/auth/otp-ticket'
import { logFeaEvent } from '@/lib/fea/audit'
import { extractRequestMeta } from '@/lib/fea/signature-log'

// POST /api/parent/primaria/note/firma/otp?userId=
// Invia un OTP via email al genitore per firmare la presa visione di una nota.
export async function POST(request: NextRequest) {
  try {
    const userId = getRequestUserId(request)
    if (!userId) return NextResponse.json({ error: 'Non autenticato' }, { status: 401 })

    const supabase = await createAdminClient()
    const res = await sendOtp(supabase, userId, {
      subject: 'Codice di conferma presa visione nota — Kidville',
      intro: 'Il tuo codice per confermare la presa visione della nota è',
    })
    if ('error' in res) return NextResponse.json({ error: res.error }, { status: 400 })

    const { ip, userAgent } = extractRequestMeta(request)
    await logFeaEvent(supabase, { entitaTipo: 'nota', signerUserId: userId, email: res.email, evento: 'otp_sent', ip, userAgent })

    return NextResponse.json({ success: true, data: res })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
