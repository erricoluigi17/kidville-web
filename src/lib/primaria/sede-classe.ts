import type { SupabaseClient } from '@supabase/supabase-js'
import { logErrore } from '@/lib/logging/logger'

/**
 * La sede di una CLASSE (`sections.scuola_id`; la tabella dei voti e quella degli impreparati non hanno `scuola_id`).
 *
 * È la sede con cui si cercano i quadrimestri di una voce: la stessa che usano la PATCH (via l'embed `sections`) e il
 * ricalcolo SQL (`JOIN sections`). La sede della MATERIA coincide in un database sano, ma non è la fonte: se divergessero,
 * i periodi si leggerebbero in una sede e il ricalcolo li riassegnerebbe in un'altra.
 *
 * `undefined` = lettura fallita (già loggata a livello error): chi chiama risponde 500 `LETTURA_FALLITA` e non scrive niente.
 * `null` = la classe non ha sede (o non esiste).
 */
export async function scuolaDiSezione(
  supabase: SupabaseClient,
  sectionId: string,
  operazione: string,
): Promise<string | null | undefined> {
  const { data, error } = await supabase.from('sections').select('scuola_id').eq('id', sectionId).maybeSingle()
  if (error) {
    logErrore({ operazione, stato: 500, evento: 'db' }, error)
    return undefined
  }
  return ((data as { scuola_id?: string | null } | null)?.scuola_id ?? null) as string | null
}
