import { NextRequest, NextResponse } from 'next/server'
import { createHash, createHmac, randomInt, timingSafeEqual } from 'crypto'
import { createAdminClient } from '@/lib/supabase/server-client'
import { sendEmail } from '@/lib/email/send'
import { persistSignedSubmission } from '@/lib/forms/persist-submission'
import type { SupabaseClient } from '@supabase/supabase-js'

const DEFAULT_PARENT_ID = '33333333-3333-3333-3333-333333333333'
const OTP_TTL_MS = 10 * 60 * 1000 // 10 minuti

// Segreto server-side per firmare il ticket (mai esposto al client).
function ticketSecret(): string {
  return (
    process.env.OTP_TICKET_SECRET ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    'kidville-dev-secret'
  )
}

/**
 * Ticket = HMAC-SHA256(secret, email:code:expiry).
 * Essendo "keyed", il client non può derivare il codice a 6 cifre dal ticket
 * (niente brute-force offline) né alterarne i parametri firmati.
 */
function makeTicket(email: string, code: string, expiry: number): string {
  return createHmac('sha256', ticketSecret()).update(`${email}:${code}:${expiry}`).digest('hex')
}

function safeEqualHex(a: string, b: string): boolean {
  try {
    const ba = Buffer.from(a, 'hex')
    const bb = Buffer.from(b, 'hex')
    return ba.length === bb.length && timingSafeEqual(ba, bb)
  } catch {
    return false
  }
}

async function getParentEmail(supabase: SupabaseClient, parentId: string): Promise<string | null> {
  const { data } = await supabase.from('utenti').select('email').eq('id', parentId).maybeSingle()
  return data?.email ?? null
}

// ── POST: genera e invia il codice OTP via email, ritorna il ticket firmato ──
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const parentId = body.parent_id || DEFAULT_PARENT_ID

    const supabase = await createAdminClient()
    const email = await getParentEmail(supabase, parentId)
    if (!email) {
      return NextResponse.json({ error: 'Email del genitore non trovata' }, { status: 400 })
    }

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
    const expiry = Date.now() + OTP_TTL_MS
    const ticket = makeTicket(email, code, expiry)

    const sent = await sendEmail({
      to: email,
      subject: 'Codice di firma elettronica — Kidville',
      text: `Il tuo codice di firma è: ${code}\n\nInseriscilo per completare la firma del modulo. Il codice è valido per 10 minuti.`,
    })

    return NextResponse.json({
      email,
      expiry,
      ticket,
      sent,
      // In dev (nessun provider email) restituiamo il codice per il test.
      ...(process.env.NODE_ENV !== 'production' ? { devCode: code } : {}),
    })
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

    if (!code || !expiry || !ticket || !form_id || !answers) {
      return NextResponse.json({ error: 'Parametri mancanti' }, { status: 400 })
    }

    if (Date.now() > Number(expiry)) {
      return NextResponse.json({ error: 'Codice scaduto, richiedine uno nuovo' }, { status: 400 })
    }

    const supabase = await createAdminClient()
    const email = await getParentEmail(supabase, parentId)
    if (!email) {
      return NextResponse.json({ error: 'Email del genitore non trovata' }, { status: 400 })
    }

    // Verifica il ticket ricalcolando l'HMAC con l'email autorevole (server-side)
    const expected = makeTicket(email, String(code), Number(expiry))
    if (!safeEqualHex(expected, String(ticket))) {
      return NextResponse.json({ error: 'Codice non valido' }, { status: 400 })
    }

    // signature_log FES autorevole, costruito lato server
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'N.D.'
    const userAgent = request.headers.get('user-agent') || 'N.D.'
    const timestamp = new Date().toISOString()
    const codeHash = createHash('sha256').update(`${email}:${code}:${expiry}`).digest('hex')

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
      hash: `SHA256-${codeHash.slice(0, 32).toUpperCase()}`,
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
