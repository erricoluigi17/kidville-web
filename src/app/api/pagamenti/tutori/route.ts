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
    const base = ((data || []) as unknown as LegameTutoreRow[]).map((l) => ({
      adult_id: l.genitore_id,
      nome: l.utenti?.nome ?? '',
      cognome: l.utenti?.cognome ?? '',
      email: l.utenti?.email ?? '',
      percentuale: l.percentuale_pagamento ?? null,
      intestatario: !!l.intestatario_fattura,
    }))

    // has_fiscal_code: il CF sta su `parents` (non su `utenti`). L'adult_id è
    // un utenti.id → ponte parents.auth_user_id == utenti.id (oltre a parents.id).
    // Serve alla UI per avvisare che una quota non è fatturabile senza codice fiscale.
    const ids = base.map((t) => t.adult_id)
    const conCF = new Set<string>()
    if (ids.length > 0) {
      const list = ids.join(',')
      const { data: pRows } = await supabase
        .from('parents')
        .select('id, auth_user_id, fiscal_code')
        .or(`id.in.(${list}),auth_user_id.in.(${list})`)
      for (const p of (pRows ?? []) as { id: string; auth_user_id: string | null; fiscal_code: string | null }[]) {
        if (!p.fiscal_code) continue
        if (ids.includes(p.id)) conCF.add(p.id)
        if (p.auth_user_id && ids.includes(p.auth_user_id)) conCF.add(p.auth_user_id)
      }
    }
    const tutori = base.map((t) => ({ ...t, has_fiscal_code: conCF.has(t.adult_id) }))
    return NextResponse.json({ success: true, data: tutori })
  } catch (err) {
    console.error('Errore API GET tutori:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
