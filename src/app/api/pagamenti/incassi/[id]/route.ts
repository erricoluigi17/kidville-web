import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'

// PATCH /api/pagamenti/incassi/[id]  (staff) — correzione di un incasso registrato
// Body: { userId, importo?, data_incasso?, metodo?, note? }
// Lo stato del pagamento è ricalcolato automaticamente dal trigger su `incassi`.
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const { user } = auth
    const { id } = await context.params
    const body = await request.json()

    const supabase = await createAdminClient()
    const { data: old } = await supabase.from('incassi').select('*').eq('id', id).single()
    if (!old) return NextResponse.json({ error: 'Incasso non trovato' }, { status: 404 })

    const allowed = ['importo', 'data_incasso', 'metodo', 'note']
    const updates: Record<string, unknown> = {}
    for (const f of allowed) if (body[f] !== undefined) updates[f] = body[f]
    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: 'Nessun campo da aggiornare' }, { status: 400 })
    }
    if (updates.importo !== undefined && Number(updates.importo) === 0) {
      return NextResponse.json({ error: 'importo deve essere ≠ 0' }, { status: 400 })
    }

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

    // stato pagamento ricalcolato dal trigger
    const { data: pagamento } = await supabase
      .from('pagamenti').select('id, importo, importo_pagato, stato, data_incasso')
      .eq('id', incasso.pagamento_id).single()

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
    const { id } = await context.params

    const supabase = await createAdminClient()
    const { data: old } = await supabase.from('incassi').select('*').eq('id', id).single()
    const { error } = await supabase.from('incassi').delete().eq('id', id)
    if (error) return NextResponse.json({ error: 'Errore nello storno', details: error.message }, { status: 500 })

    await supabase.from('registro_modifiche').insert({
      azione: 'storno_incasso',
      tabella_interessata: 'incassi',
      record_id: id,
      vecchio_valore: old,
      utente_id: user.id,
    }).then(() => {}, () => {})

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('Errore API DELETE incasso:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
