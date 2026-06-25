import { NextResponse } from 'next/server'
import { createHash, randomInt } from 'crypto'
import { createAdminClient } from '@/lib/supabase/server-client'
import { sendEmail } from '@/lib/email/send'
import { rateLimit, clientIp } from '@/lib/security/rate-limit'
import { getUserEmail } from '@/lib/auth/otp-ticket'
import { buildSignatureLog, extractRequestMeta } from '@/lib/fea/signature-log'
import { recordSignerSlot } from '@/lib/fea/slots'
import { logFeaEvent } from '@/lib/fea/audit'
import type { FormSubmissionData } from '@/types/database.types'

// Hash deterministico: lega il codice alla submission (sale anti-rainbow-table)
function hashOtp(submissionId: string, code: string): string {
  return createHash('sha256').update(`${submissionId}:${code}`).digest('hex')
}

// Invio email: usa Resend se configurato, altrimenti log server-side (modalità dev)
async function deliverOtp(email: string, code: string): Promise<boolean> {
  return sendEmail({
    to: email,
    subject: 'Codice di firma elettronica — Kidville',
    text: `Il tuo codice di firma è: ${code}\n\nInseriscilo per completare la firma del modulo. Il codice è valido per pochi minuti.`,
  })
}

// ── POST: crea la submission (pending_signature) e invia l'OTP ──
export async function POST(request: Request) {
  try {
    // Invio OTP è abusabile (spam email) → rate-limit per IP (8 / 10 min).
    const rl = rateLimit(`send-otp:${clientIp(request)}`, { limit: 8, windowMs: 10 * 60 * 1000 })
    if (!rl.ok) {
      return NextResponse.json(
        { error: 'Troppe richieste OTP. Riprova tra qualche minuto.' },
        { status: 429, headers: { 'Retry-After': String(Math.ceil(rl.retryAfterMs / 1000)) } }
      )
    }

    const body = (await request.json()) as {
      modelId?: string
      userId?: string | null
      data?: FormSubmissionData
    }
    const { modelId, userId, data } = body

    if (!modelId || !data) {
      return NextResponse.json(
        { error: 'modelId e data sono obbligatori' },
        { status: 400 }
      )
    }

    const supabase = await createAdminClient()

    // 1. Crea la submission in stato pending_signature
    const { data: submission, error: insertErr } = await supabase
      .from('form_submissions')
      .insert({
        model_id: modelId,
        user_id: userId ?? null,
        data,
        status: 'pending_signature',
      })
      .select('id')
      .single()

    if (insertErr || !submission) {
      console.error('Errore creazione submission:', insertErr)
      return NextResponse.json(
        { error: insertErr?.message ?? 'Creazione submission fallita' },
        { status: 500 }
      )
    }

    // 2. Recupera l'email del genitore loggato
    let email: string | null = null
    if (userId) {
      const { data: parent } = await supabase
        .from('utenti')
        .select('email')
        .eq('id', userId)
        .maybeSingle()
      email = parent?.email ?? null
    }

    // 3. Genera codice a 6 cifre, salva l'hash, invia
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
    const otpHash = hashOtp(submission.id, code)

    const { error: updErr } = await supabase
      .from('form_submissions')
      .update({ otp_secret: otpHash })
      .eq('id', submission.id)

    if (updErr) {
      console.error('Errore salvataggio otp_secret:', updErr)
      return NextResponse.json({ error: updErr.message }, { status: 500 })
    }

    const sent = email ? await deliverOtp(email, code) : false

    return NextResponse.json({
      submissionId: submission.id,
      email,
      sent,
      // In dev (nessun provider email) restituiamo il codice per consentire il test.
      ...(process.env.NODE_ENV !== 'production' ? { devCode: code } : {}),
    })
  } catch (err) {
    console.error('Errore POST send-otp:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}

// ── PATCH: verifica l'OTP e finalizza la firma (completed + signed_at) ──
export async function PATCH(request: Request) {
  try {
    const body = (await request.json()) as { submissionId?: string; code?: string }
    const { submissionId, code } = body

    if (!submissionId || !code) {
      return NextResponse.json(
        { error: 'submissionId e code sono obbligatori' },
        { status: 400 }
      )
    }

    const supabase = await createAdminClient()

    const { data: submission, error: fetchErr } = await supabase
      .from('form_submissions')
      .select('id, otp_secret, status, user_id')
      .eq('id', submissionId)
      .maybeSingle()

    if (fetchErr || !submission) {
      return NextResponse.json({ error: 'Submission non trovata' }, { status: 404 })
    }

    if (submission.status === 'completed') {
      return NextResponse.json({ error: 'Modulo già firmato' }, { status: 409 })
    }

    if (!submission.otp_secret || hashOtp(submissionId, code) !== submission.otp_secret) {
      return NextResponse.json({ error: 'Codice non valido' }, { status: 400 })
    }

    const signedAt = new Date().toISOString()

    // FEA (DL-001): registra il signature_log canonico anche su questo path
    // (prima non salvava alcuna evidenza FES). Identità da user_id della submission.
    const userId: string | null = submission.user_id ?? null
    const email = userId ? await getUserEmail(supabase, userId) : null
    const { ip, userAgent } = extractRequestMeta(request)
    const hash = `SHA256-${hashOtp(submissionId, code).slice(0, 32).toUpperCase()}`
    const signature_log = buildSignatureLog({
      method: 'OTP_EMAIL',
      email: email ?? 'N.D.',
      ip,
      userAgent,
      hash,
      signedAt,
    })

    const { error: updErr } = await supabase
      .from('form_submissions')
      .update({
        status: 'completed',
        signed_at: signedAt,
        signature_log,
        otp_secret: null, // consuma il codice dopo l'uso
      })
      .eq('id', submissionId)

    if (updErr) {
      console.error('Errore finalizzazione firma:', updErr)
      return NextResponse.json({ error: updErr.message }, { status: 500 })
    }

    // Ledger slot + audit immutabile (best-effort).
    await recordSignerSlot(supabase, {
      entitaTipo: 'forms',
      entitaId: submissionId,
      signerUserId: userId,
      signatureLog: signature_log,
    })
    await logFeaEvent(supabase, {
      entitaTipo: 'forms',
      entitaId: submissionId,
      signerUserId: userId,
      email,
      evento: 'signed',
      hash,
      ip,
      userAgent,
    })

    return NextResponse.json({ ok: true, signedAt })
  } catch (err) {
    console.error('Errore PATCH send-otp:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
