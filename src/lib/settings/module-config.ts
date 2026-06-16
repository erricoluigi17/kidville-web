import type { SupabaseClient } from '@supabase/supabase-js'

const DEFAULT_SCUOLA = '11111111-1111-1111-1111-111111111111'

/**
 * Legge la config JSONB di un modulo da admin_settings (es. 'presenze_config').
 * Ritorna {} se la scuola non ha ancora una riga impostazioni.
 */
export async function getModuleConfig<T extends Record<string, unknown> = Record<string, unknown>>(
  supabase: SupabaseClient,
  column: string,
  scuolaId?: string | null,
): Promise<Partial<T>> {
  const { data } = await supabase
    .from('admin_settings')
    .select(column)
    .eq('scuola_id', scuolaId || DEFAULT_SCUOLA)
    .maybeSingle()
  const row = data as Record<string, unknown> | null
  return ((row?.[column] ?? {}) as Partial<T>)
}
