/**
 * GET /api/pagamenti/fattura/anteprima?pagamento_id=…  (staff)
 *
 * Il testo che finirà nella riga della fattura elettronica, PRIMA di emetterla.
 *
 * ─── PERCHÉ ESISTE ───────────────────────────────────────────────────────────
 * Il 2026-09-03 la FPR 1948/26 è partita verso lo SDI con «Retta 09/2026» mentre la
 * sede aveva configurato un modello coi segnaposti: il modale «Emetti» precompilava
 * la casella con `pagamenti.descrizione` e la spediva come correzione manuale, che
 * per progetto batte qualunque modello. L'operatore annullava la configurazione
 * premendo un pulsante, e non aveva modo di accorgersene.
 *
 * La composizione NON è rifatta qui: la fa `componiCausalePagamento`, lo stesso
 * codice chiamato da `emettiFatturaPagamento`. Un'anteprima calcolata a parte
 * mostrerebbe un testo e ne spedirebbe un altro — su un documento che si corregge
 * solo con una nota di variazione.
 *
 * ⚠️ Nella risposta viaggia il codice fiscale del minore (è dentro la causale). Nei
 * log finiscono `origine` e `lunghezza`, mai la causale (AGENTS.md, regola 8).
 */
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { assertPagamentoInScope } from '@/lib/auth/scope'
import { parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore } from '@/lib/logging/logger'
import {
  componiCausalePagamento,
  SELECT_PAGAMENTO_CAUSALE,
  type PagamentoPerCausale,
} from '@/lib/aruba/causale-pagamento'
import { VINCOLO_CAUSALE_FATTURAPA } from '@/lib/pagamenti/causale-fattura'

const getQuerySchema = z.object({ pagamento_id: zUuid })

export const GET = withRoute('pagamenti/fattura/anteprima:GET', async (request: Request) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const { pagamento_id: pagamentoId } = q.data

    const supabase = await createAdminClient()

    // Stesso scope di sede della POST che emette: il gate di ruolo dice CHE COSA sei,
    // non SU QUALE SEDE, e questa route mostra il nome e il codice fiscale di un minore.
    const fuoriScope = await assertPagamentoInScope(supabase, auth.user, pagamentoId)
    if (fuoriScope) return fuoriScope

    const { data: pag, error } = await supabase
      .from('pagamenti')
      .select(SELECT_PAGAMENTO_CAUSALE)
      .eq('id', pagamentoId)
      .single()

    // PostgREST NON LANCIA (AGENTS.md, regola 7). `PGRST116` è l'unico caso in cui
    // «non trovato» è la verità: tutto il resto è un guasto e si dice guasto, perché
    // un 404 che mente manda a cercare un pagamento che invece esiste.
    if (error && (error as { code?: string }).code !== 'PGRST116') {
      return NextResponse.json(
        {
          error: 'Impossibile leggere il pagamento: non è un pagamento inesistente, è una lettura fallita.',
          codice: 'LETTURA_FALLITA',
        },
        { status: 503 }
      )
    }
    if (!pag) {
      return NextResponse.json(
        { error: 'Il pagamento non esiste più: la fattura non si può emettere', codice: 'PAGAMENTO_INESISTENTE' },
        { status: 404 },
      )
    }

    const esito = await componiCausalePagamento(supabase, pag as unknown as PagamentoPerCausale)
    if (!esito.ok) {
      return NextResponse.json(
        { error: esito.messaggio, codice: 'CAUSALE_CONFIG_NON_LETTA' },
        { status: esito.httpStatus },
      )
    }

    // La lunghezza si misura sulla stringa NORMALIZZATA, mai su `.length`: `testoLatin`
    // translittera prima di troncare e la translitterazione allunga (`€`→`EUR`). Limite
    // e misura arrivano insieme da `VINCOLO_CAUSALE_FATTURAPA`, che li tiene in una
    // costante sola proprio perché il difetto del 2026-08-10 nacque prendendo solo il
    // numero e contando ciò che si aveva sottomano.
    const lunghezza = VINCOLO_CAUSALE_FATTURAPA.perTracciato(esito.causale).length
    return NextResponse.json({
      success: true,
      data: {
        causale: esito.causale,
        origine: esito.origine,
        lunghezza,
        limite: VINCOLO_CAUSALE_FATTURAPA.limiteCaratteri,
        eccede: lunghezza > VINCOLO_CAUSALE_FATTURAPA.limiteCaratteri,
      },
    })
  } catch (err) {
    logErrore({ operazione: 'pagamenti/fattura/anteprima:GET', stato: 500 }, err)
    // Anche il catch-all porta il suo codice: «Internal Server Error» nudo è una
    // frase che l'utente inglese leggerebbe in italiano su ogni altra risposta, e
    // qui a valle c'è un pulsante che decide se emettere o no un documento fiscale.
    return NextResponse.json(
      {
        error: 'Non è stato possibile calcolare la causale: la fattura non è stata emessa. Riprova fra poco.',
        codice: 'LETTURA_FALLITA',
      },
      { status: 500 },
    )
  }
})
