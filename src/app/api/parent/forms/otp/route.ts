import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireUser } from '@/lib/auth/require-staff'
import { persistSignedSubmission } from '@/lib/forms/persist-submission'
import { getUserEmail, sendOtp, verifyTicket, codeHash } from '@/lib/auth/otp-ticket'
import { buildSignatureLog, extractRequestMeta } from '@/lib/fea/signature-log'
import { parseBody } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'

// ─── Schemi di validazione input (M3/M4) ─────────────────────────────────────
// L'identità del firmatario viene dal gate (requireUser): il `parent_id`
// legacy nel body è ignorato, nessun fallback demo (M4). La firma FES resta
// legata all'email autorevole dell'utente autenticato.

// student_id opzionale: stringa vuota trattata come assente
// (persistSignedSubmission fa già `student_id || null`).
const zStudentIdOpzionale = z.preprocess(
  (v) => (v === '' ? undefined : v),
  zUuid.nullish()
)

const postBodySchema = z.object({})

const patchBodySchema = z.object({
  // code/expiry arrivano dal client anche come numero: il codice li normalizza
  // già con String()/Number() prima della verifica HMAC.
  code: z.union([z.string(), z.number()]),
  expiry: z.union([z.number(), z.string()]),
  ticket: z.string(),
  form_id: zUuid,
  student_id: zStudentIdOpzionale,
  // answers è un pass-through jsonb: oggi è accettato qualsiasi valore truthy.
  answers: z.unknown().refine((v) => !!v, 'Parametri mancanti'),
})

// ── POST: genera e invia il codice OTP via email, ritorna il ticket firmato ──
export async function POST(request: NextRequest) {
  try {
    const auth = await requireUser(request)
    if (auth.response) return auth.response
    const parentId = auth.user.id

    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response

    const supabase = await createAdminClient()
    const res = await sendOtp(supabase, parentId, {
      subject: 'Codice di firma elettronica — Kidville',
      intro: 'Il tuo codice di firma è',
    })
    if ('error' in res) return NextResponse.json({ error: 'Email del genitore non trovata' }, { status: 400 })

    return NextResponse.json(res)
  } catch (err) {
    console.error('Errore POST /api/parent/forms/otp:', err)
    const message = err instanceof Error && err.message ? err.message : 'Errore interno'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

// ── PATCH: verifica l'OTP e finalizza la firma (FES) persistendo la submission ──
export async function PATCH(request: NextRequest) {
  try {
    const auth = await requireUser(request)
    if (auth.response) return auth.response
    const parentId = auth.user.id

    const b = await parseBody(request, patchBodySchema)
    if ('response' in b) return b.response
    const { code, expiry, ticket, form_id, student_id, answers } = b.data

    const supabase = await createAdminClient()
    const email = await getUserEmail(supabase, parentId)
    if (!email) {
      return NextResponse.json({ error: 'Email del genitore non trovata' }, { status: 400 })
    }

    // Verifica scadenza + ticket (HMAC ricalcolato con l'email autorevole).
    const check = verifyTicket(email, String(code), Number(expiry), ticket)
    if (!check.ok) return NextResponse.json({ error: check.error }, { status: 400 })

    // signature_log FES autorevole, costruito lato server
    const { ip, userAgent } = extractRequestMeta(request)

    const { data: parent } = await supabase
      .from('utenti')
      .select('nome, cognome')
      .eq('id', parentId)
      .maybeSingle()

    const signature_log = {
      ...buildSignatureLog({
        method: 'OTP_EMAIL',
        email,
        ip,
        userAgent,
        hash: codeHash(email, String(code), Number(expiry)),
      }),
      parent_details: { nome: parent?.nome ?? null, cognome: parent?.cognome ?? null },
    }

    const result = await persistSignedSubmission(supabase, {
      form_id,
      parent_id: parentId,
      student_id,
      answers: answers as Record<string, unknown>,
      is_signed: true,
      signature_log,
    })

    if (result.error) {
      return NextResponse.json({ error: result.error }, { status: result.status })
    }

    return NextResponse.json({ ok: true, submission: result.submission, signature_log }, { status: 201 })
  } catch (err) {
    console.error('Errore PATCH /api/parent/forms/otp:', err)
    const message = err instanceof Error && err.message ? err.message : 'Errore interno'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
