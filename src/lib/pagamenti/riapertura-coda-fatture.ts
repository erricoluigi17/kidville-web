import type { SupabaseClient } from '@supabase/supabase-js'
import { logErrore, logEvento } from '@/lib/logging/logger'

// ─────────────────────────────────────────────────────────────────────────────
// LA CODA FATTURE DAVANTI A UNA RIAPERTURA (2026-10-05).
//
// Il caso che l'ha fatta nascere: un bonifico associato alla retta sbagliata
// aveva messo in coda la fattura di QUELLA retta; riaperto il bonifico, la voce
// tornava da pagare ma la richiesta restava in coda («errore», poi «non
// saldato» a ogni giro). Due regole:
//  · PRIMA di stornare: una richiesta `in_invio` ferma tutto (409). Il lavoratore
//    sta parlando con Aruba proprio adesso, e stornare sotto di lui produce una
//    fattura su una voce non più pagata.
//  · DOPO lo storno: le richieste `in_coda`/`errore` delle voci che NON sono più
//    `pagato` si tolgono (`fatture_coda_togli`). Una voce ancora saldata da altri
//    incassi tiene la sua richiesta.
// Sul DB E2E della CI la tabella non c'è: si degrada a «nessuna richiesta».
// ─────────────────────────────────────────────────────────────────────────────

/** Tabella o RPC assente (DB E2E della CI, mai migrato): si degrada, non si cade. */
const ASSENTE = new Set(['42P01', 'PGRST205', 'PGRST202', '42883'])

/** Le voci toccate dalla riapertura: la voce singola, o quelle degli incassi della transazione. */
export async function vociDelMovimento(
  supabase: SupabaseClient,
  mov: { pagamento_id: string | null; transazione_id?: string | null },
  operazione: string,
): Promise<string[]> {
  const ids = new Set<string>()
  if (mov.pagamento_id) ids.add(mov.pagamento_id)
  if (mov.transazione_id) {
    const { data, error } = await supabase.from('incassi').select('pagamento_id').eq('transazione_id', mov.transazione_id)
    if (error) {
      logEvento('pagamento', 'warn', { operazione, esito: 'voci-transazione-non-lette' }, error)
    } else {
      for (const r of (data ?? []) as { pagamento_id: string | null }[]) if (r.pagamento_id) ids.add(r.pagamento_id)
    }
  }
  return [...ids]
}

/** `true` se una richiesta di fattura su queste voci è IN INVIO adesso. Fail-closed su errore. */
export async function codaInInvio(
  supabase: SupabaseClient,
  pagamentoIds: string[],
  operazione: string,
): Promise<{ inInvio: boolean } | { guasto: true }> {
  if (pagamentoIds.length === 0) return { inInvio: false }
  const { data, error } = await supabase
    .from('fatture_coda').select('id').in('pagamento_id', pagamentoIds).eq('stato', 'in_invio').limit(1)
  if (error) {
    if (ASSENTE.has(error.code ?? '')) {
      // Ignorabile, ma non muto (AGENTS.md, regola 6): senza tabella non c'è
      // nessuna richiesta che possa essere in invio.
      logEvento('pagamento', 'info', { operazione, esito: 'coda-fatture-assente' }, error)
      return { inInvio: false }
    }
    logErrore({ operazione, evento: 'coda_fatture_non_letta_riapertura', stato: 500 }, error)
    return { guasto: true }
  }
  return { inInvio: ((data ?? []) as unknown[]).length > 0 }
}

/** Toglie dalla coda le richieste delle voci che dopo lo storno non sono più saldate. Mai lancia. */
export async function togliCodaVociNonSaldate(
  supabase: SupabaseClient,
  pagamentoIds: string[],
  attoreId: string,
  operazione: string,
): Promise<number> {
  if (pagamentoIds.length === 0) return 0
  const { data: pag, error: errPag } = await supabase.from('pagamenti').select('id, stato').in('id', pagamentoIds)
  if (errPag) {
    logEvento('pagamento', 'error', { operazione, esito: 'coda-fatture-voci-non-lette' }, errPag)
    return 0
  }
  const nonSaldate = ((pag ?? []) as { id: string; stato: string }[]).filter((p) => p.stato !== 'pagato').map((p) => p.id)
  if (nonSaldate.length === 0) return 0
  const { data: righe, error: errCoda } = await supabase
    .from('fatture_coda').select('id').in('pagamento_id', nonSaldate).in('stato', ['in_coda', 'errore'])
  if (errCoda) {
    logEvento('pagamento', ASSENTE.has(errCoda.code ?? '') ? 'info' : 'error', { operazione, esito: 'coda-fatture-non-letta' }, errCoda)
    return 0
  }
  const ids = ((righe ?? []) as { id: string }[]).map((r) => r.id)
  if (ids.length === 0) return 0
  const { data: n, error: errTogli } = await supabase.rpc('fatture_coda_togli', { p_ids: ids, p_attore: attoreId })
  if (errTogli) {
    logEvento('pagamento', ASSENTE.has(errTogli.code ?? '') ? 'info' : 'error', { operazione, esito: 'coda-fatture-non-tolta', n: ids.length }, errTogli)
    return 0
  }
  logEvento('pagamento', 'info', { operazione, esito: 'coda-fatture-tolta-dopo-riapertura', n: Number(n ?? 0) })
  return Number(n ?? 0)
}
