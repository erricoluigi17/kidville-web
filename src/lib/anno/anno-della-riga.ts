import type { SupabaseClient } from '@supabase/supabase-js'
import { schemaAnnoIndietro } from '@/lib/anno/schema'

/**
 * L'ANNO DI UNA RIGA GIÀ SCRITTA (PR 4.9, correzione di un anno chiuso su PATCH e DELETE).
 *
 * Una modifica o un'eliminazione non sceglie l'anno: la riga ce l'ha già (`anno_id`, `anni_scolastici.id`). Quell'anno si DICHIARA a
 * `resolveAnnoScrittura({ dichiarato })`, che ne guarda lo stato: su un anno `chiuso` lo staff riceve il 409 con
 * `correzione_possibile` e, col motivo, un gettone; su un anno corrente passa senza gettone, come prima.
 *
 * Si legge con una query a sé, e non dentro la lettura che la route già fa, per una ragione: sul database della CI (e nella finestra
 * del deploy) la colonna `anno_id` può non esserci, e un `select` che la nomina romperebbe ogni lettura della route. Qui la colonna
 * mancante è `indietro`: la route scrive come prima della PR 4.9. Una riga senza `anno_id` (storica) è `annoId: null`, e vale lo
 * stesso: non c'è un anno da dichiarare.
 */
export type AnnoDellaRiga = { annoId: string | null } | { guasto: unknown }

export async function annoDellaRiga(supabase: SupabaseClient, tabella: string, id: string): Promise<AnnoDellaRiga> {
  const { data, error } = await supabase.from(tabella).select('anno_id').eq('id', id).limit(1)
  if (error) return schemaAnnoIndietro(error) ? { annoId: null } : { guasto: error }
  const riga = (Array.isArray(data) ? data[0] : null) as { anno_id?: unknown } | null
  return { annoId: typeof riga?.anno_id === 'string' && riga.anno_id !== '' ? riga.anno_id : null }
}
