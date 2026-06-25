import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { getRequestUserId } from '@/lib/auth/require-staff'

// GET /api/parent/primaria/note?studentId=&userId=
// Note disciplinari/didattiche del figlio. Filtrate per oscuramento.
export async function GET(request: NextRequest) {
  try {
    const sp = new URL(request.url).searchParams
    const studentId = sp.get('studentId')
    const userId = getRequestUserId(request)
    if (!userId) return NextResponse.json({ error: 'Non autenticato' }, { status: 401 })
    if (!studentId) return NextResponse.json({ error: 'studentId obbligatorio' }, { status: 400 })

    const supabase = await createAdminClient()
    const { data: note } = await supabase
      .from('note_disciplinari')
      .select('id, categoria, testo, richiede_firma, firmata_il, creato_il')
      .eq('alunno_id', studentId)
      .order('creato_il', { ascending: false })

    return NextResponse.json({ success: true, data: note ?? [] })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

// POST /api/parent/primaria/note — DEPRECATO (DL-014).
// La presa visione con firma (timestamp semplice) è stata sostituita dal flusso
// FEA OTP/FES su POST /api/parent/primaria/note/firma (+ /firma/otp). Questo
// endpoint risponde 410 per impedire firme prive di evidenza FES.
export async function POST() {
  return NextResponse.json(
    { error: 'Endpoint deprecato: usa /api/parent/primaria/note/firma (firma OTP/FES).' },
    { status: 410 }
  )
}
