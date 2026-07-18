import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff, requireUser } from '@/lib/auth/require-staff'
import { parseBody, parseData } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { resolveScuoleAttive } from '@/lib/auth/scope'
import { annullaRicevutaAttiva } from '@/lib/pagamenti/ricevute'
import { verificaRevocaSospensioneMorosita } from '@/lib/pagamenti/sospensione'
import { notificaEvento } from '@/lib/notifiche/triggers'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'

// ─── Schemi di validazione input (M3 + Contabilità v2 S3) ────────────────────
// PATCH: merge parziale sui soli campi ammessi, ora TIPIZZATI (finding #3: prima
// era z.unknown() e scriveva raw → importi negativi passavano). Importo ≥ 0
// (zero ammesso: esenzioni); scadenza/visibile_dal in formato YYYY-MM-DD.
const patchBodySchema = z.object({
  descrizione: z.string().optional(),
  importo: z.coerce.number().min(0, 'L\'importo non può essere negativo').optional(),
  scadenza: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Scadenza non valida (atteso YYYY-MM-DD)').optional(),
  categoria_id: zUuid.nullish(),
  obbligatorio: z.boolean().optional(),
  periodo_competenza: z.string().nullish(),
  gruppo: z.string().nullish(),
  tipo: z.string().optional(),
  visibile_dal: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data non valida (atteso YYYY-MM-DD)').nullish(),
})

const CAMPI_EDITABILI = [
  'descrizione', 'importo', 'scadenza', 'categoria_id', 'obbligatorio',
  'periodo_competenza', 'gruppo', 'tipo', 'visibile_dal',
] as const

// Dettaglio pagamento: soli campi usati dalla logica di proiezione qui sotto
// (il resto viaggia com'è nello spread finale).
interface PagamentoDettaglio {
  alunno_id: string
  tipo: string
  visibile_dal: string | null
  importo: number
  importo_totale_famiglia?: number
  [key: string]: unknown
}

const SELECT = `
  id, alunno_id, scuola_id, descrizione, importo, importo_pagato, scadenza, stato,
  tipo, obbligatorio, categoria_id, parent_payment_id, gruppo, periodo_competenza, visibile_dal,
  fattura_stato, fattura_pdf_path, fattura_aruba_id, fattura_emessa_il,
  data_incasso, ultimo_sollecito_il, creato_il, aggiornato_il,
  payment_categories ( id, nome, slug, colore, icona ),
  alunni ( id, nome, cognome, classe_sezione )
`

// GET /api/pagamenti/[id]?userId=yyy — dettaglio + incassi + quote (+ rate se padre)
export const GET = withRoute('pagamenti/[id]:GET', async (request: Request, context: { params: Promise<{ id: string }> }) => {
  try {
    const auth = await requireUser(request)
    if (auth.response) return auth.response
    const { user } = auth
    const { id: idGrezzo } = await context.params
    const pid = parseData(zUuid, idGrezzo)
    if ('response' in pid) return pid.response
    const id = pid.data

    const supabase = await createAdminClient()
    const { data, error } = await supabase.from('pagamenti').select(SELECT).eq('id', id).maybeSingle()
    if (error || !data) return NextResponse.json({ error: 'Pagamento non trovato' }, { status: 404 })
    const pag = data as unknown as PagamentoDettaglio

    const isStaff = user.role === 'admin' || user.role === 'coordinator' || user.role === 'segreteria'

    // scoping di sede (staff): il pagamento deve stare in una sede attiva
    if (isStaff) {
      const sedi = await resolveScuoleAttive(request as NextRequest, supabase, user)
      if (!sedi.includes(String(pag.scuola_id))) {
        return NextResponse.json({ error: 'Pagamento non trovato' }, { status: 404 })
      }
    }

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
    logErrore({ operazione: 'pagamenti/[id]:GET', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})

// PATCH /api/pagamenti/[id]  (staff) — modifica campi editabili
export const PATCH = withRoute('pagamenti/[id]:PATCH', async (request: Request, context: { params: Promise<{ id: string }> }) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const { id: idGrezzo } = await context.params
    const pid = parseData(zUuid, idGrezzo)
    if ('response' in pid) return pid.response
    const id = pid.data

    const b = await parseBody(request, patchBodySchema)
    if ('response' in b) return b.response
    const body = b.data

    const updates: Record<string, unknown> = {}
    for (const f of CAMPI_EDITABILI) if (body[f] !== undefined) updates[f] = body[f]
    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: 'Nessun campo da aggiornare' }, { status: 400 })
    }
    updates.aggiornato_il = new Date().toISOString()

    const supabase = await createAdminClient()
    // scoping di sede: non modificare pagamenti fuori dalle sedi attive.
    // Legge anche importo_pagato + sconto per la guardia importo (retry senza sconto
    // su DB non migrato → sconto = 0).
    const selEsistente = 'scuola_id, stato, alunno_id, descrizione, importo_pagato, sconto'
    const selEsistenteBase = 'scuola_id, stato, alunno_id, descrizione, importo_pagato'
    let esistente: Record<string, unknown> | null = null
    const selE = await supabase.from('pagamenti').select(selEsistente).eq('id', id).maybeSingle()
    if (selE.error && (selE.error as { code?: string }).code === '42703') {
      const retry = await supabase.from('pagamenti').select(selEsistenteBase).eq('id', id).maybeSingle()
      esistente = retry.data as Record<string, unknown> | null
    } else {
      esistente = selE.data as Record<string, unknown> | null
    }
    if (!esistente) return NextResponse.json({ error: 'Pagamento non trovato' }, { status: 404 })
    const sedi = await resolveScuoleAttive(request as NextRequest, supabase, auth.user)
    if (!sedi.includes(String((esistente as { scuola_id: string }).scuola_id))) {
      return NextResponse.json({ error: 'Pagamento non trovato' }, { status: 404 })
    }

    // GUARDIA (finding #3): il nuovo importo, al netto dello sconto, non può
    // scendere sotto quanto GIÀ incassato — prima si stornano gli incassi.
    if (updates.importo !== undefined) {
      const sconto = Number((esistente as { sconto?: number | string | null }).sconto ?? 0)
      const pagato = Number((esistente as { importo_pagato?: number | string | null }).importo_pagato ?? 0)
      if (Number(updates.importo) - sconto < pagato - 0.005) {
        return NextResponse.json({ error: 'Il nuovo importo è inferiore a quanto già incassato. Storna prima gli incassi.' }, { status: 409 })
      }
    }

    const { data, error } = await supabase.from('pagamenti').update(updates).eq('id', id).select(SELECT).single()
    if (error) return NextResponse.json({ error: 'Errore aggiornamento', details: error.message }, { status: 500 })

    // se è cambiato l'importo O la scadenza, ricalcola lo stato dal ledger.
    // Spostare la scadenza al futuro pulisce la morosità (scaduto -> parziale/da_pagare);
    // riportarla al passato la ripristina. Tipo-aware: un 'padre' aggrega dalle rate,
    // gli altri ricalcolano dal proprio ledger incassi (cascata al padre se rata).
    if (updates.importo !== undefined || updates.scadenza !== undefined) {
      const tipo = (data as { tipo?: string } | null)?.tipo
      if (tipo === 'padre') {
        await supabase.rpc('ricalcola_stato_padre', { p_parent: id }).then(() => {}, () => {})
      } else {
        await supabase.rpc('ricalcola_stato_pagamento', { p_id: id }).then(() => {}, () => {})
      }

      // Un importo più basso o una scadenza spostata al futuro può azzerare lo
      // scaduto famiglia → revoca automatica della sospensione (best-effort).
      try {
        const alunnoId = (esistente as { alunno_id?: string | null }).alunno_id
        if (alunnoId) await verificaRevocaSospensioneMorosita(supabase, [alunnoId])
      } catch (e) {
        logEvento('pagamento', 'error', { operazione: 'pagamenti/[id]:PATCH', esito: 'revoca_non_verificata' }, e)
      }
    }

    // Conferma al genitore SOLO sulla transizione manuale stato → 'pagato'
    // (gli incassi hanno già la loro notifica in /api/pagamenti/incassi).
    try {
      const prev = esistente as { stato?: string | null; alunno_id?: string | null; scuola_id?: string | null; descrizione?: string | null }
      if (updates.stato === 'pagato' && prev.stato !== 'pagato' && prev.alunno_id) {
        await notificaEvento(supabase, {
          tipo: 'pagamento_registrato',
          scuolaId: prev.scuola_id ?? null,
          alunnoIds: [prev.alunno_id],
          titolo: 'Pagamento registrato',
          corpo: `${prev.descrizione ?? 'Pagamento'} risulta saldato. La ricevuta è disponibile.`,
          link: '/parent/pagamenti',
          entitaTipo: 'pagamento',
          entitaId: id,
          debounce: true,
        })
      }
    } catch (e) {
      logEvento('notifica', 'error', {
        operazione: 'pagamenti/[id]:PATCH',
        tipo: 'pagamento_registrato',
        esito: 'notifica_non_inviata',
      }, e)
    }

    return NextResponse.json({ success: true, data })
  } catch (err) {
    logErrore({ operazione: 'pagamenti/[id]:PATCH', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})

// DELETE /api/pagamenti/[id]  (staff)
export const DELETE = withRoute('pagamenti/[id]:DELETE', async (request: Request, context: { params: Promise<{ id: string }> }) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const { user } = auth
    const { id: idGrezzo } = await context.params
    const pid = parseData(zUuid, idGrezzo)
    if ('response' in pid) return pid.response
    const id = pid.data

    const supabase = await createAdminClient()
    const { data: old } = await supabase.from('pagamenti').select('*').eq('id', id).maybeSingle()
    if (!old) return NextResponse.json({ error: 'Pagamento non trovato' }, { status: 404 })
    // scoping di sede: non eliminare pagamenti fuori dalle sedi attive
    const sediDel = await resolveScuoleAttive(request as NextRequest, supabase, user)
    if (!sediDel.includes(String((old as { scuola_id: string }).scuola_id))) {
      return NextResponse.json({ error: 'Pagamento non trovato' }, { status: 404 })
    }
    // Conservazione fiscale: un pagamento con FATTURA emessa non è cancellabile
    // (FK RESTRICT + WORM). Le RICEVUTE si annullano prima e restano a registro
    // (numero conservato, pagamento_id azzerato via ON DELETE SET NULL).
    const { data: fatt, error: fattErr } = await supabase.from('fatture_emesse').select('id').eq('pagamento_id', id).limit(1)
    if (!fattErr && fatt && fatt.length > 0) {
      return NextResponse.json({ error: 'Pagamento con fattura emessa: non eliminabile per conservazione fiscale. Annulla/storna prima la fattura.' }, { status: 409 })
    }
    // Voce agganciata a una transazione unica di famiglia: non si cancella qui
    // (annullare la transazione). Retry sulla colonna transazione_id: se il DB non
    // la ha (E2E CI non migrato) il controllo si salta.
    const tx = await supabase.from('incassi').select('id').eq('pagamento_id', id).not('transazione_id', 'is', null).limit(1)
    if (!tx.error && tx.data && tx.data.length > 0) {
      return NextResponse.json({ error: 'Pagamento con incassi di una transazione di famiglia: annulla prima la transazione.' }, { status: 409 })
    }
    await annullaRicevutaAttiva(supabase, id, { da: user.id, motivo: 'cancellazione pagamento' })
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
    logErrore({ operazione: 'pagamenti/[id]:DELETE', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
