import type { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { logEvento } from '@/lib/logging/logger'
import { rispostaGuastoDb } from '@/lib/pagamenti/guasto-db'
import { CODICI_COLONNA_ASSENTE } from '@/lib/pagamenti/metodi-ammessi'
import { STATI_CODA_OCCUPATA } from '@/lib/pagamenti/fatturazione-riga'

/**
 * LE GUARDIE DELL'ELIMINAZIONE DI UNA VOCE — scritte una volta sola (2026-10-12).
 *
 * Erano dentro `DELETE /api/pagamenti/[id]` (fase 7 della robustezza). Ora le usano tre route:
 * la DELETE, `GET /api/pagamenti/[id]/eliminabile` (il verdetto per la finestra Modifica) e la
 * sostituzione di Rateizza (`POST /api/pagamenti/rate`). Il primo controllo che rifiuta decide.
 *
 * Una lettura che fallisce per un guasto ferma tutto (500): una guardia che non ha potuto
 * guardare non dà via libera. Salta solo dove lo schema manca davvero (DB E2E non migrato).
 *
 * `perSostituzione`: Rateizza sostituisce la voce con un piano dello stesso importo, quindi il
 * debito continua — la ricarica di ticket e l'ordine divise non bloccano, e i ticket restano.
 */

/** Tabella assente sul DB non migrato. */
export const TABELLA_ASSENTE = new Set(['42P01', 'PGRST205'])

export type VoceDaEliminare = {
  id: string
  alunno_id: string | null
  scuola_id: string | null
  tipo: string
  [k: string]: unknown
}

export type EsitoEliminabile =
  | { ok: true; voce: VoceDaEliminare; famiglia: string[]; rate: number; ticket: number }
  | { ok: false; stato: 404 | 409; codice?: string; error: string }
  | { ok: false; guasto: NextResponse }

type Opzioni = { sedi: string[]; perSostituzione: boolean; operazione: string }

const rifiuto = (codice: string, error: string): EsitoEliminabile => ({ ok: false, stato: 409, codice, error })

export async function controllaVoceEliminabile(
  supabase: SupabaseClient,
  id: string,
  { sedi, perSostituzione, operazione }: Opzioni,
): Promise<EsitoEliminabile> {
  const guasto = (evento: string, error: unknown): EsitoEliminabile => ({
    ok: false,
    guasto: rispostaGuastoDb(operazione, evento, error),
  })

  const { data: letta, error: errVoce } = await supabase.from('pagamenti').select('*').eq('id', id).maybeSingle()
  if (errVoce) return guasto('db:pagamenti', errVoce)
  const voce = letta as VoceDaEliminare | null
  // Fuori dalle sedi attive vale come «non esiste»: non si dice a chi non deve saperlo.
  if (!voce || !sedi.includes(String(voce.scuola_id))) return { ok: false, stato: 404, error: 'Pagamento non trovato' }

  if (voce.tipo === 'rata') {
    return rifiuto('VOCE_RATA', 'È una rata di un piano: si elimina il piano intero dalla voce principale.')
  }

  // La DELETE porta via in CASCADE rate e quote (`parent_payment_id`): ogni guardia guarda la
  // voce E le figlie (fase 7).
  const { data: figlie, error: errFiglie } = await supabase.from('pagamenti').select('id').eq('parent_payment_id', id)
  if (errFiglie) return guasto('db:pagamenti:figlie', errFiglie)
  const famiglia = [id, ...((figlie ?? []) as { id: string }[]).map((f) => f.id)]

  // Conservazione fiscale: FK RESTRICT + WORM. Le ricevute restano (ON DELETE SET NULL).
  const fatt = await supabase.from('fatture_emesse').select('id').in('pagamento_id', famiglia).limit(1)
  if (fatt.error && !TABELLA_ASSENTE.has(fatt.error.code ?? '')) return guasto('db:fatture_emesse:guardia', fatt.error)
  if (!fatt.error && (fatt.data?.length ?? 0) > 0) {
    return rifiuto(
      'VOCE_FATTURATA',
      'Pagamento con fattura emessa: non eliminabile per conservazione fiscale. Annulla/storna prima la fattura.',
    )
  }

  // Un incasso qualunque, anche stornato, è contabilità: gli incassi non si cancellano mai (lo
  // storno è una riga in più) e la voce che li porta resta (fase 7, FK RESTRICT).
  const inc = await supabase.from('incassi').select('id').in('pagamento_id', famiglia).limit(1)
  if (inc.error) return guasto('db:incassi:guardia', inc.error)
  if ((inc.data?.length ?? 0) > 0) {
    // Solo per dire la via d'uscita giusta: la decisione è già presa. Un guasto di questa
    // lettura, o la colonna assente sul DB E2E, cambiano solo il messaggio.
    const tx = await supabase.from('incassi').select('id').in('pagamento_id', famiglia).not('transazione_id', 'is', null).limit(1)
    if (tx.error && !CODICI_COLONNA_ASSENTE.includes(tx.error.code ?? '')) {
      logEvento('pagamento', 'warn', { operazione, esito: 'transazione-non-letta', pagamento_id: id }, tx.error)
    }
    const diTransazione = !tx.error && (tx.data?.length ?? 0) > 0
    logEvento('pagamento', 'info', { operazione, esito: 'eliminazione-rifiutata-incassi', pagamento_id: id, transazione: diTransazione })
    return diTransazione
      ? rifiuto('VOCE_IN_TRANSAZIONE', 'Pagamento con incassi di una transazione di famiglia: annulla prima la transazione.')
      : rifiuto(
          'VOCE_CON_INCASSI',
          'La voce ha incassi registrati (anche stornati): resta per la contabilità. Se è sbagliata, storna gli incassi e correggi la voce invece di eliminarla.',
        )
  }

  // Una fattura in coda («in invio» = file forse già partito verso SDI) se ne andrebbe in CASCADE.
  const coda = await supabase
    .from('fatture_coda')
    .select('id')
    .in('pagamento_id', famiglia)
    .in('stato', [...STATI_CODA_OCCUPATA])
    .limit(1)
  if (coda.error && !TABELLA_ASSENTE.has(coda.error.code ?? '')) return guasto('db:fatture_coda:guardia', coda.error)
  if (!coda.error && (coda.data?.length ?? 0) > 0) {
    return rifiuto('VOCE_IN_CODA_FATTURE', 'La voce ha una fattura in coda di emissione: toglila dalla coda prima di eliminare la voce.')
  }

  if (perSostituzione) return { ok: true, voce, famiglia, rate: famiglia.length - 1, ticket: 0 }

  // L'ordine divise perderebbe il suo addebito (FK SET NULL): si elimina solo l'addebito di un
  // ordine già annullato.
  const ord = await supabase.from('divise_ordini').select('id').in('pagamento_id', famiglia).neq('stato', 'annullato').limit(1)
  if (ord.error && !TABELLA_ASSENTE.has(ord.error.code ?? '')) return guasto('db:divise_ordini:guardia', ord.error)
  if (!ord.error && (ord.data?.length ?? 0) > 0) {
    return rifiuto('ORDINE_DIVISE_ATTIVO', 'È l’addebito di un ordine divise ancora attivo: annulla prima l’ordine.')
  }

  // Ricarica ticket: la voce si elimina insieme ai suoi ticket (RPC `elimina_voce_ricarica_ticket`),
  // e solo se ci sono ancora tutti. Il ledger è SET NULL: senza questa guardia restano accreditati.
  const mov = await supabase.from('mensa_ticket_movimenti').select('delta').in('pagamento_id', famiglia).eq('tipo', 'ricarica')
  if (mov.error && !TABELLA_ASSENTE.has(mov.error.code ?? '')) return guasto('db:mensa_ticket_movimenti:guardia', mov.error)
  const ticket = mov.error ? 0 : ((mov.data ?? []) as { delta: number | string }[]).reduce((s, m) => s + Number(m.delta), 0)
  if (ticket > 0) {
    const sal = await supabase.from('ticket_mensa').select('saldo_ticket').eq('alunno_id', String(voce.alunno_id)).maybeSingle()
    if (sal.error) return guasto('db:ticket_mensa:guardia', sal.error)
    const saldo = Number((sal.data as { saldo_ticket?: number | null } | null)?.saldo_ticket ?? 0)
    if (saldo < ticket) {
      return rifiuto('TICKET_GIA_USATI', 'I ticket di questa ricarica sono già stati usati: la voce non si può eliminare.')
    }
  }

  return { ok: true, voce, famiglia, rate: famiglia.length - 1, ticket }
}
