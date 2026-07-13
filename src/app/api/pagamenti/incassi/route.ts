import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { applyOverpaymentSpill } from '@/lib/pagamenti/spill'
import { notificaEvento } from '@/lib/notifiche/triggers'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore } from '@/lib/logging/logger'

const getQuerySchema = z.object({
  pagamento_id: zUuid,
})

const postBodySchema = z.object({
  pagamento_id: zUuid,
  // importo può arrivare come numero o stringa numerica; ≠ 0 come da check storico
  importo: z.coerce.number().refine((v) => v !== 0, 'importo deve essere ≠ 0'),
  data_incasso: z.string().nullish(),
  metodo: z.string().nullish(),
  note: z.string().nullish(),
  quota_id: zUuid.nullish(),
  // spill: qualunque valore ≠ false attiva lo spill (comportamento storico)
  spill: z.unknown().optional(),
})

const deleteQuerySchema = z.object({
  id: zUuid,
})

// GET /api/pagamenti/incassi?pagamento_id=xxx&userId=yyy
// Ledger di un pagamento (staff). I genitori leggono gli incassi tramite il
// dettaglio pagamento (route [id]) con scoping RLS-equivalente.
export const GET = withRoute('pagamenti/incassi:GET', async (request: Request) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const pagamentoId = q.data.pagamento_id

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
    logErrore({ operazione: 'pagamenti/incassi:GET', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})

// POST /api/pagamenti/incassi  (staff) — registra una ricevuta
// Body: { userId, pagamento_id, importo, data_incasso?, metodo?, note?, quota_id?, spill? }
// Supporta pagamenti parziali; con spill=true riporta l'eccedenza sulla rata successiva.
export const POST = withRoute('pagamenti/incassi:POST', async (request: Request) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const { user } = auth

    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response
    const body = b.data
    const { pagamento_id, importo } = body

    const supabase = await createAdminClient()

    // verifica esistenza pagamento
    const { data: pag, error: pErr } = await supabase
      .from('pagamenti')
      .select('id, importo, importo_pagato, parent_payment_id, alunno_id, scuola_id, descrizione')
      .eq('id', pagamento_id)
      .maybeSingle()
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
      .maybeSingle()

    // Conferma al genitore: pagamento registrato (best-effort). Il debounce
    // per pagamento collassa gli incassi multipli ravvicinati.
    try {
      if (pag.alunno_id) {
        const saldato = aggiornato?.stato === 'pagato'
        await notificaEvento(supabase, {
          tipo: 'pagamento_registrato',
          scuolaId: (pag.scuola_id as string | undefined) ?? null,
          alunnoIds: [pag.alunno_id as string],
          titolo: saldato ? 'Pagamento registrato' : 'Acconto registrato',
          corpo: `${pag.descrizione ?? 'Pagamento'}: registrato un incasso di ${importo} €.${saldato ? ' La ricevuta è disponibile.' : ''}`,
          link: '/parent/pagamenti',
          entitaTipo: 'pagamento',
          entitaId: pagamento_id,
          debounce: true,
        })
      }
    } catch (e) {
      console.error('Notifica incasso fallita (non bloccante):', e)
    }

    return NextResponse.json({ success: true, data: { incasso, pagamento: aggiornato, spills } }, { status: 201 })
  } catch (err) {
    logErrore({ operazione: 'pagamenti/incassi:POST', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})

// DELETE /api/pagamenti/incassi?id=xxx&userId=yyy  (staff) — storno di un incasso
export const DELETE = withRoute('pagamenti/incassi:DELETE', async (request: Request) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const { user } = auth

    const q = parseQuery(request, deleteQuerySchema)
    if ('response' in q) return q.response
    const id = q.data.id

    const supabase = await createAdminClient()
    const { data: old } = await supabase.from('incassi').select('*').eq('id', id).maybeSingle()
    if (!old) return NextResponse.json({ error: 'Incasso non trovato' }, { status: 404 })
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
    logErrore({ operazione: 'pagamenti/incassi:DELETE', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
