import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { logErrore } from '@/lib/logging/logger'
import { schemaAnnoIndietro } from '@/lib/anno/schema'

/**
 * L'`anni_scolastici.id` di un'etichetta («2026/27» o «2026/2027»: sono le due forme generate dello stesso
 * anno, quindi un testo dà al più una riga). Due letture con `eq` e non un `.or()`: il testo arriva dal
 * client e non entra mai in un filtro PostgREST. `null` = nessun anno con quell'etichetta;
 * `indietro` = lo schema dell'anno non c'è (database della CI): si scrive come prima, senza `anno_id`.
 *
 * La usano le route che hanno in mano l'etichetta testuale di un anno e non il suo uuid:
 * scrutinio-periodi (l'etichetta che manda la pagina) e il certificato delle competenze
 * (l'etichetta dello scrutinio finale da cui nasce, Ruling P49).
 */
export async function annoDaEtichetta(
  supabase: SupabaseClient,
  etichetta: string,
  operazione: string,
): Promise<{ annoId: string | null } | { indietro: true } | { guasto: NextResponse }> {
  for (const colonna of ['etichetta_breve', 'etichetta'] as const) {
    const { data, error } = await supabase.from('anni_scolastici').select('id').eq(colonna, etichetta).limit(1)
    if (error) {
      if (schemaAnnoIndietro(error)) return { indietro: true }
      logErrore({ operazione, stato: 500, evento: 'anno-etichetta-non-letta' }, error)
      return { guasto: NextResponse.json({ error: 'Errore interno', codice: 'LETTURA_FALLITA' }, { status: 500 }) }
    }
    const riga = (Array.isArray(data) ? data[0] : null) as { id?: string } | null
    if (riga?.id) return { annoId: riga.id }
  }
  return { annoId: null }
}
