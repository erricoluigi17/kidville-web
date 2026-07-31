import type { SupabaseClient } from '@supabase/supabase-js'
import { logEvento } from '@/lib/logging/logger'
import type { SidiFlusso } from './client'
import type { FaseStato } from './sequenza'

export interface SidiSyncState {
  scuola_id: string
  fase_a_stato: FaseStato
  frequentanti_stato: FaseStato
  piattaforma_unica_stato: FaseStato
  fase_a_ts?: string | null
  frequentanti_ts?: string | null
  piattaforma_unica_ts?: string | null
  ultimo_esito?: unknown
}

const VUOTO = (scuolaId: string): SidiSyncState => ({
  scuola_id: scuolaId,
  fase_a_stato: 'non_inviato',
  frequentanti_stato: 'non_inviato',
  piattaforma_unica_stato: 'non_inviato',
})

/**
 * Stato di sincronizzazione corrente della scuola (default tutto non_inviato).
 *
 * Su errore di lettura si torna al default: è la direzione SICURA, perché le
 * guardie di sequenza bloccano l'invio quando la fase precedente non risulta
 * `inviato`. Ma senza il log qui sotto quel «non_inviato» è indistinguibile da
 * quello vero, e un guasto del DB si presenta all'operatore come un pulsante
 * disabilitato senza spiegazione.
 */
export async function loadSyncState(supabase: SupabaseClient, scuolaId: string): Promise<SidiSyncState> {
  const { data, error } = await supabase.from('sidi_sync_state').select('*').eq('scuola_id', scuolaId).maybeSingle()
  if (error) {
    logEvento('sidi', 'error', {
      operazione: 'loadSyncState', tipo: 'sync_state', esito: 'stato-non-letto', scuola_id: scuolaId,
    }, error)
  }
  return (data as SidiSyncState | null) ?? VUOTO(scuolaId)
}

/**
 * Persiste l'esito di un flusso (colonna `<flusso>_stato`/`_ts`) + ultimo esito.
 *
 * PostgREST non lancia: l'esito dell'upsert va LETTO. Se non lo si legge, un
 * flusso trasmesso davvero al Ministero può restare registrato come «non
 * inviato» — l'indicatore mente, la fase successiva resta bloccata, e non c'è
 * una riga da nessuna parte che dica perché. Si logga anche il successo: su un
 * evento critico, «nessun log» non deve poter significare due cose opposte.
 */
export async function persistFaseStato(
  supabase: SupabaseClient,
  scuolaId: string,
  flusso: SidiFlusso,
  stato: FaseStato,
  esito: unknown
): Promise<void> {
  const now = new Date().toISOString()
  const { error } = await supabase.from('sidi_sync_state').upsert(
    {
      scuola_id: scuolaId,
      [`${flusso}_stato`]: stato,
      [`${flusso}_ts`]: now,
      ultimo_esito: esito,
      updated_at: now,
    },
    { onConflict: 'scuola_id' }
  )
  if (error) {
    logEvento('sidi', 'error', {
      operazione: 'persistFaseStato', tipo: flusso, stato, esito: 'stato-non-persistito', scuola_id: scuolaId,
    }, error)
    return
  }
  logEvento('sidi', 'info', {
    operazione: 'persistFaseStato', tipo: flusso, stato, esito: 'stato-persistito', scuola_id: scuolaId,
  })
}
