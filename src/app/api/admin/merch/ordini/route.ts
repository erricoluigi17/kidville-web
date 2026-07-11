import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { scuoleDiUtente } from '@/lib/auth/scope'
import { logScrittura } from '@/lib/audit/scrittura'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'

// Ordini Merchandise lato staff (Fase B, move da /api/admin/divise/ordini) —
// lista con embed alunno + righe; PATCH stato testata (vocabolario legacy).
// Service-role + scoping per plesso (scuoleDiUtente) + audit.

const getQuerySchema = z.object({
  stato: z.enum(['inviato', 'confermato', 'consegnato', 'annullato']).optional(),
})

const patchBodySchema = z.object({
  id: zUuid,
  stato: z.enum(['inviato', 'confermato', 'consegnato', 'annullato']),
})

// GET /api/admin/merch/ordini — ordini dei plessi dell'utente (alunno + righe)
export async function GET(request: Request) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response

    const supabase = await createAdminClient()
    const plessi = await scuoleDiUtente(supabase, auth.user)
    if (plessi.length === 0) return NextResponse.json({ success: true, data: [] })

    let query = supabase
      .from('divise_ordini')
      .select(
        'id, scuola_id, alunno_id, parent_id, stato, totale, pagamento_id, note, creato_il, ' +
          'alunni:alunno_id ( nome, cognome, classe_sezione ), ' +
          'righe:divise_ordini_righe ( id, articolo_id, articolo_nome, taglia, quantita, prezzo_unitario )'
      )
      .in('scuola_id', plessi)
      .order('creato_il', { ascending: false })
      .limit(200)
    if (q.data.stato) query = query.eq('stato', q.data.stato)

    const { data, error } = await query
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true, data: data ?? [] })
  } catch (err) {
    console.error('Errore API GET merch/ordini:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}

// PATCH /api/admin/merch/ordini — avanza lo stato dell'ordine (testata legacy)
export async function PATCH(request: Request) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const b = await parseBody(request, patchBodySchema)
    if ('response' in b) return b.response
    const { id, stato } = b.data

    const supabase = await createAdminClient()
    const plessi = await scuoleDiUtente(supabase, auth.user)
    const { data: existing } = await supabase
      .from('divise_ordini')
      .select('id, scuola_id, stato')
      .eq('id', id)
      .maybeSingle()
    if (!existing) return NextResponse.json({ error: 'Ordine non trovato' }, { status: 404 })
    if (!plessi.includes(existing.scuola_id as string)) {
      return NextResponse.json({ error: 'Accesso negato: ordine fuori dal tuo plesso' }, { status: 403 })
    }

    const { data, error } = await supabase
      .from('divise_ordini')
      .update({ stato })
      .eq('id', id)
      .select('id, stato')
      .single()
    if (error || !data) {
      return NextResponse.json({ error: error?.message ?? 'Aggiornamento fallito' }, { status: 500 })
    }

    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'merch_ordine',
      entitaId: id,
      azione: 'update',
      scuolaId: existing.scuola_id as string,
      valorePrima: { stato: existing.stato },
      valoreDopo: { stato },
    })
    return NextResponse.json({ success: true, data })
  } catch (err) {
    console.error('Errore API PATCH merch/ordini:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
