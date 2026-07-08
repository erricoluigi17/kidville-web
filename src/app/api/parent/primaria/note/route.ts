import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireParentOfStudent } from '@/lib/auth/require-parent'
import { parseQuery } from '@/lib/validation/http'

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
// `userId` in query è consumato dal gate identità (getRequestUserId), non dall'handler.
// studentId permissivo (stringa non vuota): oggi nessun vincolo di formato
// (un id non valido produce già lista vuota, l'errore supabase è ignorato).
const getQuerySchema = z.object({
  studentId: z.string({ error: 'studentId obbligatorio' }).min(1, 'studentId obbligatorio'),
})

const postQuerySchema = z.object({}) // nessun parametro in ingresso (endpoint deprecato)

// GET /api/parent/primaria/note?studentId=&userId=
// Note disciplinari/didattiche del figlio. Filtrate per oscuramento.
export async function GET(request: NextRequest) {
  try {
    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const { studentId } = q.data

    const auth = await requireParentOfStudent(request, studentId)
    if (auth.response) return auth.response

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
export async function POST(request: NextRequest) {
  const q = parseQuery(request, postQuerySchema)
  if ('response' in q) return q.response

  return NextResponse.json(
    { error: 'Endpoint deprecato: usa /api/parent/primaria/note/firma (firma OTP/FES).' },
    { status: 410 }
  )
}
