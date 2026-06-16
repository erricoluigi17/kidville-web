import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff, requireUser } from '@/lib/auth/require-staff'

const SELECT = `
  id, alunno_id, scuola_id, descrizione, importo, importo_pagato, scadenza, stato,
  tipo, obbligatorio, categoria_id, parent_payment_id, gruppo, periodo_competenza, visibile_dal,
  fattura_stato, fattura_pdf_path, fattura_aruba_id, fattura_emessa_il,
  data_incasso, ultimo_sollecito_il, creato_il, aggiornato_il,
  payment_categories ( id, nome, slug, colore, icona ),
  alunni ( id, nome, cognome, classe_sezione )
`

// GET /api/pagamenti/[id]?userId=yyy — dettaglio + incassi + quote (+ rate se padre)
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireUser(request)
    if (auth.response) return auth.response
    const { user } = auth
    const { id } = await context.params

    const supabase = await createAdminClient()
    const { data, error } = await supabase.from('pagamenti').select(SELECT).eq('id', id).single()
    if (error || !data) return NextResponse.json({ error: 'Pagamento non trovato' }, { status: 404 })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pag = data as any

    const isStaff = user.role === 'admin' || user.role === 'coordinator'

    // scoping genitore
    let ownQuotaId: string | null = null
    if (!isStaff) {
      const { data: legame } = await supabase
        .from('legame_genitori_alunni')
        .select('alunno_id')
        .eq('genitore_id', user.id)
        .eq('alunno_id', pag.alunno_id)
        .maybeSingle()
      if (!legame) return NextResponse.json({ error: 'Accesso negato' }, { status: 403 })

      // visibilità ritardata: il genitore non può aprire un pagamento non ancora pubblicato
      const oggi = new Date().toISOString().slice(0, 10)
      if (pag.visibile_dal && String(pag.visibile_dal) > oggi) {
        return NextResponse.json({ error: 'Pagamento non ancora disponibile' }, { status: 403 })
      }

      if (pag.tipo === 'split') {
        const { data: q } = await supabase
          .from('pagamenti_quote')
          .select('id, importo')
          .eq('pagamento_id', id)
          .eq('adult_id', user.id)
          .maybeSingle()
        if (!q) return NextResponse.json({ error: 'Accesso negato' }, { status: 403 })
        ownQuotaId = q.id
        // proietta la propria quota come importo
        pag.importo_totale_famiglia = pag.importo
        pag.importo = Number(q.importo)
      }
    }

    // incassi
    let incassiQuery = supabase
      .from('incassi')
      .select('id, pagamento_id, importo, data_incasso, metodo, note, quota_id, registrato_da, creato_il')
      .eq('pagamento_id', id)
      .order('creato_il', { ascending: true })
    if (ownQuotaId) incassiQuery = incassiQuery.eq('quota_id', ownQuotaId)
    const { data: incassi } = await incassiQuery

    // quote (staff vede tutte; genitore solo la propria)
    let quoteQuery = supabase
      .from('pagamenti_quote')
      .select('id, pagamento_id, adult_id, importo, etichetta, utenti:adult_id ( id, nome, cognome )')
      .eq('pagamento_id', id)
    if (!isStaff) quoteQuery = quoteQuery.eq('adult_id', user.id)
    const { data: quote } = pag.tipo === 'split' ? await quoteQuery : { data: [] }

    // rate (se è un padre rateizzato)
    let rate: unknown[] = []
    if (pag.tipo === 'padre') {
      const { data: r } = await supabase
        .from('pagamenti')
        .select('id, descrizione, importo, importo_pagato, scadenza, stato')
        .eq('parent_payment_id', id)
        .order('scadenza', { ascending: true })
      rate = r || []
    }

    return NextResponse.json({ success: true, data: { ...pag, incassi: incassi || [], quote: quote || [], rate } })
  } catch (err) {
    console.error('Errore API GET pagamento dettaglio:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}

// PATCH /api/pagamenti/[id]  (staff) — modifica campi editabili
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const { id } = await context.params
    const body = await request.json()

    const allowed = ['descrizione', 'importo', 'scadenza', 'categoria_id', 'obbligatorio', 'periodo_competenza', 'gruppo', 'tipo', 'visibile_dal']
    const updates: Record<string, unknown> = {}
    for (const f of allowed) if (body[f] !== undefined) updates[f] = body[f]
    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: 'Nessun campo da aggiornare' }, { status: 400 })
    }
    updates.aggiornato_il = new Date().toISOString()

    const supabase = await createAdminClient()
    const { data, error } = await supabase.from('pagamenti').update(updates).eq('id', id).select(SELECT).single()
    if (error) return NextResponse.json({ error: 'Errore aggiornamento', details: error.message }, { status: 500 })

    // se è cambiato l'importo, ricalcola lo stato dal ledger
    if (updates.importo !== undefined) {
      await supabase.rpc('ricalcola_stato_pagamento', { p_id: id }).then(() => {}, () => {})
    }

    return NextResponse.json({ success: true, data })
  } catch (err) {
    console.error('Errore API PATCH pagamento:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}

// DELETE /api/pagamenti/[id]  (staff)
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const { user } = auth
    const { id } = await context.params

    const supabase = await createAdminClient()
    const { data: old } = await supabase.from('pagamenti').select('*').eq('id', id).single()
    const { error } = await supabase.from('pagamenti').delete().eq('id', id)
    if (error) return NextResponse.json({ error: 'Errore eliminazione', details: error.message }, { status: 500 })

    await supabase.from('registro_modifiche').insert({
      azione: 'elimina_pagamento',
      tabella_interessata: 'pagamenti',
      record_id: id,
      vecchio_valore: old,
      utente_id: user.id,
    }).then(() => {}, () => {})

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('Errore API DELETE pagamento:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
