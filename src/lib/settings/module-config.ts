import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Legge la config JSONB di un modulo da admin_settings (es. 'presenze_config').
 * Ritorna {} se la scuola non ha ancora una riga impostazioni (o se scuolaId assente).
 */
export async function getModuleConfig<T extends Record<string, unknown> = Record<string, unknown>>(
  supabase: SupabaseClient,
  column: string,
  scuolaId?: string | null,
): Promise<Partial<T>> {
  if (!scuolaId) return {}
  const { data } = await supabase
    .from('admin_settings')
    .select(column)
    .eq('scuola_id', scuolaId)
    .maybeSingle()
  const row = data as Record<string, unknown> | null
  return ((row?.[column] ?? {}) as Partial<T>)
}
