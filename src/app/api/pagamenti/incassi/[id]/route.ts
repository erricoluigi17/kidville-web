import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { parseBody, parseData } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { annullaRicevutaAttiva } from '@/lib/pagamenti/ricevute'

const patchBodySchema = z
  .object({
    // importo può arrivare come numero o stringa numerica; ≠ 0 come da check storico
    importo: z.coerce.number().optional(),
    data_incasso: z.string().nullish(),
    metodo: z.string().nullish(),
    note: z.string().nullish(),
  })
  .refine(
    (b) =>
      b.importo !== undefined ||
      b.data_incasso !== undefined ||
      b.metodo !== undefined ||
      b.note !== undefined,
    'Nessun campo da aggiornare'
  )
  .refine((b) => b.importo === undefined || b.importo !== 0, 'importo deve essere ≠ 0')

// PATCH /api/pagamenti/incassi/[id]  (staff) — correzione di un incasso registrato
// Body: { userId, importo?, data_incasso?, metodo?, note? }
// Lo stato del pagamento è ricalcolato automaticamente dal trigger su `incassi`.
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const { user } = auth
    const { id: rawId } = await context.params
    const idParsed = parseData(zUuid, rawId)
    if ('response' in idParsed) return idParsed.response
    const id = idParsed.data

    const b = await parseBody(request, patchBodySchema)
    if ('response' in b) return b.response
    const body = b.data

    const supabase = await createAdminClient()
    const { data: old } = await supabase.from('incassi').select('*').eq('id', id).maybeSingle()
    if (!old) return NextResponse.json({ error: 'Incasso non trovato' }, { status: 404 })

    const allowed = ['importo', 'data_incasso', 'metodo', 'note'] as const
    const updates: Record<string, unknown> = {}
    for (const f of allowed) if (body[f] !== undefined) updates[f] = body[f]

    const { data: incasso, error } = await supabase
      .from('incassi').update(updates).eq('id', id).select().single()
    if (error) {
      return NextResponse.json({ error: 'Errore aggiornamento incasso', details: error.message }, { status: 500 })
    }

    await supabase.from('registro_modifiche').insert({
      azione: 'modifica_incasso',
      tabella_interessata: 'incassi',
      record_id: id,
      vecchio_valore: old,
      nuovo_valore: incasso,
      utente_id: user.id,
    }).then(() => {}, () => {})

    // La ricevuta fotografa importi e metodi al saldo: se cambiano va annullata
    // (numero bruciato); al prossimo download se ne emette una nuova.
    if (updates.importo !== undefined || updates.metodo !== undefined) {
      await annullaRicevutaAttiva(supabase, incasso.pagamento_id as string, { da: user.id, motivo: 'modifica incasso' })
    }

    // stato pagamento ricalcolato dal trigger
    const { data: pagamento } = await supabase
      .from('pagamenti').select('id, importo, importo_pagato, stato, data_incasso')
      .eq('id', incasso.pagamento_id).maybeSingle()

    return NextResponse.json({ success: true, data: { incasso, pagamento } })
  } catch (err) {
    console.error('Errore API PATCH incasso:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}

// DELETE /api/pagamenti/incassi/[id]  (staff) — storno di un incasso (variante REST path)
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const { user } = auth
    const { id: rawId } = await context.params
    const idParsed = parseData(zUuid, rawId)
    if ('response' in idParsed) return idParsed.response
    const id = idParsed.data

    const supabase = await createAdminClient()
    const { data: old } = await supabase.from('incassi').select('*').eq('id', id).maybeSingle()
    if (!old) return NextResponse.json({ error: 'Incasso non trovato' }, { status: 404 })
    const { error } = await supabase.from('incassi').delete().eq('id', id)
    if (error) return NextResponse.json({ error: 'Errore nello storno', details: error.message }, { status: 500 })

    await supabase.from('registro_modifiche').insert({
      azione: 'storno_incasso',
      tabella_interessata: 'incassi',
      record_id: id,
      vecchio_valore: old,
      utente_id: user.id,
    }).then(() => {}, () => {})

    await annullaRicevutaAttiva(supabase, old.pagamento_id as string, { da: user.id, motivo: 'storno incasso' })

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('Errore API DELETE incasso:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
