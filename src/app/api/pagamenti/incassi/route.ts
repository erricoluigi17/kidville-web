import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { assertPagamentoInScope } from '@/lib/auth/scope'
import { applyOverpaymentSpill } from '@/lib/pagamenti/spill'
import { creditoDisponibile } from '@/lib/pagamenti/credito'
import { resolveParentRegistry } from '@/lib/pagamenti/intestatari'
import { verificaRevocaSospensioneMorosita } from '@/lib/pagamenti/sospensione'
import { eseguiStornoIncasso } from './storno/route'
import { notificaEvento } from '@/lib/notifiche/triggers'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'

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
  // spill: qualunque valore ≠ false attiva lo spill (comportamento storico, solo rate)
  spill: z.unknown().optional(),
  // Eccedenza oltre il residuo (voce non-rata): richiede conferma esplicita
  // «credito famiglia» + il pagante (parents.id o utenti.id → resolveParentRegistry).
  conferma_eccedenza: z.enum(['credito_famiglia']).optional(),
  pagante_parent_id: zUuid.optional(),
  // «Salda con abbuono della differenza»: setta pagamenti.sconto sul non incassato.
  abbuono: z.object({ motivo: z.string().min(3, 'Il motivo dell\'abbuono è obbligatorio (min 3 caratteri)') }).optional(),
})

const deleteQuerySchema = z.object({
  id: zUuid,
  motivo: z.string().optional(),
})

const round2 = (n: number) => Math.round(n * 100) / 100

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
    // Isolamento per sede: si leggeva e si registrava un incasso su una retta di
    // un'altra sede conoscendo l'uuid del pagamento. `pagamenti.scuola_id` e' il
    // dato che conta per la contabilita'.
    const fuoriScopePag = await assertPagamentoInScope(supabase, auth.user, pagamentoId)
    if (fuoriScopePag) return fuoriScopePag
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

// Riga di pagamento letta per le notifiche e lo spill (NON per il residuo:
// quello lo calcola la RPC con la riga bloccata).
interface PagIncassoRow {
  id: string
  parent_payment_id: string | null
  alunno_id: string | null
  scuola_id: string | null
  descrizione: string | null
}

/** Esito di `registra_incasso_voce` (supabase/migrations/…_registra_incasso_voce_bloccata.sql). */
type EsitoRegistraIncasso =
  | { esito: 'non_trovato' }
  | { esito: 'quota_estranea' }
  | { esito: 'eccedenza'; eccedenza: number | string; residuo: number | string }
  | {
      esito: 'ok'
      residuo_prima: number | string
      incasso: ({ id: string } & Record<string, unknown>) | null
      importo_incassato: number | string
      eccedenza: number | string
      credito: { id: string; saldo_dopo: number | string } | null
      sconto_dopo: number | string | null
    }

// POST /api/pagamenti/incassi  (staff) — registra un incasso
// Body: { userId, pagamento_id, importo, ..., conferma_eccedenza?, pagante_parent_id?, abbuono? }
// Tutte le decisioni sul residuo stanno in `registra_incasso_voce`: blocca la riga
// del pagamento (FOR UPDATE), ricalcola il residuo DOPO il blocco e scrive incasso,
// credito famiglia, abbuono e audit in una transazione sola. Prima due operatori
// leggevano lo stesso residuo e incassavano entrambi, oltre il dovuto.
// Voce non-rata sovraincassata → 409 { eccedenza } finché non arriva la conferma
// «credito famiglia» + pagante: in quel caso incassa il residuo e accredita il resto.
// Le rate restano gestite dallo spill (invariato).
export const POST = withRoute('pagamenti/incassi:POST', async (request: Request) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const { user } = auth

    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response
    const body = b.data
    const { pagamento_id } = body

    const supabase = await createAdminClient()
    // Isolamento per sede: si leggeva e si registrava un incasso su una retta di
    // un'altra sede conoscendo l'uuid del pagamento. `pagamenti.scuola_id` e' il
    // dato che conta per la contabilita'.
    const fuoriScopeIns = await assertPagamentoInScope(supabase, auth.user, pagamento_id)
    if (fuoriScopeIns) return fuoriScopeIns

    const sel = await supabase
      .from('pagamenti')
      .select('id, parent_payment_id, alunno_id, scuola_id, descrizione')
      .eq('id', pagamento_id)
      .maybeSingle()
    if (sel.error) {
      logErrore({ operazione: 'pagamenti/incassi:POST', stato: 500, evento: 'db' }, sel.error)
      return NextResponse.json({ error: 'Errore nel recupero del pagamento' }, { status: 500 })
    }
    const pag = sel.data as PagIncassoRow | null
    if (!pag) return NextResponse.json({ error: 'Pagamento non trovato' }, { status: 404 })

    // Pagante dell'eventuale eccedenza: si risolve PRIMA della transazione (può
    // essere parents.id o utenti.id). La RPC lo usa solo se l'importo, ricalcolato
    // con la riga bloccata, supera davvero il residuo.
    let eccedenzaParentId: string | null = null
    if (body.conferma_eccedenza === 'credito_famiglia' && body.pagante_parent_id) {
      const reg = await resolveParentRegistry(supabase, body.pagante_parent_id)
      if (!reg?.id) {
        return NextResponse.json({ error: 'Pagante non risolvibile: nessun profilo anagrafico collegato.' }, { status: 400 })
      }
      // DB non migrato (credito assente) → 503 pulito, nessuna scrittura.
      if (!(await creditoDisponibile(supabase))) {
        return NextResponse.json({ error: 'Credito famiglia non disponibile su questo ambiente' }, { status: 503 })
      }
      eccedenzaParentId = reg.id
    }

    const rpc = await supabase.rpc('registra_incasso_voce', {
      p_pagamento_id: pagamento_id,
      p_importo: round2(Number(body.importo)),
      p_registrato_da: user.id,
      p_data_incasso: body.data_incasso ?? null,
      p_metodo: body.metodo ?? null,
      p_note: body.note ?? null,
      p_quota_id: body.quota_id ?? null,
      p_eccedenza_parent_id: eccedenzaParentId,
      p_abbuono_motivo: body.abbuono?.motivo ?? null,
    })
    if (rpc.error) {
      const code = (rpc.error as { code?: string }).code
      if (code === 'PGRST202') {
        // Funzione assente: database non migrato (DB della CI, o i secondi fra il
        // rilascio e l'integrazione). Nessuna scrittura è avvenuta.
        logErrore({ operazione: 'pagamenti/incassi:POST', stato: 503, evento: 'config' }, rpc.error)
        return NextResponse.json({ error: 'Registrazione incassi non disponibile su questo ambiente', codice: 'INCASSO_NON_DISPONIBILE' }, { status: 503 })
      }
      if (code === '22P02' || code === '22023' || code === '22007' || code === '22008') {
        // Metodo fuori elenco, data illeggibile, importo zero: errore dell'input.
        logEvento('pagamento', 'warn', { operazione: 'pagamenti/incassi:POST', esito: 'input_rifiutato', pagamento_id, codice: code })
        return NextResponse.json({ error: 'Dati dell\'incasso non validi', codice: 'INCASSO_DATI_NON_VALIDI' }, { status: 400 })
      }
      logErrore({ operazione: 'pagamenti/incassi:POST', stato: 500, evento: 'db' }, rpc.error)
      return NextResponse.json({ error: 'Errore nella registrazione', details: rpc.error.message }, { status: 500 })
    }

    const esito = rpc.data as EsitoRegistraIncasso | null
    if (!esito || esito.esito === 'non_trovato') {
      return NextResponse.json({ error: 'Pagamento non trovato' }, { status: 404 })
    }
    if (esito.esito === 'quota_estranea') {
      return NextResponse.json({ error: 'La quota indicata non appartiene a questo pagamento', codice: 'INCASSO_QUOTA_ESTRANEA' }, { status: 400 })
    }
    if (esito.esito === 'eccedenza') {
      // Dato operativo (nessun PII): serve a contare quante volte la cassa ci arriva,
      // anche per concorrenza (due operatori sulla stessa voce).
      logEvento('pagamento', 'info', {
        operazione: 'pagamenti/incassi:POST',
        esito: 'eccedenza_rifiutata',
        pagamento_id,
        eccedenza: round2(Number(esito.eccedenza)),
      })
      return NextResponse.json(
        { error: 'Incasso oltre il residuo: conferma l\'eccedenza come credito famiglia o annulla.', eccedenza: round2(Number(esito.eccedenza)) },
        { status: 409 },
      )
    }

    const incasso = esito.incasso
    const importoIncasso = round2(Number(esito.importo_incassato))
    // Evento critico: logga il SUCCESSO (importi e uuid, MAI PII).
    logEvento('pagamento', 'info', {
      operazione: 'pagamenti/incassi:POST',
      esito: 'incasso_registrato',
      pagamento_id,
      incasso_id: incasso?.id ?? null,
      importo: importoIncasso,
    })

    let credito: { saldoDopo: number; id: string } | null = null
    if (esito.credito) {
      credito = { saldoDopo: round2(Number(esito.credito.saldo_dopo)), id: esito.credito.id }
      logEvento('pagamento', 'info', {
        operazione: 'pagamenti/incassi:POST',
        esito: 'eccedenza_a_credito',
        pagamento_id,
        importo: round2(Number(esito.eccedenza)),
      })
    }
    if (esito.sconto_dopo !== null && esito.sconto_dopo !== undefined) {
      // Evento critico: logga il SUCCESSO (importo dell'abbuono, MAI il motivo).
      logEvento('pagamento', 'info', {
        operazione: 'pagamenti/incassi:POST',
        esito: 'abbuono_applicato',
        pagamento_id,
        sconto: round2(Number(esito.sconto_dopo)),
      })
    }

    // Overpayment spill-over (solo per le rate, opzionale)
    let spills = undefined
    if (incasso && body.spill !== false && pag.parent_payment_id) {
      spills = await applyOverpaymentSpill(supabase, pagamento_id, user.id)
    }

    // stato aggiornato dal trigger
    const { data: aggiornato, error: aggErr } = await supabase
      .from('pagamenti')
      .select('id, importo, importo_pagato, stato, data_incasso')
      .eq('id', pagamento_id)
      .maybeSingle()
    if (aggErr) {
      // L'incasso è già registrato: si risponde 201 senza lo stato aggiornato.
      logEvento('pagamento', 'warn', { operazione: 'pagamenti/incassi:POST', esito: 'stato_non_riletto', pagamento_id }, aggErr)
    }

    // Conferma al genitore: pagamento registrato (best-effort). Il debounce
    // per pagamento collassa gli incassi multipli ravvicinati.
    try {
      if (pag.alunno_id && incasso) {
        const saldato = (aggiornato as { stato?: string } | null)?.stato === 'pagato'
        await notificaEvento(supabase, {
          tipo: 'pagamento_registrato',
          scuolaId: (pag.scuola_id as string | undefined) ?? null,
          alunnoIds: [pag.alunno_id as string],
          titolo: saldato ? 'Pagamento registrato' : 'Acconto registrato',
          corpo: `${pag.descrizione ?? 'Pagamento'}: registrato un incasso di ${importoIncasso} €.`,
          link: '/parent/pagamenti',
          entitaTipo: 'pagamento',
          entitaId: pagamento_id,
          debounce: true,
        })
      }
    } catch (e) {
      // La richiesta risponde 201, ma la conferma al genitore NON è mai stata accodata:
      // è una scrittura persa, e senza riavvii. Perciò `error`, non `warn`.
      logEvento('notifica', 'error', {
        operazione: 'pagamenti/incassi:POST',
        tipo: 'pagamento_registrato',
        esito: 'notifica_non_inviata',
      }, e)
    }

    // Revoca automatica della sospensione se lo scaduto famiglia è azzerato
    // (best-effort: mai bloccante per la risposta, errori loggati dentro l'helper).
    try {
      if (pag.alunno_id) await verificaRevocaSospensioneMorosita(supabase, [pag.alunno_id])
    } catch (e) {
      logEvento('pagamento', 'error', { operazione: 'pagamenti/incassi:POST', esito: 'revoca_non_verificata' }, e)
    }

    return NextResponse.json({ success: true, data: { incasso, pagamento: aggiornato, spills, credito } }, { status: 201 })
  } catch (err) {
    logErrore({ operazione: 'pagamenti/incassi:POST', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})

// DELETE /api/pagamenti/incassi?id=xxx&motivo=yyy  (staff) — storno TRACCIATO
// Non cancella più fisicamente: crea un contro-incasso e marca l'originale.
// Il motivo è obbligatorio (query ?motivo= o body), min 3 caratteri.
export const DELETE = withRoute('pagamenti/incassi:DELETE', async (request: Request) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const { user } = auth

    const q = parseQuery(request, deleteQuerySchema)
    if ('response' in q) return q.response
    const id = q.data.id

    let motivo = q.data.motivo?.trim()
    if (!motivo || motivo.length < 3) {
      try {
        const parsed = await request.json()
        const m = (parsed as { motivo?: string } | null)?.motivo?.trim()
        if (m) motivo = m
      } catch {
        // nessun body JSON: il motivo doveva arrivare in query
      }
    }
    if (!motivo || motivo.length < 3) {
      return NextResponse.json({ error: 'Motivo dello storno obbligatorio (min 3 caratteri)' }, { status: 400 })
    }

    const supabase = await createAdminClient()
    const esito = await eseguiStornoIncasso(supabase, { incassoId: id, motivo, userId: user.id })
    return NextResponse.json(esito.body, { status: esito.status })
  } catch (err) {
    logErrore({ operazione: 'pagamenti/incassi:DELETE', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
