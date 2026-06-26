import { NextResponse } from 'next/server'
import { createHash, randomInt } from 'crypto'
import { createAdminClient } from '@/lib/supabase/server-client'
import { sendEmail } from '@/lib/email/send'
import { rateLimit, clientIp } from '@/lib/security/rate-limit'
import { getUserEmail } from '@/lib/auth/otp-ticket'
import { buildSignatureLog, extractRequestMeta } from '@/lib/fea/signature-log'
import { recordSignerSlot, getSlots } from '@/lib/fea/slots'
import { firmaCompleta, prossimoSlot } from '@/lib/fea/firma-congiunta'
import { logFeaEvent } from '@/lib/fea/audit'
import { assertGenitoreNonSospeso } from '@/lib/pagamenti/sospensione'
import { estraiConsensi, consensiObbligatoriMancanti } from '@/lib/forms/consensi'
import type { FormSchemaConfig, FormSubmissionData } from '@/types/database.types'

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
      submissionId?: string
      signerEmail?: string
    }
    const { modelId, userId, data, submissionId, signerEmail } = body

    const supabase = await createAdminClient()

    // ── Reinvio OTP / 2° firmatario (DL-031) ──
    // Quando arriva un `submissionId`, NON si crea una nuova submission: si
    // (ri)genera il codice per la submission esistente e lo si invia all'email
    // indicata (reinvio = stesso firmatario; firma congiunta = email del 2°).
    if (submissionId) {
      const { data: sub } = await supabase
        .from('form_submissions')
        .select('id, status, user_id')
        .eq('id', submissionId)
        .maybeSingle()
      if (!sub) {
        return NextResponse.json({ error: 'Submission non trovata' }, { status: 404 })
      }
      if (sub.status === 'completed') {
        return NextResponse.json({ error: 'Modulo già firmato' }, { status: 409 })
      }

      let email: string | null = signerEmail ?? null
      if (!email && sub.user_id) {
        const { data: parent } = await supabase
          .from('utenti').select('email').eq('id', sub.user_id).maybeSingle()
        email = parent?.email ?? null
      }

      const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
      const { error: updErr } = await supabase
        .from('form_submissions')
        .update({ otp_secret: hashOtp(submissionId, code) })
        .eq('id', submissionId)
      if (updErr) {
        return NextResponse.json({ error: updErr.message }, { status: 500 })
      }

      const sent = email ? await deliverOtp(email, code) : false
      return NextResponse.json({
        submissionId,
        email,
        sent,
        ...(process.env.NODE_ENV !== 'production' ? { devCode: code } : {}),
      })
    }

    if (!modelId || !data) {
      return NextResponse.json(
        { error: 'modelId e data sono obbligatori' },
        { status: 400 }
      )
    }

    // Sospensione moroso (DL-021): un genitore con un figlio sospeso non può
    // avviare nuove firme/compilazioni di moduli (azione di servizio inibita).
    if (userId) {
      const sospesoErr = await assertGenitoreNonSospeso(supabase, userId)
      if (sospesoErr) return sospesoErr
    }

    // Snapshot consensi (DL-029): carica lo schema, valida i consensi obbligatori
    // e archivia l'evidenza legale insieme alla submission.
    const { data: model } = await supabase
      .from('form_models')
      .select('schema')
      .eq('id', modelId)
      .maybeSingle()
    const pages = ((model?.schema as FormSchemaConfig | undefined)?.pages) ?? []
    const mancanti = consensiObbligatoriMancanti(pages, data as Record<string, unknown>)
    if (mancanti.length > 0) {
      return NextResponse.json(
        { error: 'Consensi obbligatori non accettati', missing: mancanti },
        { status: 400 }
      )
    }
    const consents_log = estraiConsensi(pages, data as Record<string, unknown>, new Date().toISOString())

    // 1. Crea la submission in stato pending_signature
    const { data: submission, error: insertErr } = await supabase
      .from('form_submissions')
      .insert({
        model_id: modelId,
        user_id: userId ?? null,
        data,
        status: 'pending_signature',
        consents_log: consents_log.length > 0 ? consents_log : null,
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
      .select('id, otp_secret, status, user_id, model_id')
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

    // Modalità firma del modello (DL-031): single (1 firmatario) o joint (2).
    const { data: model } = await supabase
      .from('form_models')
      .select('signature_mode')
      .eq('id', submission.model_id)
      .maybeSingle()
    const mode = (model?.signature_mode as string | undefined) ?? 'single'

    // Slot già firmati → indice di QUESTO firmatario e completamento per policy.
    const slotsPrima = await getSlots(supabase, 'forms', submissionId)
    const firmatiPrima = slotsPrima.filter((s) => s.stato === 'signed').length
    const slotIndex = prossimoSlot(firmatiPrima)
    const completed = firmaCompleta(mode, firmatiPrima + 1)

    // FEA (DL-001): registra il signature_log canonico anche su questo path.
    // Identità da user_id della submission (firma congiunta: il 2° firmatario
    // può essere email-only → signerUserId null).
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

    // Aggiorna la submission: completa solo quando la policy è soddisfatta;
    // altrimenti resta pending_signature in attesa del prossimo firmatario.
    // signature_log (primario) impostato dal 1° firmatario (slot 0).
    const updates: Record<string, unknown> = { otp_secret: null }
    if (slotIndex === 0) updates.signature_log = signature_log
    if (completed) {
      updates.status = 'completed'
      updates.signed_at = signedAt
    }
    const { error: updErr } = await supabase
      .from('form_submissions')
      .update(updates)
      .eq('id', submissionId)

    if (updErr) {
      console.error('Errore finalizzazione firma:', updErr)
      return NextResponse.json({ error: updErr.message }, { status: 500 })
    }

    // Ledger slot (per-firmatario) + audit immutabile (best-effort).
    await recordSignerSlot(supabase, {
      entitaTipo: 'forms',
      entitaId: submissionId,
      slotIndex,
      completionPolicy: mode === 'joint' ? 'all-required' : 'any-one',
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

    const requiredSigners = mode === 'joint' ? 2 : 1
    return NextResponse.json({
      ok: true,
      signedAt,
      completed,
      needsMoreSigners: !completed,
      signedSlots: firmatiPrima + 1,
      requiredSigners,
    })
  } catch (err) {
    console.error('Errore PATCH send-otp:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
