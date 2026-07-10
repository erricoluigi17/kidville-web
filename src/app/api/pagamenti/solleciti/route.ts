import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { resolveScuoleAttive } from '@/lib/auth/scope'
import { sollecitaPagamenti } from '@/lib/pagamenti/solleciti-invio'

const zUuidQueryOpzionale = z.preprocess((v) => (v === '' ? undefined : v), zUuid.optional())

const getQuerySchema = z.object({
  pagamento_id: zUuidQueryOpzionale,
})

const postBodySchema = z.object({
  pagamento_ids: z.array(zUuid).min(1).max(200),
  livello: z.coerce.number().int().min(1).max(3).optional(),
  anteprima: z.boolean().optional(),
})

const SCHEMA_MANCANTE = new Set(['42P01', '42703', 'PGRST204', 'PGRST205'])

// GET /api/pagamenti/solleciti?pagamento_id= — storico invii (staff).
export async function GET(request: NextRequest) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response

    const supabase = await createAdminClient()
    const sediAttive = await resolveScuoleAttive(request, supabase, auth.user)

    let query = supabase
      .from('solleciti')
      .select('id, pagamento_id, alunno_id, livello, canale, oggetto, automatico, inviato_il')
      .in('scuola_id', sediAttive)
      .order('inviato_il', { ascending: false })
      .limit(300)
    if (q.data.pagamento_id) query = query.eq('pagamento_id', q.data.pagamento_id)

    const { data, error } = await query
    if (error) {
      if (SCHEMA_MANCANTE.has(error.code ?? '')) return NextResponse.json({ success: true, data: [], disponibile: false })
      return NextResponse.json({ error: 'Errore nel recupero dei solleciti' }, { status: 500 })
    }
    return NextResponse.json({ success: true, data: data || [] })
  } catch (err) {
    console.error('Errore API GET solleciti:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}

// POST /api/pagamenti/solleciti — invio manuale (staff). Con `anteprima: true`
// rende i testi SENZA inviare: la conferma esplicita è un secondo POST.
export async function POST(request: Request) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response

    const supabase = await createAdminClient()
    const sediAttive = await resolveScuoleAttive(request as NextRequest, supabase, auth.user)

    const esiti = await sollecitaPagamenti(supabase, b.data.pagamento_ids, {
      livello: b.data.livello,
      anteprima: !!b.data.anteprima,
      automatico: false,
      attoreId: auth.user.id,
      sediAmmesse: sediAttive,
    })
    return NextResponse.json({ success: true, data: esiti })
  } catch (err) {
    console.error('Errore API POST solleciti:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
