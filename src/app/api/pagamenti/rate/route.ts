import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'

// POST /api/pagamenti/rate  (staff) — crea un piano rateale: 1 padre + N rate
// Body: { userId, alunno_id, descrizione, importo_totale, rate: [{importo, scadenza}],
//         categoria_id?, obbligatorio?, scuola_id? }
export async function POST(request: Request) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const { user } = auth

    const body = await request.json()
    const { alunno_id, descrizione, importo_totale, rate } = body
    if (!alunno_id || !descrizione || !Array.isArray(rate) || rate.length < 2) {
      return NextResponse.json({ error: 'alunno_id, descrizione e almeno 2 rate sono obbligatori' }, { status: 400 })
    }
    for (const r of rate) {
      if (r.importo == null || !r.scadenza) {
        return NextResponse.json({ error: 'Ogni rata richiede importo e scadenza' }, { status: 400 })
      }
    }
    const somma = rate.reduce((s: number, r: { importo: number }) => s + Number(r.importo), 0)
    const tot = Number(importo_totale ?? somma)
    if (Math.abs(somma - tot) > 0.01) {
      return NextResponse.json({ error: `La somma delle rate (${somma}) deve coincidere col totale (${tot})` }, { status: 400 })
    }

    const supabase = await createAdminClient()
    let scuolaId = body.scuola_id as string | undefined
    if (!scuolaId) {
      const { data: al } = await supabase.from('alunni').select('scuola_id').eq('id', alunno_id).maybeSingle()
      if (!al) return NextResponse.json({ error: 'Alunno non trovato' }, { status: 404 })
      scuolaId = al.scuola_id
    }

    const scadenze = rate.map((r: { scadenza: string }) => r.scadenza).sort()
    const ultimaScadenza = scadenze[scadenze.length - 1]

    // padre
    const { data: padre, error: pErr } = await supabase.from('pagamenti').insert({
      alunno_id, scuola_id: scuolaId, descrizione, importo: tot, scadenza: ultimaScadenza,
      categoria_id: body.categoria_id ?? null, tipo: 'padre', obbligatorio: body.obbligatorio ?? true,
      creato_da: user.id, stato: 'da_pagare',
    }).select().single()
    if (pErr || !padre) {
      return NextResponse.json({ error: 'Errore creazione piano', details: pErr?.message }, { status: 500 })
    }

    // rate figlie
    const figlie = rate.map((r: { importo: number; scadenza: string }, i: number) => ({
      alunno_id, scuola_id: scuolaId, descrizione: `${descrizione} — Rata ${i + 1}/${rate.length}`,
      importo: r.importo, scadenza: r.scadenza, categoria_id: body.categoria_id ?? null,
      tipo: 'rata', obbligatorio: body.obbligatorio ?? true, parent_payment_id: padre.id,
      creato_da: user.id, stato: 'da_pagare',
    }))
    const { data: created, error: rErr } = await supabase.from('pagamenti').insert(figlie).select()
    if (rErr) {
      await supabase.from('pagamenti').delete().eq('id', padre.id) // rollback padre
      return NextResponse.json({ error: 'Errore creazione rate', details: rErr.message }, { status: 500 })
    }

    return NextResponse.json({ success: true, data: { padre, rate: created } }, { status: 201 })
  } catch (err) {
    console.error('Errore API POST rate:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
