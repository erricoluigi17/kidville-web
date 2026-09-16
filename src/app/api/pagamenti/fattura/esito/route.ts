import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireUser } from '@/lib/auth/require-staff'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { withRoute } from '@/lib/logging/with-route'
import { assertFatturaInScope } from '@/lib/pagamenti/scope-fattura'
import { caricaVisibilitaFatture, type RigaVisibilitaFattura } from '@/lib/pagamenti/visibilita-fatture'
import { rateLimit } from '@/lib/security/rate-limit'
import { createAdminClient } from '@/lib/supabase/server-client'
import { zUuid } from '@/lib/validation/common'
import { parseBody } from '@/lib/validation/http'

const bodySchema = z.object({
  pagamento_id: zUuid,
  fattura_id: zUuid,
  esito: z.enum(['visualizzata', 'annullata', 'browser_avviato', 'salvataggio_avviato']),
}).strict()

const TETTO = { limit: 120, windowMs: 10 * 60 * 1000 }

interface Pagamento {
  id: string
  scuola_id: string
  alunno_id: string | null
}

interface Fattura extends RigaVisibilitaFattura {
  pagamento_id: string
  scuola_id: string
}

function noStore<T extends Response>(response: T): T {
  response.headers.set('Cache-Control', 'no-store')
  return response
}

export const POST = withRoute('pagamenti/fattura/esito:POST', async (request: Request) => {
  try {
    const auth = await requireUser(request)
    if (auth.response) return noStore(auth.response)

    const limite = await rateLimit(`fattura-esito:${auth.user.id}`, TETTO)
    if (!limite.ok) {
      return noStore(NextResponse.json(
        { error: 'Troppe richieste. Riprova tra qualche minuto.', codice: 'TROPPE_RICHIESTE' },
        {
          status: 429,
          headers: { 'Retry-After': String(Math.ceil(limite.retryAfterMs / 1000)) },
        },
      ))
    }

    const body = await parseBody(request, bodySchema)
    if ('response' in body) return noStore(body.response)
    const { pagamento_id: pagamentoId, fattura_id: fatturaId, esito } = body.data

    const supabase = await createAdminClient()
    const { data: pagamento, error: errorePagamento } = await supabase
      .from('pagamenti')
      .select('id, scuola_id, alunno_id')
      .eq('id', pagamentoId)
      .maybeSingle()

    if (errorePagamento) {
      logErrore(
        { operazione: 'pagamenti/fattura/esito:pagamento', stato: 500, evento: 'db' },
        errorePagamento,
      )
      return noStore(NextResponse.json(
        { error: 'Lettura del pagamento non riuscita', codice: 'LETTURA_FALLITA' },
        { status: 500 },
      ))
    }
    if (!pagamento) {
      return noStore(NextResponse.json(
        { error: 'Pagamento non trovato', codice: 'PAGAMENTO_NON_TROVATO' },
        { status: 404 },
      ))
    }
    const rigaPagamento = pagamento as Pagamento

    const fuoriScope = await assertFatturaInScope(
      supabase,
      auth.user,
      pagamentoId,
      rigaPagamento.alunno_id,
    )
    if (fuoriScope) return noStore(fuoriScope)

    const visibilita = await caricaVisibilitaFatture(
      supabase,
      auth.user,
      rigaPagamento.scuola_id,
    )
    if (visibilita.esito === 'errore') return noStore(visibilita.response)

    const { data: fattura, error: erroreFattura } = await supabase
      .from('fatture_emesse')
      .select('id, pagamento_id, scuola_id, modalita_emissione, parent_registry_id')
      .eq('id', fatturaId)
      .eq('pagamento_id', pagamentoId)
      .eq('scuola_id', rigaPagamento.scuola_id)
      .maybeSingle()

    if (erroreFattura) {
      logErrore(
        { operazione: 'pagamenti/fattura/esito:fattura', stato: 500, evento: 'db' },
        erroreFattura,
      )
      return noStore(NextResponse.json(
        { error: 'Lettura della fattura non riuscita', codice: 'LETTURA_FALLITA' },
        { status: 500 },
      ))
    }
    const rigaFattura = fattura as Fattura | null
    if (!rigaFattura || !visibilita.puoVedere(rigaFattura)) {
      return noStore(NextResponse.json(
        { error: 'Fattura non trovata', codice: 'FATTURA_NON_TROVATA' },
        { status: 404 },
      ))
    }

    logEvento('fattura', 'info', {
      operazione: 'pagamenti/fattura/esito',
      esito,
      pagamento_id: pagamentoId,
      fattura_id: fatturaId,
      utente: auth.user.id,
    })

    return new NextResponse(null, {
      status: 204,
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (errore) {
    logErrore({ operazione: 'pagamenti/fattura/esito:POST', stato: 500 }, errore)
    return noStore(NextResponse.json(
      { error: 'Errore interno durante la registrazione', codice: 'LETTURA_FALLITA' },
      { status: 500 },
    ))
  }
})
