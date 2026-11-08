import type { SupabaseClient } from '@supabase/supabase-js'
import { logEvento } from '@/lib/logging/logger'
import { anniDellaSede } from '@/lib/anno/lettura'
import { annoAttivoDiSede } from '@/lib/anno/frequenze'

/**
 * L'anno ATTIVO dei plessi, per le ricerche di una sezione PER NOME (Compito 4.3.7).
 *
 * I nomi di classe si ripetono ogni anno («1A» c'è nel 2026/27 e ci sarà nel 2027/28): una ricerca per nome che non
 * guarda l'anno può agganciare un bambino alla «1A» sbagliata, in silenzio. Le funzioni di libreria non hanno la
 * `request` (quindi nemmeno il cookie dell'anno scelto dalla segreteria): per loro l'anno è quello ATTIVO della sede,
 * lo stesso che usa il trigger `sync_alunno_section_id` per ricavare `section_id` da `classe_sezione`.
 *
 * Ritorna gli `anni_scolastici.id` (quello che porta `sections.anno_id`), uno per anno attivo dei plessi dati, oppure
 * `null` = «niente filtro d'anno»: database senza lo schema dell'anno (il DB E2E della CI non è migrato), plessi senza
 * righe in `anni_sede`, sede senza anno attivo, lettura fallita. Come `resolveAnnoLettura`, `null` vuol dire «leggi
 * come prima della PR 4.3»: un filtro `.eq('anno_id', …)` su un database che non ha la colonna darebbe `42703`.
 *
 * Mai lancia. Un guasto vero (non lo schema indietro) lascia una riga `warn` e degrada a «nessun filtro»: è il
 * comportamento di prima, e lo stesso guasto lo vede già `resolveAnnoLettura` per le liste.
 */
export async function anniAttiviDeiPlessi(
  supabase: SupabaseClient,
  plessi: readonly (string | null | undefined)[],
): Promise<string[] | null> {
  const sedi = [...new Set(plessi.filter((p): p is string => typeof p === 'string' && p !== ''))]
  if (sedi.length === 0) return null
  const cache = new Map<string, string | null>()
  const anni = new Set<string>()
  for (const sede of sedi) {
    const lette = await anniDellaSede(supabase, sede)
    if ('indietro' in lette) return null
    if ('guasto' in lette) {
      logEvento('anno-scolastico', 'warn', { tipo: 'anni-attivi-non-letti', azione: 'anniAttiviDeiPlessi' }, lette.guasto)
      return null
    }
    if (lette.righe.length === 0) continue
    const attivo = await annoAttivoDiSede(supabase, sede, cache)
    const riga = lette.righe.find((r) => r.id === attivo)
    if (riga) anni.add(String(riga.anno_id))
  }
  return anni.size > 0 ? [...anni] : null
}
