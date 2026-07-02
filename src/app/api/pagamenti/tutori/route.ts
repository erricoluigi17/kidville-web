import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'

const getQuerySchema = z.object({
  alunno_id: zUuid,
})

/** Riga di `legame_genitori_alunni` con l'embed `utenti` (client admin non tipizzato). */
interface LegameTutoreRow {
  genitore_id: string
  percentuale_pagamento: number | null
  intestatario_fattura: boolean | null
  utenti: { id: string; nome: string | null; cognome: string | null; email: string | null } | null
}

// GET /api/pagamenti/tutori?userId=&alunno_id=  (staff)
// Tutori (account `utenti`) collegati all'alunno via legame_genitori_alunni,
// con percentuale_pagamento — base per le quote split dei genitori separati.
export async function GET(request: Request) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const alunnoId = q.data.alunno_id

    const supabase = await createAdminClient()
    const { data, error } = await supabase
      .from('legame_genitori_alunni')
      .select('genitore_id, percentuale_pagamento, intestatario_fattura, utenti:genitore_id ( id, nome, cognome, email )')
      .eq('alunno_id', alunnoId)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    // I tipi generati inferiscono l'embed utenti come array: doppio cast necessario.
    const tutori = ((data || []) as unknown as LegameTutoreRow[]).map((l) => ({
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
