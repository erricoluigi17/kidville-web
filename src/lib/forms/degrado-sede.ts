import type { SupabaseClient } from '@supabase/supabase-js'
import { sediReali } from '@/lib/scuole/reali'
import { logEvento } from '@/lib/logging/logger'

/**
 * Degrado del filtro di sede quando la colonna non esiste ancora.
 *
 * Il DB E2E della CI è un progetto separato e **non migrato**: là
 * `form_submissions.scuola_id` non c'è, e una `.in('scuola_id', …)` fallisce con
 * `42703`. Senza una via d'uscita l'elenco risponderebbe 500 e la suite
 * cadrebbe — ma la via d'uscita NON può essere «allora niente filtro»: sarebbe
 * esattamente il fallback che riapre la falla, quello che questo lavoro esiste
 * per togliere di mezzo.
 *
 * La regola qui è più stretta e verificabile: si prosegue senza filtro **solo
 * se non c'è niente da isolare**, cioè se il deployment ha al più UNA sede
 * reale. In produzione le sedi sono tre, quindi questo degrado non scatta mai;
 * sul DB E2E ce n'è una, e proseguire non espone nulla che non fosse già
 * dell'unico plesso esistente.
 *
 * Se le sedi sono più d'una e la colonna manca, si NEGA: significa che qualcuno
 * ha rimosso una colonna di isolamento su un impianto multi-sede, ed è un
 * incidente, non una condizione da assecondare.
 *
 * ⚠️ E si NEGA anche quando le sedi non si riescono a CONTARE. Fino al
 * 2026-07-31 qui si leggeva solo `reali` e si buttava via `error`: `sediReali`
 * ritorna `{ tutte: [], reali: [], error }` sia quando `schools` è illeggibile
 * sia quando lancia, e `0 <= 1` è vero — quindi un guasto di lettura veniva
 * dichiarato «degrado lecito» e le route di modulistica rileggevano senza
 * NESSUN filtro di sede, col log che diceva `sedi: 0`, cioè il contrario di
 * quel che era successo. `reali: []` ha due significati opposti — «questo
 * impianto ha al più una sede» e «non sono riuscito a leggerle» — e il valore
 * che li distingue era già nel tipo di ritorno. Non sapere quante sedi ci sono
 * significa NEGARE, mai «procedo senza filtro».
 */
const COLONNA_ASSENTE = new Set(['PGRST204', '42703'])

export function colonnaSedeAssente(error: { code?: string } | null | undefined): boolean {
  return COLONNA_ASSENTE.has(error?.code ?? '')
}

export async function degradoSedeLecito(
  supabase: SupabaseClient,
  operazione: string,
): Promise<boolean> {
  const { reali, error } = await sediReali(supabase, operazione)
  if (error) {
    logEvento('modulistica', 'error', {
      operazione,
      esito: 'sedi-non-leggibili-degrado-negato',
    }, error)
    return false
  }
  const lecito = reali.length <= 1
  logEvento('modulistica', lecito ? 'info' : 'error', {
    operazione,
    esito: lecito ? 'colonna-sede-assente-degrado-lecito' : 'colonna-sede-assente-su-impianto-multisede',
    sedi: reali.length,
  })
  return lecito
}
