import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireUser } from '@/lib/auth/require-staff'
import { parseData, parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'

// Stringa vuota trattata come assente: preserva i default falsy pre-esistenti
// ('' !== 'true' → false in GET; `if (body.id)` truthy in PATCH).
const vuotoComeAssente = (v: unknown) => (v === '' ? undefined : v)

// Semantica storica preservata: il filtro si attiva SOLO con il literal 'true'
// (niente zBool: '1'/'si' non devono attivarlo, come prima dello sweep).
const getQuerySchema = z.object({
  solo_non_lette: z.string().optional(),
})

// Body: { userId?, id? } — solo `id` è usato dall'handler
// (id assente/null = segna tutte come lette).
const patchBodySchema = z.object({
  id: z.preprocess(vuotoComeAssente, zUuid.nullish()),
})

// GET /api/notifiche?userId=&solo_non_lette=  — notifiche dell'utente corrente
export async function GET(request: Request) {
  try {
    const auth = await requireUser(request)
    if (auth.response) return auth.response
    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const soloNonLette = q.data.solo_non_lette === 'true'

    const supabase = await createAdminClient()
    let query = supabase
      .from('notifiche')
      .select('id, tipo, titolo, corpo, link, entita_tipo, entita_id, letta_il, creato_il')
      .eq('utente_id', auth.user.id)
      .order('creato_il', { ascending: false })
      .limit(100)
    if (soloNonLette) query = query.is('letta_il', null)

    const { data, error } = await query
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    const nonLette = (data || []).filter((n) => !n.letta_il).length
    return NextResponse.json({ success: true, data, non_lette: nonLette })
  } catch (err) {
    console.error('Errore API GET notifiche:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}

// PATCH /api/notifiche  — segna letta una notifica (o tutte)
// Body: { userId, id? }  (senza id = segna tutte come lette)
export async function PATCH(request: Request) {
  try {
    const auth = await requireUser(request)
    if (auth.response) return auth.response
    // Body assente/malformato è tollerato come {} (= segna tutte): default
    // pre-esistente da preservare, quindi lettura tollerante + parseData.
    const raw = await request.json().catch(() => ({}))
    const b = parseData(patchBodySchema, raw)
    if ('response' in b) return b.response

    const supabase = await createAdminClient()
    let q = supabase.from('notifiche').update({ letta_il: new Date().toISOString() }).eq('utente_id', auth.user.id).is('letta_il', null)
    if (b.data.id) q = supabase.from('notifiche').update({ letta_il: new Date().toISOString() }).eq('id', b.data.id).eq('utente_id', auth.user.id)
    const { error } = await q
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('Errore API PATCH notifiche:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
