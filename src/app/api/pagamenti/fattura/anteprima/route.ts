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
import { logErrore, logEvento } from '@/lib/logging/logger'
import {
  componiCausalePagamento,
  SELECT_PAGAMENTO_CAUSALE,
  type PagamentoPerCausale,
} from '@/lib/aruba/causale-pagamento'
import { VINCOLO_CAUSALE_FATTURAPA } from '@/lib/pagamenti/causale-fattura'
import {
  componiIntestatarioPagamento,
  INTESTATARIO_ANTEPRIMA_VUOTO,
} from '@/lib/aruba/intestatario-pagamento'

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

    // ── CHI intesta, dallo STESSO pagamento appena letto ──────────────────────
    // Non è una route a parte di proposito: il dialogo «Emetti» deve fare un solo
    // giro, e causale e intestatario devono nascere dalla stessa lettura dello
    // stesso pagamento — due letture separate possono contraddirsi su un
    // documento che si corregge solo con una nota di variazione. Le quote non si
    // ricalcolano qui: `componiIntestatarioPagamento` chiama la stessa
    // `determinaQuoteFatturazione` dell'emissione.
    //
    // ⚠️ FAIL-OPEN, E NON PER SIMMETRIA. Il selettore è un AIUTO: la cosa che
    // questa route deve garantire è che chi sta per emettere veda il testo che
    // partirà. Se il blocco dell'intestatario lanciasse — una lettura inattesa,
    // una forma di dato che non avevamo previsto — un `catch` più in fuori
    // risponderebbe 500 e la causale non uscirebbe affatto: un guasto
    // nell'accessorio spegnerebbe la cosa principale, che è esattamente il
    // difetto che questa route è nata per chiudere.
    //
    // `withRoute` NON vede le eccezioni catturate (AGENTS.md, regola 6): senza la
    // riga di log qui sotto il guasto sarebbe muto, e «nessun candidato» non si
    // distinguerebbe da «nessuno l'ha potuto calcolare». Livello `error`: un
    // lancio inatteso è un difetto NOSTRO, non una degradazione prevista.
    let intestatario = INTESTATARIO_ANTEPRIMA_VUOTO
    try {
      intestatario = await componiIntestatarioPagamento(supabase, {
        id: pagamentoId,
        importo: (pag as { importo?: number | string | null }).importo,
        alunno_id: (pag as { alunno_id?: string | null }).alunno_id,
        // L'alunno annidato è già dentro `pag`: il blocco lo espone da lì, così
        // il nome del bambino nella risposta e quello nella causale vengono
        // dalla stessa riga e non possono contraddirsi.
        alunni: (pag as { alunni?: unknown }).alunni as never,
      })
    } catch (e) {
      logEvento('fattura', 'error', {
        operazione: 'pagamenti/fattura/anteprima:GET',
        esito: 'intestatario-non-composto',
        pagamento_id: pagamentoId,
      }, e)
    }

    return NextResponse.json({
      success: true,
      data: {
        causale: esito.causale,
        origine: esito.origine,
        lunghezza,
        limite: VINCOLO_CAUSALE_FATTURAPA.limiteCaratteri,
        eccede: lunghezza > VINCOLO_CAUSALE_FATTURAPA.limiteCaratteri,
        intestatario,
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
