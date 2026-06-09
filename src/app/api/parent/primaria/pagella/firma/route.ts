import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { getRequestUserId } from '@/lib/auth/require-staff'
import { getUserEmail, verifyTicket, codeHash } from '@/lib/auth/otp-ticket'

// POST /api/parent/primaria/pagella/firma?userId=
// body: { scrutinioId, studentId, code, expiry, ticket }
// Il genitore firma (OTP/FES) l'avvenuta ricezione della pagella. Una volta
// firmata, può vederne i giudizi a schermo e scaricare il PDF.
export async function POST(request: NextRequest) {
  try {
    const userId = getRequestUserId(request)
    if (!userId) return NextResponse.json({ error: 'Non autenticato' }, { status: 401 })

    const { scrutinioId, studentId, code, expiry, ticket } = await request.json()
    if (!scrutinioId || !studentId) {
      return NextResponse.json({ error: 'scrutinioId e studentId obbligatori' }, { status: 400 })
    }

    const supabase = await createAdminClient()

    // Conferma OTP email (FES) prima di registrare la firma.
    const email = await getUserEmail(supabase, userId)
    if (!email) return NextResponse.json({ error: 'Email del genitore non trovata' }, { status: 400 })
    const check = verifyTicket(email, String(code ?? ''), Number(expiry ?? 0), String(ticket ?? ''))
    if (!check.ok) return NextResponse.json({ error: check.error }, { status: 400 })

    // La pagella deve essere pubblicata.
    const { data: scr } = await supabase
      .from('scrutini')
      .select('id, pubblicato')
      .eq('id', scrutinioId)
      .single()
    if (!scr) return NextResponse.json({ error: 'Scrutinio non trovato' }, { status: 404 })
    if (!scr.pubblicato) return NextResponse.json({ error: 'Pagella non ancora pubblicata' }, { status: 403 })

    const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'N.D.'
    const firma = {
      method: 'OTP_EMAIL',
      provider: 'Firma OTP via email (FES)',
      email,
      ip,
      timestamp: new Date().toISOString(),
      hash: codeHash(email, String(code), Number(expiry)),
      compliance: 'CAD Art. 20 / DPR 445/2000',
    }

    const { data, error } = await supabase
      .from('pagella_ricezioni')
      .upsert(
        { scrutinio_id: scrutinioId, alunno_id: studentId, genitore_id: userId, firma },
        { onConflict: 'scrutinio_id,alunno_id,genitore_id' }
      )
      .select()
      .single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    return NextResponse.json({ success: true, data })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
