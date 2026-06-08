import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { getRequestUserId } from '@/lib/auth/require-staff'
import { getUserEmail, verifyTicket, codeHash } from '@/lib/auth/otp-ticket'

// POST /api/parent/presenze/giustifica?userId=
// body: { studentId, data, motivo, code, expiry, ticket }
// Il genitore giustifica un'assenza/ritardo/uscita del figlio. Solo primaria.
// Protetta da conferma OTP email (FES): richiedi prima l'OTP via /giustifica/otp.
export async function POST(request: NextRequest) {
  try {
    const userId = getRequestUserId(request)
    if (!userId) return NextResponse.json({ error: 'Non autenticato' }, { status: 401 })

    const { studentId, data, motivo, code, expiry, ticket } = await request.json()
    if (!studentId || !data) {
      return NextResponse.json({ error: 'studentId e data obbligatori' }, { status: 400 })
    }

    const supabase = await createAdminClient()

    // Conferma OTP email (FES) prima di procedere.
    const email = await getUserEmail(supabase, userId)
    if (!email) return NextResponse.json({ error: 'Email del genitore non trovata' }, { status: 400 })
    const check = verifyTicket(email, String(code ?? ''), Number(expiry ?? 0), String(ticket ?? ''))
    if (!check.ok) return NextResponse.json({ error: check.error }, { status: 400 })

    // Gating primaria: la giustifica genitore è ammessa solo per la scuola primaria.
    const { data: alunno } = await supabase
      .from('alunni')
      .select('id, section_id')
      .eq('id', studentId)
      .single()
    if (!alunno) return NextResponse.json({ error: 'Alunno non trovato' }, { status: 404 })

    let schoolType: string | null = null
    if (alunno.section_id) {
      const { data: sez } = await supabase.from('sections').select('school_type').eq('id', alunno.section_id).single()
      schoolType = sez?.school_type ?? null
    }
    if (schoolType !== 'primaria') {
      return NextResponse.json({ error: 'Giustifica disponibile solo per la scuola primaria' }, { status: 403 })
    }

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

    // Aggiorna la riga presenza del giorno (deve esistere: appello registrato dal docente).
    const { data: updated, error } = await supabase
      .from('presenze')
      .update({
        giustificata: true,
        giustificazione_testo: typeof motivo === 'string' ? motivo.trim() || null : null,
        giustificata_da: userId,
        giustificata_il: new Date().toISOString(),
        giustificazione_firma: firma,
        // Una nuova giustifica azzera l'eventuale presa visione precedente.
        giust_vista_il: null,
        giust_vista_da: null,
      })
      .eq('alunno_id', studentId)
      .eq('data', data)
      .select()
      .maybeSingle()

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    if (!updated) return NextResponse.json({ error: 'Nessuna assenza registrata per quella data' }, { status: 404 })

    return NextResponse.json({ success: true, data: updated })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
