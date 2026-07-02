import type { SupabaseClient } from '@supabase/supabase-js'
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

/** Stato di sincronizzazione corrente della scuola (default tutto non_inviato). */
export async function loadSyncState(supabase: SupabaseClient, scuolaId: string): Promise<SidiSyncState> {
  const { data } = await supabase.from('sidi_sync_state').select('*').eq('scuola_id', scuolaId).maybeSingle()
  return (data as SidiSyncState | null) ?? VUOTO(scuolaId)
}

/** Persiste l'esito di un flusso (colonna `<flusso>_stato`/`_ts`) + ultimo esito. */
export async function persistFaseStato(
  supabase: SupabaseClient,
  scuolaId: string,
  flusso: SidiFlusso,
  stato: FaseStato,
  esito: unknown
): Promise<void> {
  const now = new Date().toISOString()
  await supabase.from('sidi_sync_state').upsert(
    {
      scuola_id: scuolaId,
      [`${flusso}_stato`]: stato,
      [`${flusso}_ts`]: now,
      ultimo_esito: esito,
      updated_at: now,
    },
    { onConflict: 'scuola_id' }
  )
}
