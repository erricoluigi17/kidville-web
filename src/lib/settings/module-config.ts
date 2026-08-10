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
  return (await leggiModuleConfig<T>(supabase, column, scuolaId)).config
}

/**
 * L'esito della lettura, per chi NON può permettersi il fail-open.
 *
 * ─── PERCHÉ ESISTE, detto sul caso che l'ha resa necessaria ──────────────────
 * `getModuleConfig` restituisce `{}` in due situazioni diverse: «questa scuola non
 * ha impostazioni» e «la riga non si è potuta leggere». Per i toggle delle
 * notifiche la differenza è tollerabile (fail-open dichiarato). Per l'emissione
 * della fattura NON lo è: `fiscale_config` illeggibile diventava `{}`, e
 * `cedenteDaConfig` ripiegava in silenzio su `aruba_config.fiscal` — cioè un
 * guasto di lettura cambiava **chi emette il documento**, su un tracciato
 * irreversibile verso lo SDI, senza che nessuno lo sapesse.
 *
 * `ok: false` significa una sola cosa: la lettura è FALLITA. Una scuola senza
 * impostazioni è `ok: true` con `config` vuota, che è la verità.
 */
export interface EsitoModuleConfig<T> {
  ok: boolean
  config: Partial<T>
}

export async function leggiModuleConfig<T extends Record<string, unknown> = Record<string, unknown>>(
  supabase: SupabaseClient,
  column: string,
  scuolaId?: string | null,
): Promise<EsitoModuleConfig<T>> {
  if (!scuolaId) return { ok: true, config: {} }
  const { data, error } = await supabase
    .from('admin_settings')
    .select(column)
    .eq('scuola_id', scuolaId)
    .maybeSingle()
  if (error) {
    // `warn` e non `error`: il chiamante FAIL-OPEN prosegue con i valori di default, quindi il
    // prodotto non si è rotto — ma sta girando con impostazioni che NON sono quelle della scuola,
    // e questa è l'unica riga da cui lo si può sapere. Va in tabella (i warn si persistono): è lì
    // che si conta se il guasto è un blip o va avanti da una settimana. Chi invece si FERMA (la
    // fattura elettronica) scrive la propria riga `error` con il suo contesto.
    //
    // ⚠️ IL NOME DELLA COLONNA E LA SEDE STANNO NELLA RIGA, e prima non c'erano: si sapeva che
    // «una config» non si era letta, non QUALE né DI CHI — su una funzione che serve quindici
    // moduli e tre sedi, cioè un allarme che non si può nemmeno interrogare. Il nome della
    // colonna viaggia dentro `esito` (in lista bianca, forma di enumerato: resta in chiaro in
    // tabella) e non in un `msg`, che accanto a un errore verrebbe redatto.
    logEvento('config', 'warn', {
      operazione: 'getModuleConfig',
      esito: `config-illeggibile-${column}`,
      scuola_id: scuolaId,
    }, error)
    return { ok: false, config: {} }
  }
  const row = data as Record<string, unknown> | null
  return { ok: true, config: (row?.[column] ?? {}) as Partial<T> }
}
