import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { getRequestUserId } from '@/lib/auth/require-staff'
import { sendOtp } from '@/lib/auth/otp-ticket'

// POST /api/parent/primaria/pagella/firma/otp?userId=
// Invia un OTP via email al genitore per firmare la ricezione della pagella.
export async function POST(request: NextRequest) {
  try {
    const userId = getRequestUserId(request)
    if (!userId) return NextResponse.json({ error: 'Non autenticato' }, { status: 401 })

    const supabase = await createAdminClient()
    const res = await sendOtp(supabase, userId, {
      subject: 'Codice di conferma ricezione pagella — Kidville',
      intro: 'Il tuo codice per confermare la ricezione della pagella è',
    })
    if ('error' in res) return NextResponse.json({ error: res.error }, { status: 400 })

    return NextResponse.json({ success: true, data: res })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
