import type { SupabaseClient } from '@supabase/supabase-js'
import { leggiTutte } from './db'
import type { AppartenenzaStorica } from './tipi'

/** I confini arrivano dai gate del chiamante, mai dalla sola classe corrente. */
export async function appartenenzeNelGiorno(db: SupabaseClient, input: { scuole: string[]; sectionIds?: string[]; alunnoIds?: string[]; giorno: string }): Promise<AppartenenzaStorica[]> {
  if (!input.scuole.length || input.sectionIds?.length === 0 || input.alunnoIds?.length === 0) return []
  return leggiTutte<AppartenenzaStorica>((dal, al) => {
    let query = db.from('alunni_classi_storico').select('alunno_id,scuola_id,section_id,dal,al').in('scuola_id', input.scuole).lte('dal', input.giorno).or(`al.is.null,al.gt.${input.giorno}`)
    if (input.sectionIds) query = query.in('section_id', input.sectionIds)
    if (input.alunnoIds) query = query.in('alunno_id', input.alunnoIds)
    return query.order('id').range(dal, al)
  }, 'appartenenze-giornata')
}
