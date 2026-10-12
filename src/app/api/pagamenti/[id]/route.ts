import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff, requireUser } from '@/lib/auth/require-staff'
import { genitoreHasFiglio } from '@/lib/anagrafiche/legami'
import { parseBody, parseData } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { resolveScuoleAttive } from '@/lib/auth/scope'
import { verificaRevocaSospensioneMorosita } from '@/lib/pagamenti/sospensione'
import { notificaEvento } from '@/lib/notifiche/triggers'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { rispostaGuastoDb } from '@/lib/pagamenti/guasto-db'
import { normalizzaMetodiAmmessi, CODICI_COLONNA_ASSENTE } from '@/lib/pagamenti/metodi-ammessi'
import { zMetodiAmmessi } from '@/lib/pagamenti/metodi-ammessi-zod'
import { figlieTrattengono } from '@/lib/db/figlie-trattengono'
import { controllaVoceEliminabile, TABELLA_ASSENTE } from '@/lib/pagamenti/voce-eliminabile'

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
  // Metodi ammessi (2026-10-05). Qui si scrive SEMPRE l'array normalizzato,
  // anche «tutti e due»: è così che una voce «solo contanti» torna libera.
  metodi_ammessi: zMetodiAmmessi.optional(),
})

const CAMPI_EDITABILI = [
  'descrizione', 'importo', 'scadenza', 'categoria_id', 'obbligatorio',
  'periodo_competenza', 'gruppo', 'tipo', 'visibile_dal', 'metodi_ammessi',
] as const

/**
 * RPC assenti sul DB non migrato: quelle di ricalcolo (`ricalcola_stato_padre`/`_pagamento`) e,
 * dal 2026-10-12, `elimina_voce_ricarica_ticket`.
 */
const RPC_ASSENTE = new Set(['PGRST202', '42883'])

type ErroreDb = { code?: string; message?: string }

/**
 * Attende una scrittura SECONDARIA — il ricalcolo dopo la PATCH, l'audit dopo la
 * DELETE — e ne restituisce l'errore, mai un'eccezione. `null` = riuscita.
 *
 * Erano `.then(() => {}, () => {})`: scartavano il `{ error }` di PostgREST (che NON
 * lancia) insieme al rigetto, e uno stato mai ricalcolato o un audit mai scritto non
 * lasciavano traccia. Il rigetto (rete, client) resta catturato qui: un'operazione
 * principale GIÀ riuscita non deve diventare un 500. Stesso approccio di
 * `pagamenti/incassi/storno` (Task 7).
 */
async function erroreScrittura(
  scrittura: PromiseLike<{ error: ErroreDb | null } | null | undefined>,
): Promise<{ errore: unknown; codice: string } | null> {
  try {
    const esito = await scrittura
    if (!esito?.error) return null
    return { errore: esito.error, codice: esito.error.code ?? '' }
  } catch (err) {
    return { errore: err, codice: '' }
  }
}

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
    // Ogni lettura di questo dettaglio controlla `error` (fase 5 robustezza, sesto pezzo): un
    // guasto non è «non trovato», «accesso negato» né un elenco vuoto di incassi, quote o rate
    // — schermate che sembravano vere e non lo erano.
    const { data, error } = await supabase.from('pagamenti').select(SELECT).eq('id', id).maybeSingle()
    if (error) return rispostaGuastoDb('pagamenti/[id]:GET', 'db:pagamenti', error)
    if (!data) return NextResponse.json({ error: 'Pagamento non trovato' }, { status: 404 })
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
      // Unione runtime + anagrafica (la lista `/api/pagamenti` la usa già): senza,
      // il genitore vedeva la retta in elenco e poi 403 aprendone il dettaglio.
      const ok = await genitoreHasFiglio(supabase, user.id, pag.alunno_id)
      if (!ok) return NextResponse.json({ error: 'Accesso negato' }, { status: 403 })

      // visibilità ritardata: il genitore non può aprire un pagamento non ancora pubblicato
      const oggi = new Date().toISOString().slice(0, 10)
      if (pag.visibile_dal && String(pag.visibile_dal) > oggi) {
        return NextResponse.json({ error: 'Pagamento non ancora disponibile' }, { status: 403 })
      }

      if (pag.tipo === 'split') {
        const { data: q, error: errQ } = await supabase
          .from('pagamenti_quote')
          .select('id, importo')
          .eq('pagamento_id', id)
          .eq('adult_id', user.id)
          .maybeSingle()
        if (errQ) return rispostaGuastoDb('pagamenti/[id]:GET', 'db:pagamenti_quote:propria', errQ)
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
    const { data: incassi, error: errIncassi } = await incassiQuery
    if (errIncassi) return rispostaGuastoDb('pagamenti/[id]:GET', 'db:incassi', errIncassi)

    // quote (staff vede tutte; genitore solo la propria)
    let quoteQuery = supabase
      .from('pagamenti_quote')
      .select('id, pagamento_id, adult_id, importo, etichetta, utenti:adult_id ( id, nome, cognome )')
      .eq('pagamento_id', id)
    if (!isStaff) quoteQuery = quoteQuery.eq('adult_id', user.id)
    const { data: quote, error: errQuote } = pag.tipo === 'split' ? await quoteQuery : { data: [], error: null }
    if (errQuote) return rispostaGuastoDb('pagamenti/[id]:GET', 'db:pagamenti_quote', errQuote)

    // rate (se è un padre rateizzato)
    let rate: unknown[] = []
    if (pag.tipo === 'padre') {
      const { data: r, error: errRate } = await supabase
        .from('pagamenti')
        .select('id, descrizione, importo, importo_pagato, scadenza, stato')
        .eq('parent_payment_id', id)
        .order('scadenza', { ascending: true })
      if (errRate) return rispostaGuastoDb('pagamenti/[id]:GET', 'db:pagamenti:rate', errRate)
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
    if (updates.metodi_ammessi !== undefined) updates.metodi_ammessi = normalizzaMetodiAmmessi(updates.metodi_ammessi)
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
      if (retry.error) return rispostaGuastoDb('pagamenti/[id]:PATCH', 'db:pagamenti', retry.error)
      esistente = retry.data as Record<string, unknown> | null
    } else if (selE.error) {
      // Ogni altro errore era un 404 «non trovato» (fase 5 robustezza, sesto pezzo).
      return rispostaGuastoDb('pagamenti/[id]:PATCH', 'db:pagamenti', selE.error)
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

    let upd = await supabase.from('pagamenti').update(updates).eq('id', id).select(SELECT).single()
    let metodiNonSalvati = false
    if (
      upd.error &&
      updates.metodi_ammessi !== undefined &&
      CODICI_COLONNA_ASSENTE.includes((upd.error as { code?: string }).code ?? '')
    ) {
      // DB E2E della CI (colonna assente): si salva il resto e si DICE che i
      // metodi non sono stati salvati, invece di fingere.
      metodiNonSalvati = true
      logEvento('pagamento', 'warn', {
        operazione: 'pagamenti/[id]:PATCH',
        esito: 'metodi-ammessi-colonna-assente',
        pagamento_id: id,
      }, upd.error)
      const { metodi_ammessi: _m, ...resto } = updates
      void _m
      // Se restava solo `aggiornato_il`, un update non cambierebbe niente di
      // ciò che è stato chiesto: si rilegge la riga e basta.
      upd = Object.keys(resto).some((k) => k !== 'aggiornato_il')
        ? await supabase.from('pagamenti').update(resto).eq('id', id).select(SELECT).single()
        : await supabase.from('pagamenti').select(SELECT).eq('id', id).single()
    }
    const { data, error } = upd
    if (error) {
      logErrore({ operazione: 'pagamenti/[id]:PATCH', stato: 500, evento: 'db' }, error)
      return NextResponse.json({ error: 'Errore aggiornamento', details: error.message }, { status: 500 })
    }
    if (updates.metodi_ammessi !== undefined && !metodiNonSalvati) {
      const m = updates.metodi_ammessi as string[]
      logEvento('pagamento', 'info', {
        operazione: 'pagamenti/[id]:PATCH',
        esito: 'metodi-ammessi-modificati',
        pagamento_id: id,
        solo_contanti: m.length === 1 && m[0] === 'contanti',
        solo_bonifico: m.length === 1 && m[0] === 'bonifico',
      })
    }

    // se è cambiato l'importo O la scadenza, ricalcola lo stato dal ledger.
    // Spostare la scadenza al futuro pulisce la morosità (scaduto -> parziale/da_pagare);
    // riportarla al passato la ripristina. Tipo-aware: un 'padre' aggrega dalle rate,
    // gli altri ricalcolano dal proprio ledger incassi (cascata al padre se rata).
    if (updates.importo !== undefined || updates.scadenza !== undefined) {
      const tipo = (data as { tipo?: string } | null)?.tipo
      const ric = await erroreScrittura(
        tipo === 'padre'
          ? supabase.rpc('ricalcola_stato_padre', { p_parent: id })
          : supabase.rpc('ricalcola_stato_pagamento', { p_id: id }),
      )
      if (ric) {
        // La modifica è salvata: la risposta resta 200. Ma uno stato non ricalcolato
        // lascia la voce «scaduta» (o «pagata») sbagliata, e va detto. `info` se la RPC
        // non esiste (DB non migrato), `error` se è un guasto vero.
        const assente = RPC_ASSENTE.has(ric.codice)
        logEvento('pagamento', assente ? 'info' : 'error', {
          operazione: 'pagamenti/[id]:PATCH',
          esito: assente ? 'ricalcolo-rpc-assente' : 'ricalcolo-non-riuscito',
          pagamento_id: id,
          tipo: tipo ?? null,
        }, ric.errore)
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
          corpo: `${prev.descrizione ?? 'Pagamento'} risulta saldato.`,
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

    return NextResponse.json({ success: true, data, ...(metodiNonSalvati ? { avviso: 'metodi-non-salvabili' } : {}) })
  } catch (err) {
    logErrore({ operazione: 'pagamenti/[id]:PATCH', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})

// DELETE /api/pagamenti/[id]  (admin e segreteria, dal 2026-10-12)
// Le guardie stanno in `controllaVoceEliminabile` (fattura, incassi anche stornati, transazione
// di famiglia, coda fatture, rata, ordine divise attivo, ticket già usati). Una voce di ricarica
// ticket si elimina con la RPC che storna i suoi ticket nella stessa transazione: cancellata da
// sola lascerebbe i ticket accreditati (la FK del ledger è SET NULL).
export const DELETE = withRoute('pagamenti/[id]:DELETE', async (request: Request, context: { params: Promise<{ id: string }> }) => {
  try {
    const auth = await requireStaff(request, ['admin', 'segreteria'])
    if (auth.response) return auth.response
    const { user } = auth
    const { id: idGrezzo } = await context.params
    const pid = parseData(zUuid, idGrezzo)
    if ('response' in pid) return pid.response
    const id = pid.data

    const supabase = await createAdminClient()
    const sedi = await resolveScuoleAttive(request as NextRequest, supabase, user)
    const c = await controllaVoceEliminabile(supabase, id, { sedi, perSostituzione: false, operazione: 'pagamenti/[id]:DELETE' })
    if (!c.ok) {
      if ('guasto' in c) return c.guasto
      return NextResponse.json({ error: c.error, ...(c.codice ? { codice: c.codice } : {}) }, { status: c.stato })
    }

    // Un incasso o una fattura arrivati fra le guardie e la DELETE: il freno RESTRICT del
    // database rifiuta, e non è un guasto.
    const frenoRisposta = (error: unknown) => {
      logEvento('pagamento', 'warn', {
        operazione: 'pagamenti/[id]:DELETE', esito: 'eliminazione-rifiutata-dal-freno', pagamento_id: id,
      }, error)
      return NextResponse.json(
        {
          error: 'La voce è stata incassata o fatturata nel frattempo: non si può più eliminare. Ricarica la pagina.',
          codice: 'VOCE_CON_CONTABILITA',
        },
        { status: 409 },
      )
    }

    let ticketTolti = 0
    if (c.ticket > 0) {
      const rpc = await supabase.rpc('elimina_voce_ricarica_ticket', { p_pagamento_id: id, p_operatore: user.id })
      if (rpc.error) {
        if (RPC_ASSENTE.has(rpc.error.code ?? '')) {
          // Mai la DELETE diretta al posto della RPC: i ticket resterebbero accreditati.
          logEvento('pagamento', 'error', {
            operazione: 'pagamenti/[id]:DELETE', esito: 'rpc-eliminazione-ricarica-assente', pagamento_id: id,
          }, rpc.error)
          return NextResponse.json(
            { error: 'Eliminazione di una ricarica non disponibile su questo ambiente', codice: 'ELIMINAZIONE_RICARICA_NON_DISPONIBILE' },
            { status: 503 },
          )
        }
        if (figlieTrattengono(rpc.error)) return frenoRisposta(rpc.error)
        logErrore({ operazione: 'pagamenti/[id]:DELETE', stato: 500, evento: 'rpc:elimina_voce_ricarica_ticket' }, rpc.error)
        return NextResponse.json({ error: 'Errore eliminazione', details: rpc.error.message }, { status: 500 })
      }
      const esito = (rpc.data ?? {}) as { esito?: string; ticket_tolti?: number }
      if (esito.esito === 'ticket_gia_usati') {
        return NextResponse.json(
          { error: 'I ticket di questa ricarica sono già stati usati: la voce non si può eliminare.', codice: 'TICKET_GIA_USATI' },
          { status: 409 },
        )
      }
      if (esito.esito === 'non_trovata') return NextResponse.json({ error: 'Pagamento non trovato' }, { status: 404 })
      if (esito.esito !== 'eliminata') {
        // «senza_ricarica» o un esito ignoto: la voce è cambiata fra la guardia e la RPC.
        logEvento('pagamento', 'error', {
          operazione: 'pagamenti/[id]:DELETE', esito: 'rpc-esito-inatteso', pagamento_id: id, rpc_esito: esito.esito ?? null,
        })
        return NextResponse.json(
          { error: 'La voce è cambiata nel frattempo. Ricarica la pagina.', codice: 'VOCE_CON_CONTABILITA' },
          { status: 409 },
        )
      }
      ticketTolti = Number(esito.ticket_tolti ?? c.ticket)
    } else {
      const { error } = await supabase.from('pagamenti').delete().eq('id', id)
      if (error) {
        if (figlieTrattengono(error)) return frenoRisposta(error)
        logErrore({ operazione: 'pagamenti/[id]:DELETE', stato: 500, evento: 'db' }, error)
        return NextResponse.json({ error: 'Errore eliminazione', details: error.message }, { status: 500 })
      }
    }

    // La voce è GIÀ cancellata: da qui niente cambia la risposta, ma ogni fallimento si dice.
    // Una voce scaduta tolta può azzerare lo scaduto della famiglia → revoca della sospensione
    // per morosità, come fa la PATCH quando cambiano importo o scadenza.
    try {
      if (c.voce.alunno_id) await verificaRevocaSospensioneMorosita(supabase, [String(c.voce.alunno_id)])
    } catch (e) {
      logEvento('pagamento', 'error', { operazione: 'pagamenti/[id]:DELETE', esito: 'revoca_non_verificata', pagamento_id: id }, e)
    }

    // Un audit perso è una cancellazione senza traccia di chi l'ha fatta, e si dice. Il
    // `vecchio_valore` (descrizione, alunno…) vive nell'audit, MAI nei log: lì solo uuid e numeri.
    const audit = await erroreScrittura(
      supabase.from('registro_modifiche').insert({
        azione: 'elimina_pagamento',
        tabella_interessata: 'pagamenti',
        record_id: id,
        vecchio_valore: c.voce,
        ...(ticketTolti > 0 ? { nuovo_valore: { ticket_tolti: ticketTolti } } : {}),
        utente_id: user.id,
      }),
    )
    if (audit) {
      const assente = TABELLA_ASSENTE.has(audit.codice)
      logEvento('pagamento', assente ? 'info' : 'error', {
        operazione: 'pagamenti/[id]:DELETE',
        esito: assente ? 'audit-tabella-assente' : 'audit-eliminazione-non-scritto',
        pagamento_id: id,
      }, audit.errore)
    }

    // Evento critico: si logga anche il SUCCESSO, o «nessun log» non distingue «eliminata» da
    // «mai partita».
    logEvento('pagamento', 'info', {
      operazione: 'pagamenti/[id]:DELETE',
      esito: 'voce-eliminata',
      pagamento_id: id,
      tipo: c.voce.tipo,
      rate: c.rate,
      ticket_tolti: ticketTolti,
    })
    return NextResponse.json({ success: true, ticket_tolti: ticketTolti })
  } catch (err) {
    logErrore({ operazione: 'pagamenti/[id]:DELETE', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
