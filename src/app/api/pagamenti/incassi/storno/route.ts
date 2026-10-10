import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { assertPagamentoInScope } from '@/lib/auth/scope'
import { parseBody } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { verificaRevocaSospensioneMorosita } from '@/lib/pagamenti/sospensione'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { rispostaGuastoDb } from '@/lib/pagamenti/guasto-db'

const postBodySchema = z.object({
  incasso_id: zUuid,
  motivo: z.string().min(3, 'Il motivo dello storno è obbligatorio (min 3 caratteri)'),
})

/**
 * Colonne S3 assenti sul DB E2E CI non migrato → 42703 su SELECT, PGRST204 su
 * UPDATE (la marcatura `stornato_il`/`storno_motivo`).
 */
const COLONNA_ASSENTE = new Set(['42703', 'PGRST204'])

/** RPC `ricalcola_stato_pagamento` assente sul DB non migrato. */
const RPC_ASSENTE = new Set(['PGRST202', '42883'])

type ErroreDb = { code?: string; message?: string }

/**
 * Attende una scrittura SECONDARIA dello storno e ne restituisce l'errore, mai
 * un'eccezione. PostgREST di norma ritorna `{ error }`; un rigetto (rete, client)
 * è raro, ma il vecchio `.then(() => {}, () => {})` ingoiava anche quello, e uno
 * storno già avvenuto non deve diventare un 500. `null` = scritta.
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

export interface StornoEsito {
  status: number
  body: Record<string, unknown>
}

/**
 * Logica condivisa dello storno di un incasso (usata anche dai due DELETE, che
 * ora sono wrapper di questa funzione: niente più cancellazione fisica).
 *
 * Crea un contro-incasso NEGATIVO collegato (`metodo='storno'`, `storno_di` =
 * incasso originale), marca l'originale (`stornato_il`/`storno_motivo`,
 * best-effort su DB non migrato), ricalcola lo stato del pagamento. Il MOTIVO
 * va in colonna/registro_modifiche, MAI nei log.
 *
 * Marcatura, ricalcolo e audit vengono DOPO il contro-incasso: un loro errore
 * non cambia la risposta (200), ma si logga (`info` se è uno schema non
 * migrato, `error` se è un guasto vero).
 *
 * 409 se l'incasso è già stornato o se è esso stesso uno storno.
 */
export async function eseguiStornoIncasso(
  supabase: SupabaseClient,
  args: { incassoId: string; motivo: string; userId: string },
): Promise<StornoEsito> {
  const { incassoId, motivo, userId } = args

  // Leggi l'originale con le colonne S3 (retry senza, se il DB non le ha).
  let orig: Record<string, unknown> | null = null
  const sel = await supabase
    .from('incassi')
    .select('id, pagamento_id, importo, metodo, storno_di, stornato_il')
    .eq('id', incassoId)
    .maybeSingle()
  if (sel.error && COLONNA_ASSENTE.has((sel.error as { code?: string }).code ?? '')) {
    const retry = await supabase
      .from('incassi')
      .select('id, pagamento_id, importo, metodo')
      .eq('id', incassoId)
      .maybeSingle()
    if (retry.error) {
      logErrore({ operazione: 'pagamenti/incassi/storno:POST', stato: 500, evento: 'db' }, retry.error)
      return { status: 500, body: { error: 'Errore nel recupero dell\'incasso' } }
    }
    orig = retry.data as Record<string, unknown> | null
  } else if (sel.error) {
    logErrore({ operazione: 'pagamenti/incassi/storno:POST', stato: 500, evento: 'db' }, sel.error)
    return { status: 500, body: { error: 'Errore nel recupero dell\'incasso' } }
  } else {
    orig = sel.data as Record<string, unknown> | null
  }

  if (!orig) return { status: 404, body: { error: 'Incasso non trovato' } }

  if (orig.stornato_il) return { status: 409, body: { error: 'Incasso già stornato' } }
  if (orig.storno_di || orig.metodo === 'storno') {
    return { status: 409, body: { error: 'Non si può stornare uno storno' } }
  }

  const pagamentoId = orig.pagamento_id as string
  const importoStorno = -Number(orig.importo)

  // Contro-incasso negativo. Su DB non migrato il valore enum 'storno' potrebbe
  // non esistere (22P02): degrada a 'altro' con nota, così lo storno resta possibile.
  let contro = await supabase
    .from('incassi')
    .insert({
      pagamento_id: pagamentoId,
      importo: importoStorno,
      metodo: 'storno',
      storno_di: orig.id,
      registrato_da: userId,
    })
    .select('id')
    .single()
  if (contro.error && (contro.error as { code?: string }).code === '22P02') {
    contro = await supabase
      .from('incassi')
      .insert({
        pagamento_id: pagamentoId,
        importo: importoStorno,
        metodo: 'altro',
        note: 'Storno',
        storno_di: orig.id,
        registrato_da: userId,
      })
      .select('id')
      .single()
  }
  if (contro.error) {
    logErrore({ operazione: 'pagamenti/incassi/storno:POST', stato: 500, evento: 'db' }, contro.error)
    return { status: 500, body: { error: 'Errore nello storno', details: contro.error.message } }
  }

  // Da qui in poi lo storno È avvenuto (il contro-incasso c'è): le tre scritture
  // che seguono sono secondarie e non cambiano la risposta al chiamante. Ma non
  // sono più mute: ognuna controlla `{ error }` (PostgREST non lancia) e logga
  // con soli uuid e codici — mai il motivo.

  // Marca l'originale. Colonne assenti su DB non migrato → `info`; altrimenti è un
  // guasto vero. La riapertura non dipende più da questa marcatura
  // (`stornoGiaRegistrato` guarda il contro-incasso).
  const marca = await erroreScrittura(
    supabase
      .from('incassi')
      .update({ stornato_il: new Date().toISOString(), storno_motivo: motivo })
      .eq('id', orig.id),
  )
  if (marca) {
    logEvento('pagamento', COLONNA_ASSENTE.has(marca.codice) ? 'info' : 'error', {
      operazione: 'pagamenti/incassi/storno:POST',
      esito: 'storno-marcatura-non-scritta',
      incasso_id: orig.id as string,
    }, marca.errore)
  }

  // Ricalcola lo stato del pagamento. Il trigger `incassi_ricalcola` ricalcola
  // comunque; la RPC esplicita (v3, sconto-aware) resta per i DB col trigger
  // vecchio. Assente su DB non migrato → `info`.
  const ric = await erroreScrittura(supabase.rpc('ricalcola_stato_pagamento', { p_id: pagamentoId }))
  if (ric) {
    const assente = RPC_ASSENTE.has(ric.codice)
    logEvento('pagamento', assente ? 'info' : 'error', {
      operazione: 'pagamenti/incassi/storno:POST',
      esito: assente ? 'ricalcolo-rpc-assente' : 'ricalcolo-non-riuscito',
      pagamento_id: pagamentoId,
    }, ric.errore)
  }

  // Audit col MOTIVO (il motivo vive qui, non nei log).
  const audit = await erroreScrittura(
    supabase
      .from('registro_modifiche')
      .insert({
        azione: 'storno_incasso',
        tabella_interessata: 'incassi',
        record_id: orig.id,
        vecchio_valore: orig,
        nuovo_valore: { storno_motivo: motivo, contro_incasso_id: (contro.data as { id: string }).id },
        utente_id: userId,
      }),
  )
  if (audit) {
    logEvento('pagamento', 'error', {
      operazione: 'pagamenti/incassi/storno:POST',
      esito: 'audit-storno-non-scritto',
      incasso_id: orig.id as string,
    }, audit.errore)
  }

  // Evento critico: logga il SUCCESSO (id, MAI il motivo/PII).
  logEvento('pagamento', 'info', {
    operazione: 'pagamenti/incassi/storno:POST',
    esito: 'stornato',
    incasso_id: orig.id as string,
    contro_incasso_id: (contro.data as { id: string }).id,
    pagamento_id: pagamentoId,
  })

  return {
    status: 200,
    body: { success: true, data: { contro_incasso_id: (contro.data as { id: string }).id, pagamento_id: pagamentoId } },
  }
}

// POST /api/pagamenti/incassi/storno  (staff) — storno tracciato di un incasso
// Body: { incasso_id, motivo }
export const POST = withRoute('pagamenti/incassi/storno:POST', async (request: Request) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const { user } = auth

    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response
    const { incasso_id, motivo } = b.data

    const supabase = await createAdminClient()

    // Isolamento per sede, PRIMA dello storno. L'incasso non ha una sede propria:
    // si risale al pagamento, che ce l'ha. Senza questo si stornava un incasso
    // registrato in un'altra sede — e uno storno e' un movimento contabile
    // definitivo, non una lettura.
    const { data: incassoDaStornare, error: errIncasso } = await supabase
      .from('incassi').select('pagamento_id').eq('id', incasso_id).maybeSingle()
    // Un guasto non è «non trovato» (fase 5 robustezza, sesto pezzo).
    if (errIncasso) return rispostaGuastoDb('pagamenti/incassi/storno:POST', 'db:incassi', errIncasso)
    if (!incassoDaStornare) {
      return NextResponse.json({ error: 'Incasso non trovato' }, { status: 404 })
    }
    const fuoriScopeStorno = await assertPagamentoInScope(
      supabase, user, incassoDaStornare.pagamento_id as string,
    )
    if (fuoriScopeStorno) return fuoriScopeStorno

    const esito = await eseguiStornoIncasso(supabase, { incassoId: incasso_id, motivo, userId: user.id })

    // Hook di revoca sospensione (best-effort, coerente con gli altri punti). Uno
    // storno aumenta lo scaduto, quindi qui è di norma inerte, ma il hook resta a
    // prova di futuri cambi della logica di aging e non blocca mai la risposta.
    if (esito.status === 200) {
      try {
        const pagId = (esito.body.data as { pagamento_id?: string } | undefined)?.pagamento_id
        if (pagId) {
          const { data: pag, error: errPag } = await supabase.from('pagamenti').select('alunno_id').eq('id', pagId).maybeSingle()
          if (errPag) throw new Error('lettura di pagamenti per la revoca non riuscita', { cause: errPag })
          const alunnoId = (pag as { alunno_id?: string | null } | null)?.alunno_id
          if (alunnoId) await verificaRevocaSospensioneMorosita(supabase, [alunnoId])
        }
      } catch (e) {
        logEvento('pagamento', 'error', { operazione: 'pagamenti/incassi/storno:POST', esito: 'revoca_non_verificata' }, e)
      }
    }

    return NextResponse.json(esito.body, { status: esito.status })
  } catch (err) {
    logErrore({ operazione: 'pagamenti/incassi/storno:POST', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
