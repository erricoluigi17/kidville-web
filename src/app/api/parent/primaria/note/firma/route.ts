import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { getRequestUserId } from '@/lib/auth/require-staff'
import { getUserEmail, verifyTicket, codeHash } from '@/lib/auth/otp-ticket'
import { buildSignatureLog, extractRequestMeta } from '@/lib/fea/signature-log'
import { recordSignerSlot } from '@/lib/fea/slots'
import { logFeaEvent } from '@/lib/fea/audit'

// POST /api/parent/primaria/note/firma?userId=
// body: { notaId, code, expiry, ticket }
// Il genitore firma (OTP/FES) la presa visione di una nota disciplinare. Stesso
// pattern della pagella: signature_log in nota_ricezioni + slot + audit immutabile.
export async function POST(request: NextRequest) {
  try {
    const userId = getRequestUserId(request)
    if (!userId) return NextResponse.json({ error: 'Non autenticato' }, { status: 401 })

    const { notaId, code, expiry, ticket } = await request.json()
    if (!notaId) return NextResponse.json({ error: 'notaId obbligatorio' }, { status: 400 })

    const supabase = await createAdminClient()

    // Conferma OTP email (FES) prima di registrare la firma.
    const email = await getUserEmail(supabase, userId)
    if (!email) return NextResponse.json({ error: 'Email del genitore non trovata' }, { status: 400 })
    const { ip, userAgent } = extractRequestMeta(request)
    const check = verifyTicket(email, String(code ?? ''), Number(expiry ?? 0), String(ticket ?? ''))
    if (!check.ok) {
      await logFeaEvent(supabase, { entitaTipo: 'nota', entitaId: notaId, signerUserId: userId, email, evento: 'verify_failed', ip, userAgent })
      return NextResponse.json({ error: check.error }, { status: 400 })
    }

    const { data: nota } = await supabase
      .from('note_disciplinari')
      .select('id, alunno_id, richiede_firma')
      .eq('id', notaId)
      .maybeSingle()
    if (!nota) return NextResponse.json({ error: 'Nota non trovata' }, { status: 404 })

    // Solo un genitore COLLEGATO all'alunno della nota può firmarne la presa visione.
    const { data: legame } = await supabase
      .from('legame_genitori_alunni')
      .select('alunno_id')
      .eq('genitore_id', userId)
      .eq('alunno_id', nota.alunno_id)
      .maybeSingle()
    if (!legame) {
      return NextResponse.json({ error: 'Accesso negato: alunno non collegato al genitore' }, { status: 403 })
    }

    const firma = buildSignatureLog({
      method: 'OTP_EMAIL',
      email,
      ip,
      userAgent,
      hash: codeHash(email, String(code), Number(expiry)),
    })

    const { data, error } = await supabase
      .from('nota_ricezioni')
      .upsert(
        { nota_id: notaId, alunno_id: nota.alunno_id, genitore_id: userId, firma },
        { onConflict: 'nota_id,genitore_id' }
      )
      .select()
      .single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    // Retro-compat con la GET genitore (badge "Firmata"): timestamp + firmatario sulla nota.
    await supabase
      .from('note_disciplinari')
      .update({ firmata_il: new Date().toISOString(), firmata_da: userId })
      .eq('id', notaId)

    // Ledger slot firmatari + audit immutabile (additivi, best-effort).
    if (data?.id) {
      await recordSignerSlot(supabase, {
        entitaTipo: 'nota',
        entitaId: data.id,
        signerUserId: userId,
        signatureLog: firma,
      })
      await logFeaEvent(supabase, {
        entitaTipo: 'nota',
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
