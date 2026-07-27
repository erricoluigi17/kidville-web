/**
 * Sospensione di una CONVERSAZIONE 1:1 (chat scuola↔famiglia) — granularità THREAD.
 *
 * Stesso stampo di `assertGenitoreNonSospeso` (`src/lib/pagamenti/sospensione.ts`):
 * un guard riusabile che ritorna una `NextResponse` 403 pronta, oppure `null` se
 * l'azione è consentita. Blocca SOLO la SCRITTURA di un messaggio; la lettura resta
 * libera. La granularità è il THREAD (che incorpora `${teacher_id}:${parent_id}:
 * ${student_id}`): un genitore con due figli in sezioni diverse ha due thread
 * distinti, e sospenderne uno non tocca l'altro.
 *
 * BIDIREZIONALE MA DICHIARATA: chi è stato sospeso (`sospesa_verso`) non può più
 * scrivere; chi HA sospeso continua a scrivere. Lo storico vive in
 * `conversazioni_sospensioni` (append-only), qui si consulta la SOLA riga attiva
 * tramite l'indice parziale `WHERE riaperta_il IS NULL` (query puntuale, al più una).
 *
 * PRIVACY (criterio 6): si legge SOLO `sospesa_verso`. Il `motivo` (testo libero,
 * dato) non viene mai selezionato né loggato: se anche finisse nella riga, questa
 * guardia non lo tocca. Nei log di un tentativo bloccato entrano SOLO uuid.
 *
 * DEGRADAZIONE: sul DB E2E della CI (non migrato) la tabella non esiste → PostgREST
 * ritorna `{ error }` (42P01/PGRST205) e si degrada a "non sospesa" (fail-open,
 * coerente con gli altri guard chat: una sospensione non determinabile non blocca
 * una chat scuola↔famiglia). PostgREST NON lancia: si controlla il valore di ritorno.
 */
import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { logEvento } from '@/lib/logging/logger'
import { schemaAssente } from '@/lib/news/schema-assente'

function negato(): NextResponse {
  return NextResponse.json(
    {
      error: 'Conversazione sospesa: non puoi inviare nuovi messaggi in questa conversazione.',
      motivo: 'conversazione_sospesa',
    },
    { status: 403 },
  )
}

/**
 * 403 (motivo `conversazione_sospesa`) se esiste una sospensione ATTIVA sul thread
 * il cui `sospesa_verso` è il mittente; altrimenti `null`.
 */
export async function assertConversazioneNonSospesa(
  supabase: SupabaseClient,
  threadId: string,
  senderId: string,
): Promise<NextResponse | null> {
  const { data, error } = await supabase
    .from('conversazioni_sospensioni')
    .select('sospesa_verso')
    .eq('thread_id', threadId)
    .is('riaperta_il', null)
    .maybeSingle()

  if (error) {
    // Tabella assente (DB E2E non migrato): nessuna sospensione possibile → non blocca.
    if (schemaAssente(error)) return null
    // Errore vero di lettura: si logga (SOLO uuid, mai il motivo/PII) ma NON si
    // blocca la chat su un guasto d'osservabilità — fail-open come gli altri guard.
    logEvento(
      'chat',
      'error',
      { operazione: 'assertConversazioneNonSospesa', esito: 'lettura-fallita', threadId },
      error,
    )
    return null
  }

  if (data && (data as { sospesa_verso?: string }).sospesa_verso === senderId) {
    // Tentativo bloccato: nel log SOLO uuid (threadId/senderId), MAI il motivo.
    logEvento('chat', 'info', {
      operazione: 'assertConversazioneNonSospesa',
      esito: 'conversazione-sospesa',
      threadId,
      senderId,
    })
    return negato()
  }
  return null
}
