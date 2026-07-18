import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { parseBody } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { annullaRicevutaAttiva } from '@/lib/pagamenti/ricevute'
import { verificaRevocaSospensioneMorosita } from '@/lib/pagamenti/sospensione'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'

const postBodySchema = z.object({
  incasso_id: zUuid,
  motivo: z.string().min(3, 'Il motivo dello storno è obbligatorio (min 3 caratteri)'),
})

/** Colonne S3 assenti sul DB E2E CI non migrato → 42703 su SELECT. */
const COLONNA_ASSENTE = new Set(['42703', 'PGRST204'])

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
 * best-effort su DB non migrato), ricalcola lo stato del pagamento e annulla la
 * ricevuta attiva. Il MOTIVO va in colonna/registro_modifiche, MAI nei log.
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
        registrato_da: userId,
      })
      .select('id')
      .single()
  }
  if (contro.error) {
    logErrore({ operazione: 'pagamenti/incassi/storno:POST', stato: 500, evento: 'db' }, contro.error)
    return { status: 500, body: { error: 'Errore nello storno', details: contro.error.message } }
  }

  // Marca l'originale (best-effort: colonne assenti su DB non migrato → si salta).
  await supabase
    .from('incassi')
    .update({ stornato_il: new Date().toISOString(), storno_motivo: motivo })
    .eq('id', orig.id)
    .then(
      () => {},
      () => {},
    )

  // Ricalcola lo stato del pagamento (il trigger su incassi somma i contro-incassi;
  // l'RPC v3 è sconto-aware). Best-effort: assente su DB non migrato.
  await supabase.rpc('ricalcola_stato_pagamento', { p_id: pagamentoId }).then(
    () => {},
    () => {},
  )

  // Audit col MOTIVO (il motivo vive qui, non nei log).
  await supabase
    .from('registro_modifiche')
    .insert({
      azione: 'storno_incasso',
      tabella_interessata: 'incassi',
      record_id: orig.id,
      vecchio_valore: orig,
      nuovo_valore: { storno_motivo: motivo, contro_incasso_id: (contro.data as { id: string }).id },
      utente_id: userId,
    })
    .then(
      () => {},
      () => {},
    )

  // La ricevuta fotografa il saldo: uno storno la invalida (numero bruciato).
  await annullaRicevutaAttiva(supabase, pagamentoId, { da: userId, motivo: 'storno incasso' })

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
    const esito = await eseguiStornoIncasso(supabase, { incassoId: incasso_id, motivo, userId: user.id })

    // Hook di revoca sospensione (best-effort, coerente con gli altri punti). Uno
    // storno aumenta lo scaduto, quindi qui è di norma inerte, ma il hook resta a
    // prova di futuri cambi della logica di aging e non blocca mai la risposta.
    if (esito.status === 200) {
      try {
        const pagId = (esito.body.data as { pagamento_id?: string } | undefined)?.pagamento_id
        if (pagId) {
          const { data: pag } = await supabase.from('pagamenti').select('alunno_id').eq('id', pagId).maybeSingle()
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
