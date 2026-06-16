import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'

// GET /api/pagamenti/tutori?userId=&alunno_id=  (staff)
// Tutori (account `utenti`) collegati all'alunno via legame_genitori_alunni,
// con percentuale_pagamento — base per le quote split dei genitori separati.
export async function GET(request: Request) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const { searchParams } = new URL(request.url)
    const alunnoId = searchParams.get('alunno_id')
    if (!alunnoId) return NextResponse.json({ error: 'alunno_id è obbligatorio' }, { status: 400 })

    const supabase = await createAdminClient()
    const { data, error } = await supabase
      .from('legame_genitori_alunni')
      .select('genitore_id, percentuale_pagamento, intestatario_fattura, utenti:genitore_id ( id, nome, cognome, email )')
      .eq('alunno_id', alunnoId)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    const tutori = (data || []).map((l: any) => ({
      adult_id: l.genitore_id,
      nome: l.utenti?.nome ?? '',
      cognome: l.utenti?.cognome ?? '',
      email: l.utenti?.email ?? '',
      percentuale: l.percentuale_pagamento ?? null,
      intestatario: !!l.intestatario_fattura,
    }))
    return NextResponse.json({ success: true, data: tutori })
  } catch (err) {
    console.error('Errore API GET tutori:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
