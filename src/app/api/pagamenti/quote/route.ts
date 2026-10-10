import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { assertPagamentoInScope } from '@/lib/auth/scope'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
const upsertBodySchema = z.object({
  pagamento_id: zUuid,
  quote: z
    .array(
      z.object({
        adult_id: zUuid,
        // numero o stringa numerica (Postgres casta la stringa); la coerenza
        // con l'importo del pagamento resta il check sotto
        importo: z.union([z.number(), z.string()], { error: 'Ogni quota richiede adult_id e importo' }),
        etichetta: z.string().nullish(),
      }),
      { error: 'pagamento_id e almeno 2 quote sono obbligatori' }
    )
    .min(2, 'pagamento_id e almeno 2 quote sono obbligatori'),
})

const getQuerySchema = z.object({
  pagamento_id: zUuid,
})

/** Esito di `aggiorna_quote_pagamento` (supabase/migrations/…_aggiorna_quote_senza_reinserire.sql). */
type EsitoQuote =
  | { esito: 'non_trovato' }
  | { esito: 'adulto_ripetuto'; adult_id: string }
  | { esito: 'somma_diversa'; somma: number | string; importo: number | string }
  | { esito: 'quota_con_incassi'; quote: string[] }
  | { esito: 'ok'; quote: unknown[]; tolte: number }

// POST/PATCH /api/pagamenti/quote  (staff) — crea/aggiorna le quote split
// Body: { userId, pagamento_id, quote: [{adult_id, importo, etichetta?}] }
// Tutto in `aggiorna_quote_pagamento`, con la riga del pagamento bloccata: la quota
// di chi resta si AGGIORNA (stesso id, gli incassi restano collegati), i nuovi si
// inseriscono, gli assenti si tolgono solo se non hanno incassi. Prima si
// cancellava tutto e si reinseriva, e `incassi.quota_id` finiva a NULL.
// La somma delle quote deve coincidere con l'importo. Imposta tipo='split'.
async function upsertQuote(request: Request, operazione: string) {
  const auth = await requireStaff(request)
  if (auth.response) return auth.response

  const b = await parseBody(request, upsertBodySchema)
  if ('response' in b) return b.response
  const { pagamento_id, quote } = b.data

  const supabase = await createAdminClient()

  // Isolamento per sede: il gate di ruolo non bastava — si operava sulle rette
  // di un'altra sede conoscendo l'uuid del pagamento. `pagamenti` ha gia'
  // `scuola_id`, che per la contabilita' e' il dato che conta.
  const fuoriScopePag = await assertPagamentoInScope(supabase, auth.user, pagamento_id)
  if (fuoriScopePag) return fuoriScopePag

  const rpc = await supabase.rpc('aggiorna_quote_pagamento', {
    p_pagamento_id: pagamento_id,
    p_quote: quote.map((q) => ({ adult_id: q.adult_id, importo: q.importo, etichetta: q.etichetta ?? null })),
    p_utente_id: auth.user.id,
  })
  if (rpc.error) {
    const code = (rpc.error as { code?: string }).code
    if (code === 'PGRST202') {
      // Funzione assente: database non migrato. Nessuna scrittura è avvenuta.
      logErrore({ operazione, stato: 503, evento: 'config' }, rpc.error)
      return NextResponse.json({ error: 'Modifica delle quote non disponibile su questo ambiente', codice: 'QUOTE_NON_DISPONIBILI' }, { status: 503 })
    }
    if (code === '22P02' || code === '22023' || code === '23503') {
      // Importo illeggibile, quota senza adulto, adulto inesistente: errore dell'input.
      logEvento('pagamento', 'warn', { operazione, esito: 'quote_rifiutate', pagamento_id, codice: code })
      return NextResponse.json({ error: 'Quote non valide', codice: 'QUOTE_DATI_NON_VALIDI' }, { status: 400 })
    }
    logErrore({ operazione, stato: 500, evento: 'db' }, rpc.error)
    return NextResponse.json({ error: 'Errore nel salvataggio delle quote' }, { status: 500 })
  }

  const esito = rpc.data as EsitoQuote | null
  if (!esito || esito.esito === 'non_trovato') {
    return NextResponse.json({ error: 'Pagamento non trovato' }, { status: 404 })
  }
  if (esito.esito === 'somma_diversa') {
    return NextResponse.json(
      { error: `La somma delle quote (${Number(esito.somma)}) deve coincidere con l'importo (${Number(esito.importo)})` },
      { status: 400 }
    )
  }
  if (esito.esito === 'adulto_ripetuto') {
    return NextResponse.json({ error: 'Lo stesso adulto compare in due quote', codice: 'QUOTE_ADULTO_RIPETUTO' }, { status: 400 })
  }
  if (esito.esito === 'quota_con_incassi') {
    logEvento('pagamento', 'info', { operazione, esito: 'quota_con_incassi_non_tolta', pagamento_id, n_quote: esito.quote.length })
    return NextResponse.json(
      { error: 'Una quota da togliere ha già degli incassi: stornali prima di cambiare chi paga.', codice: 'QUOTE_CON_INCASSI', quote: esito.quote },
      { status: 409 }
    )
  }

  // Evento critico (soldi): logga il SUCCESSO, solo conteggi e uuid.
  logEvento('pagamento', 'info', {
    operazione,
    esito: 'quote_aggiornate',
    pagamento_id,
    n_quote: esito.quote.length,
    n_tolte: esito.tolte,
  })
  return NextResponse.json({ success: true, data: esito.quote }, { status: 200 })
}

export const POST = withRoute('pagamenti/quote:POST', async (request: Request) => {
  try { return await upsertQuote(request, 'pagamenti/quote:POST') } catch (err) {
    logErrore({ operazione: 'pagamenti/quote:POST', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
export const PATCH = withRoute('pagamenti/quote:PATCH', async (request: Request) => {
  try { return await upsertQuote(request, 'pagamenti/quote:PATCH') } catch (err) {
    logErrore({ operazione: 'pagamenti/quote:PATCH', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})

// GET /api/pagamenti/quote?pagamento_id=&userId=  (staff) — quote di un pagamento
export const GET = withRoute('pagamenti/quote:GET', async (request: Request) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const pagamentoId = q.data.pagamento_id

    const supabase = await createAdminClient()

    // Isolamento per sede: il gate di ruolo non bastava — si operava sulle rette
    // di un'altra sede conoscendo l'uuid del pagamento. `pagamenti` ha gia'
    // `scuola_id`, che per la contabilita' e' il dato che conta.
    const fuoriScopePag = await assertPagamentoInScope(supabase, auth.user, pagamentoId)
    if (fuoriScopePag) return fuoriScopePag
    const { data, error } = await supabase
      .from('pagamenti_quote')
      .select('id, pagamento_id, adult_id, importo, etichetta, utenti:adult_id ( id, nome, cognome )')
      .eq('pagamento_id', pagamentoId)
    if (error) {
      // Il messaggio di PostgREST resta nel log, non va a schermo.
      logErrore({ operazione: 'pagamenti/quote:GET', stato: 500, evento: 'db' }, error)
      return NextResponse.json({ error: 'Errore nella lettura delle quote' }, { status: 500 })
    }
    return NextResponse.json({ success: true, data })
  } catch (err) {
    logErrore({ operazione: 'pagamenti/quote:GET', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
