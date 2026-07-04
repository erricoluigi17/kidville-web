import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { getRequestUserId } from '@/lib/auth/require-staff'
import { getUserEmail, verifyTicket, codeHash } from '@/lib/auth/otp-ticket'
import { buildSignatureLog, extractRequestMeta } from '@/lib/fea/signature-log'
import { recordSignerSlot } from '@/lib/fea/slots'
import { logFeaEvent } from '@/lib/fea/audit'
import { parseBody } from '@/lib/validation/http'

// Id laschi (non zUuid): il comportamento attuale accetta qualsiasi stringa non
// vuota (il lookup su `scrutini` fa da gate con 404). I campi OTP restano
// permissivi: oggi sono coerciti a String/Number senza vincoli di tipo e la
// verifica vera è verifyTicket (400 con semantica propria).
const postBodySchema = z.object({
  scrutinioId: z.string({ error: 'scrutinioId obbligatorio' }).min(1, 'scrutinioId obbligatorio'),
  studentId: z.string({ error: 'studentId obbligatorio' }).min(1, 'studentId obbligatorio'),
  code: z.unknown().optional(),
  expiry: z.unknown().optional(),
  ticket: z.unknown().optional(),
})

// POST /api/parent/primaria/pagella/firma?userId=
// body: { scrutinioId, studentId, code, expiry, ticket }
// Il genitore firma (OTP/FES) l'avvenuta ricezione della pagella. Una volta
// firmata, può vederne i giudizi a schermo e scaricare il PDF.
export async function POST(request: NextRequest) {
  try {
    const userId = getRequestUserId(request)
    if (!userId) return NextResponse.json({ error: 'Non autenticato' }, { status: 401 })

    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response
    const { scrutinioId, studentId, code, expiry, ticket } = b.data

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
