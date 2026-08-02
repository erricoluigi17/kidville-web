import type { SupabaseClient } from '@supabase/supabase-js'
import { schemaAssente } from '@/lib/news/schema-assente'
import { logErrore } from '@/lib/logging/logger'

// =============================================================================
// W5 — la prova del consenso, senza l'indirizzo IP a tempo indefinito.
//
// `consensi_accettazioni` registra data + versione del testo accettato, e
// insieme `ip` e `user_agent` di chi ha accettato. Il fatto e la versione sono
// la prova richiesta dall'art. 7 §1 GDPR e dall'art. 1341 c.c.; l'IP no — è un
// contorno che rende la prova più circostanziata, e in cambio conserva un dato
// personale (art. 4 §1) senza scadenza.
//
// La tabella nasce di proposito SENZA foreign key su `parent_id`, per
// sopravvivere all'anonimizzazione del genitore. Scelta giusta per il valore
// probatorio, che però la lasciava fuori dall'oblio: dopo la cancellazione
// dell'account restavano IP e user-agent legati a un `parent_id` ancora unico —
// cioè a una famiglia ancora ricostruibile incrociando le altre tabelle.
//
// Qui l'oblio azzera `ip`/`user_agent` e non tocca altro: la riga continua a
// dire COSA è stato accettato e QUANDO. Il complemento è la retention
// (`consensi-retention`, migrazione 20260731210000): oltre i 24 mesi gli stessi
// due campi si azzerano da soli anche per chi non ha mai chiesto la
// cancellazione.
// =============================================================================

/**
 * Toglie IP e user-agent dalle prove di consenso di UN genitore.
 *
 * Best-effort come il resto dell'oblio: non lancia mai (un guasto qui non deve
 * interrompere un'anonimizzazione già iniziata), degrada in silenzio se lo
 * schema è assente (DB E2E della CI non migrato) e logga ogni errore inatteso —
 * un catch muto, qui, è un indirizzo IP che resta in tabella per sempre.
 *
 * @returns quante prove sono state bonificate (0 anche in caso di errore).
 */
export async function scrubProvaConsensi(
  supabase: SupabaseClient,
  parentId: string,
  operazione: string,
): Promise<number> {
  if (!parentId) return 0
  try {
    const { data, error } = await supabase
      .from('consensi_accettazioni')
      .update({ ip: null, user_agent: null })
      .eq('parent_id', parentId)
      .select('id')
    if (error) {
      if (!schemaAssente(error)) {
        logErrore({ operazione, evento: 'oblio_consensi_accettazioni' }, error)
      }
      return 0
    }
    return (data ?? []).length
  } catch (e) {
    logErrore({ operazione, evento: 'oblio_consensi_accettazioni' }, e)
    return 0
  }
}
