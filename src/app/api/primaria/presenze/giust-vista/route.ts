import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { getRequestUserId } from '@/lib/auth/require-staff'

// POST /api/primaria/presenze/giust-vista?userId=
// body: { presenzaId }
// Il docente registra la presa visione della giustifica del genitore.
export async function POST(request: NextRequest) {
  try {
    const userId = getRequestUserId(request)
    if (!userId) return NextResponse.json({ error: 'Non autenticato' }, { status: 401 })

    const { presenzaId } = await request.json()
    if (!presenzaId) return NextResponse.json({ error: 'presenzaId obbligatorio' }, { status: 400 })

    const supabase = await createAdminClient()
    const { data: updated, error } = await supabase
      .from('presenze')
      .update({ giust_vista_il: new Date().toISOString(), giust_vista_da: userId })
      .eq('id', presenzaId)
      .eq('giustificata', true)
      .select()
      .maybeSingle()

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    if (!updated) return NextResponse.json({ error: 'Presenza non giustificata o inesistente' }, { status: 404 })

    return NextResponse.json({ success: true, data: updated })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
