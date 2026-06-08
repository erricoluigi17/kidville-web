import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { persistSignedSubmission } from '@/lib/forms/persist-submission'
import { getUserEmail, sendOtp, verifyTicket, codeHash } from '@/lib/auth/otp-ticket'

const DEFAULT_PARENT_ID = '33333333-3333-3333-3333-333333333333'

// ── POST: genera e invia il codice OTP via email, ritorna il ticket firmato ──
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const parentId = body.parent_id || DEFAULT_PARENT_ID

    const supabase = await createAdminClient()
    const res = await sendOtp(supabase, parentId, {
      subject: 'Codice di firma elettronica — Kidville',
      intro: 'Il tuo codice di firma è',
    })
    if ('error' in res) return NextResponse.json({ error: 'Email del genitore non trovata' }, { status: 400 })

    return NextResponse.json(res)
  } catch (err: any) {
    console.error('Errore POST /api/parent/forms/otp:', err)
    return NextResponse.json({ error: err.message || 'Errore interno' }, { status: 500 })
  }
}

// ── PATCH: verifica l'OTP e finalizza la firma (FES) persistendo la submission ──
export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json()
    const { code, expiry, ticket, form_id, student_id, answers } = body
    const parentId = body.parent_id || DEFAULT_PARENT_ID

    if (!form_id || !answers) {
      return NextResponse.json({ error: 'Parametri mancanti' }, { status: 400 })
    }

    const supabase = await createAdminClient()
    const email = await getUserEmail(supabase, parentId)
    if (!email) {
      return NextResponse.json({ error: 'Email del genitore non trovata' }, { status: 400 })
    }

    // Verifica scadenza + ticket (HMAC ricalcolato con l'email autorevole).
    const check = verifyTicket(email, String(code), Number(expiry), String(ticket))
    if (!check.ok) return NextResponse.json({ error: check.error }, { status: 400 })

    // signature_log FES autorevole, costruito lato server
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'N.D.'
    const userAgent = request.headers.get('user-agent') || 'N.D.'
    const timestamp = new Date().toISOString()

    const { data: parent } = await supabase
      .from('utenti')
      .select('nome, cognome')
      .eq('id', parentId)
      .maybeSingle()

    const signature_log = {
      method: 'OTP_EMAIL',
      provider: 'Firma OTP via email (FES)',
      email,
      ip,
      user_agent: userAgent,
      timestamp,
      hash: codeHash(email, String(code), Number(expiry)),
      compliance: 'CAD Art. 20 / DPR 445/2000',
      parent_details: { nome: parent?.nome ?? null, cognome: parent?.cognome ?? null },
    }

    const result = await persistSignedSubmission(supabase, {
      form_id,
      parent_id: parentId,
      student_id,
      answers,
      is_signed: true,
      signature_log,
    })

    if (result.error) {
      return NextResponse.json({ error: result.error }, { status: result.status })
    }

    return NextResponse.json({ ok: true, submission: result.submission, signature_log }, { status: 201 })
  } catch (err: any) {
    console.error('Errore PATCH /api/parent/forms/otp:', err)
    return NextResponse.json({ error: err.message || 'Errore interno' }, { status: 500 })
  }
}
