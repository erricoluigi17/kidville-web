import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { applyOverpaymentSpill } from '@/lib/pagamenti/spill'

// GET /api/pagamenti/incassi?pagamento_id=xxx&userId=yyy
// Ledger di un pagamento (staff). I genitori leggono gli incassi tramite il
// dettaglio pagamento (route [id]) con scoping RLS-equivalente.
export async function GET(request: Request) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const { searchParams } = new URL(request.url)
    const pagamentoId = searchParams.get('pagamento_id')
    if (!pagamentoId) {
      return NextResponse.json({ error: 'pagamento_id è obbligatorio' }, { status: 400 })
    }

    const supabase = await createAdminClient()
    const { data, error } = await supabase
      .from('incassi')
      .select('id, pagamento_id, importo, data_incasso, metodo, note, quota_id, registrato_da, creato_il')
      .eq('pagamento_id', pagamentoId)
      .order('creato_il', { ascending: true })

    if (error) {
      return NextResponse.json({ error: 'Errore nel recupero del ledger', details: error.message }, { status: 500 })
    }
    return NextResponse.json({ success: true, data })
  } catch (err) {
    console.error('Errore API GET incassi:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}

// POST /api/pagamenti/incassi  (staff) — registra una ricevuta
// Body: { userId, pagamento_id, importo, data_incasso?, metodo?, note?, quota_id?, spill? }
// Supporta pagamenti parziali; con spill=true riporta l'eccedenza sulla rata successiva.
export async function POST(request: Request) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const { user } = auth

    const body = await request.json()
    const { pagamento_id, importo } = body
    if (!pagamento_id || importo == null || Number(importo) === 0) {
      return NextResponse.json(
        { error: 'pagamento_id e importo (≠ 0) sono obbligatori' },
        { status: 400 }
      )
    }

    const supabase = await createAdminClient()

    // verifica esistenza pagamento
    const { data: pag, error: pErr } = await supabase
      .from('pagamenti')
      .select('id, importo, importo_pagato, parent_payment_id')
      .eq('id', pagamento_id)
      .single()
    if (pErr || !pag) {
      return NextResponse.json({ error: 'Pagamento non trovato' }, { status: 404 })
    }

    const { data: incasso, error } = await supabase
      .from('incassi')
      .insert({
        pagamento_id,
        importo,
        data_incasso: body.data_incasso ?? undefined,
        metodo: body.metodo ?? 'contanti',
        note: body.note ?? null,
        quota_id: body.quota_id ?? null,
        registrato_da: user.id,
      })
      .select()
      .single()

    if (error) {
      console.error('Errore POST incasso:', error)
      return NextResponse.json({ error: 'Errore nella registrazione', details: error.message }, { status: 500 })
    }

    // Overpayment spill-over (solo per le rate, opzionale)
    let spills = undefined
    if (body.spill !== false && pag.parent_payment_id) {
      spills = await applyOverpaymentSpill(supabase, pagamento_id, user.id)
    }

    // audit
    await supabase.from('registro_modifiche').insert({
      azione: 'registra_incasso',
      tabella_interessata: 'incassi',
      record_id: incasso.id,
      nuovo_valore: incasso,
      utente_id: user.id,
    }).then(() => {}, () => {}) // best-effort

    // stato aggiornato dal trigger
    const { data: aggiornato } = await supabase
      .from('pagamenti')
      .select('id, importo, importo_pagato, stato, data_incasso')
      .eq('id', pagamento_id)
      .single()

    return NextResponse.json({ success: true, data: { incasso, pagamento: aggiornato, spills } }, { status: 201 })
  } catch (err) {
    console.error('Errore API POST incassi:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}

// DELETE /api/pagamenti/incassi?id=xxx&userId=yyy  (staff) — storno di un incasso
export async function DELETE(request: Request) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const { user } = auth

    const { searchParams } = new URL(request.url)
    const id = searchParams.get('id')
    if (!id) return NextResponse.json({ error: 'id è obbligatorio' }, { status: 400 })

    const supabase = await createAdminClient()
    const { data: old } = await supabase.from('incassi').select('*').eq('id', id).single()
    const { error } = await supabase.from('incassi').delete().eq('id', id)
    if (error) {
      return NextResponse.json({ error: 'Errore nello storno', details: error.message }, { status: 500 })
    }

    await supabase.from('registro_modifiche').insert({
      azione: 'storno_incasso',
      tabella_interessata: 'incassi',
      record_id: id,
      vecchio_valore: old,
      utente_id: user.id,
    }).then(() => {}, () => {})

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('Errore API DELETE incassi:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
