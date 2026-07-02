import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { getRequestUserId } from '@/lib/auth/require-staff'
import { getUserEmail, verifyTicket, codeHash } from '@/lib/auth/otp-ticket'
import { buildSignatureLog, extractRequestMeta } from '@/lib/fea/signature-log'
import { recordSignerSlot } from '@/lib/fea/slots'
import { logFeaEvent } from '@/lib/fea/audit'

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
    const { ip, userAgent } = extractRequestMeta(request)
    const check = verifyTicket(email, String(code ?? ''), Number(expiry ?? 0), String(ticket ?? ''))
    if (!check.ok) {
      await logFeaEvent(supabase, { entitaTipo: 'pagella', signerUserId: userId, email, evento: 'verify_failed', ip, userAgent })
      return NextResponse.json({ error: check.error }, { status: 400 })
    }

    // La pagella deve essere pubblicata.
    const { data: scr } = await supabase
      .from('scrutini')
      .select('id, pubblicato')
      .eq('id', scrutinioId)
      .maybeSingle()
    if (!scr) return NextResponse.json({ error: 'Scrutinio non trovato' }, { status: 404 })
    if (!scr.pubblicato) return NextResponse.json({ error: 'Pagella non ancora pubblicata' }, { status: 403 })

    const firma = buildSignatureLog({
      method: 'OTP_EMAIL',
      email,
      ip,
      userAgent,
      hash: codeHash(email, String(code), Number(expiry)),
    })

    const { data, error } = await supabase
      .from('pagella_ricezioni')
      .upsert(
        { scrutinio_id: scrutinioId, alunno_id: studentId, genitore_id: userId, firma },
        { onConflict: 'scrutinio_id,alunno_id,genitore_id' }
      )
      .select()
      .single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    // Ledger slot firmatari (additivo, best-effort): non blocca la firma primaria.
    if (data?.id) {
      await recordSignerSlot(supabase, {
        entitaTipo: 'pagella',
        entitaId: data.id,
        signerUserId: userId,
        signatureLog: firma,
      })
      await logFeaEvent(supabase, {
        entitaTipo: 'pagella',
        entitaId: data.id,
        signerUserId: userId,
        email,
        evento: 'signed',
        hash: firma.hash,
        ip,
        userAgent,
      })
    }

    return NextResponse.json({ success: true, data })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
