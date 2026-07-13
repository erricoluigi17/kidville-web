import type { SupabaseClient } from '@supabase/supabase-js'
import { logEvento } from '@/lib/logging/logger'

/**
 * Legge la config JSONB di un modulo da admin_settings (es. 'presenze_config').
 * Ritorna {} se la scuola non ha ancora una riga impostazioni (o se scuolaId assente).
 *
 * `{}` HA DUE SIGNIFICATI, e finora erano indistinguibili: "questa scuola non ha ancora
 * impostazioni" (normale) e "la riga non si è potuta leggere" (guasto). PostgREST non lancia:
 * ritorna `{ error }` (AGENTS regola 7), e l'errore veniva scartato dalla destrutturazione.
 *
 * La differenza non è accademica: sopra questa funzione ci sono i toggle delle notifiche, che
 * sono FAIL-OPEN. Config illeggibile → `{}` → nessun toggle → tutte le notifiche considerate
 * attive. È il comportamento giusto (meglio una notifica in più che una persa), ma se la config
 * fosse illeggibile per giorni nessuno se ne accorgerebbe: le impostazioni della scuola
 * risulterebbero semplicemente ignorate, senza un solo segnale. Il fail-open resta; il silenzio no.
 */
export async function getModuleConfig<T extends Record<string, unknown> = Record<string, unknown>>(
  supabase: SupabaseClient,
  column: string,
  scuolaId?: string | null,
): Promise<Partial<T>> {
  if (!scuolaId) return {}
  const { data, error } = await supabase
    .from('admin_settings')
    .select(column)
    .eq('scuola_id', scuolaId)
    .maybeSingle()
  if (error) {
    // `warn` e non `error`: il chiamante prosegue con i valori di default, quindi il prodotto
    // non si è rotto — ma sta girando con impostazioni che NON sono quelle della scuola, e questa
    // è l'unica riga da cui lo si può sapere. Va in tabella (i warn si persistono): è lì che si
    // conta se il guasto è un blip o va avanti da una settimana.
    logEvento('config', 'warn', { operazione: 'getModuleConfig', esito: 'config-illeggibile' }, error)
    return {}
  }
  const row = data as Record<string, unknown> | null
  return ((row?.[column] ?? {}) as Partial<T>)
}
