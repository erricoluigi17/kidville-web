import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff, requireUser } from '@/lib/auth/require-staff'

// GET /api/pagamenti/ticket?alunno_id=&userId=
//   staff -> saldo di qualsiasi alunno; genitore -> solo dei propri figli
export async function GET(request: Request) {
  try {
    const auth = await requireUser(request)
    if (auth.response) return auth.response
    const { user } = auth
    const { searchParams } = new URL(request.url)
    const alunnoId = searchParams.get('alunno_id')
    if (!alunnoId) return NextResponse.json({ error: 'alunno_id è obbligatorio' }, { status: 400 })

    const supabase = await createAdminClient()
    const isStaff = user.role === 'admin' || user.role === 'coordinator'
    if (!isStaff) {
      const { data: legame } = await supabase
        .from('legame_genitori_alunni').select('alunno_id')
        .eq('genitore_id', user.id).eq('alunno_id', alunnoId).maybeSingle()
      if (!legame) return NextResponse.json({ error: 'Accesso negato' }, { status: 403 })
    }

    const { data } = await supabase
      .from('ticket_mensa').select('alunno_id, saldo_ticket, ultimo_carico').eq('alunno_id', alunnoId).maybeSingle()
    return NextResponse.json({ success: true, data: data ?? { alunno_id: alunnoId, saldo_ticket: 0, ultimo_carico: null } })
  } catch (err) {
    console.error('Errore API GET ticket:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}

// POST /api/pagamenti/ticket  (staff) — ricarica ticket mensa
// Body: { userId, alunno_id, pezzi, costo, metodo?, scuola_id? }
// Un'unica azione: incrementa saldo_ticket E crea un pagamento Mensa già saldato.
export async function POST(request: Request) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const { user } = auth

    const body = await request.json()
    const { alunno_id, pezzi, costo } = body
    if (!alunno_id || !pezzi || costo == null) {
      return NextResponse.json({ error: 'alunno_id, pezzi e costo sono obbligatori' }, { status: 400 })
    }
    if (Number(pezzi) <= 0 || Number(costo) < 0) {
      return NextResponse.json({ error: 'pezzi > 0 e costo >= 0' }, { status: 400 })
    }

    const supabase = await createAdminClient()
    let scuolaId = body.scuola_id as string | undefined
    if (!scuolaId) {
      const { data: al } = await supabase.from('alunni').select('scuola_id').eq('id', alunno_id).maybeSingle()
      if (!al) return NextResponse.json({ error: 'Alunno non trovato' }, { status: 404 })
      scuolaId = al.scuola_id
    }

    // 1) incrementa saldo ticket (upsert)
    const { data: cur } = await supabase.from('ticket_mensa').select('saldo_ticket').eq('alunno_id', alunno_id).maybeSingle()
    const nuovoSaldo = Number(cur?.saldo_ticket ?? 0) + Number(pezzi)
    const { error: tErr } = await supabase
      .from('ticket_mensa')
      .upsert({ alunno_id, saldo_ticket: nuovoSaldo, ultimo_carico: new Date().toISOString() }, { onConflict: 'alunno_id' })
    if (tErr) return NextResponse.json({ error: 'Errore aggiornamento saldo', details: tErr.message }, { status: 500 })

    // 2) categoria mensa
    const { data: cat } = await supabase
      .from('payment_categories').select('id').eq('slug', 'mensa').is('scuola_id', null).maybeSingle()

    // 3) crea pagamento Mensa
    const { data: pag, error: pErr } = await supabase.from('pagamenti').insert({
      alunno_id, scuola_id: scuolaId, categoria_id: cat?.id,
      descrizione: `Ricarica mensa — ${pezzi} ticket`, importo: costo,
      scadenza: new Date().toISOString().slice(0, 10),
      tipo: 'singolo', obbligatorio: false, creato_da: user.id, stato: 'da_pagare',
    }).select().single()
    if (pErr || !pag) {
      // rollback saldo
      await supabase.from('ticket_mensa').upsert({ alunno_id, saldo_ticket: Number(cur?.saldo_ticket ?? 0) }, { onConflict: 'alunno_id' })
      return NextResponse.json({ error: 'Errore creazione pagamento', details: pErr?.message }, { status: 500 })
    }

    // 4) incasso contestuale (saldato) — il trigger porta lo stato a 'pagato'
    if (Number(costo) > 0) {
      await supabase.from('incassi').insert({
        pagamento_id: pag.id, importo: costo, metodo: body.metodo ?? 'contanti',
        note: 'Ricarica ticket mensa', registrato_da: user.id,
      })
    }

    return NextResponse.json({ success: true, data: { saldo_ticket: nuovoSaldo, pagamento_id: pag.id } }, { status: 201 })
  } catch (err) {
    console.error('Errore API POST ticket:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
