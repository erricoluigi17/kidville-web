import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'

const getQuerySchema = z.object({
  // '' oggi equivale ad assente (filtro saltato): normalizzato prima della validazione
  alunnoId: z.preprocess((v) => (v === '' ? undefined : v), zUuid.optional()),
  // default 100 e cap 500 applicati nell'handler come oggi
  limit: z.coerce.number().optional(),
})

// GET /api/admin/primaria/fascicolo-audit?alunnoId=&limit=&userId=
// Vista di sola lettura del log accessi al fascicolo (immodificabile). Solo staff.
export async function GET(request: NextRequest) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const { alunnoId } = q.data
    const limit = Math.min(q.data.limit ?? 100, 500)

    const supabase = await createAdminClient()
    let query = supabase
      .from('fascicolo_accessi_audit')
      .select('id, alunno_id, documento_id, utente_id, azione, finalita, ip, creato_il, utenti:utente_id(nome, cognome, ruolo, role), alunni:alunno_id(nome, cognome)')
      .order('creato_il', { ascending: false })
      .limit(limit)
    if (alunnoId) query = query.eq('alunno_id', alunnoId)

    const { data, error } = await query
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true, data: data ?? [] })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
