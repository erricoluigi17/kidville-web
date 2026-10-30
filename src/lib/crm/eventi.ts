import type { SupabaseClient } from '@supabase/supabase-js'
import { logEvento } from '@/lib/logging/logger'
import type { AutoreVia, TipoEvento } from './tipi'

/**
 * CRM DELLA SEGRETERIA · UNA RIGA DI STORICO.
 *
 * Ogni gesto su una scheda (creata, telefonata, visita fissata, richiamo fatto, domanda collegata…)
 * lascia una riga in `crm_eventi`. La scrittura dello storico è un di più rispetto al gesto: se fallisce,
 * il gesto ha già avuto luogo e non si annulla per questo. Per questo la funzione **non lancia mai**:
 * torna `false`, e il chiamante decide (di norma va avanti).
 *
 * ⚠️ Due righe di log, e tutte e due contano.
 *  · SUCCESSO — `logEvento('crm','info',{ esito:'evento-registrato', … })`, persistito (vedi
 *    `EVENTI_PERSISTITI`). È il battito del CRM: con i soli errori, «nessun log» non distingue «nessuna
 *    famiglia ha chiamato» da «lo storico non si scrive più».
 *  · ERRORE — `logEvento('crm','error',{ esito:'evento-non-registrato', … }, err)`: lo storico di una
 *    scheda con un buco è un'informazione persa, e va saputo.
 *
 * Nel log entrano SOLO il tipo, la sede e l'id della scheda. Mai `testo` né `dati`: sono parole di
 * famiglie e di bambini (e la redazione a lista bianca li toglierebbe comunque, ma non si conta su
 * quella per ciò che non si deve mai mandare).
 */
export async function registraEvento(
  supabase: SupabaseClient,
  e: {
    schedaId: string
    scuolaId: string
    tipo: TipoEvento
    autore: string | null
    autoreVia: AutoreVia
    dati?: Record<string, string | number | boolean | null>
    testo?: string | null
  },
): Promise<boolean> {
  const campi = { tipo: e.tipo, scuola_id: e.scuolaId, entita_id: e.schedaId }
  try {
    const { error } = await supabase.from('crm_eventi').insert({
      scheda_id: e.schedaId,
      scuola_id: e.scuolaId,
      tipo: e.tipo,
      autore: e.autore,
      autore_via: e.autoreVia,
      dati: e.dati ?? {},
      testo: e.testo ?? null,
    })
    if (error) {
      logEvento('crm', 'error', { operazione: 'crm/eventi:registraEvento', esito: 'evento-non-registrato', ...campi }, error)
      return false
    }
    logEvento('crm', 'info', { esito: 'evento-registrato', ...campi })
    return true
  } catch (err) {
    logEvento('crm', 'error', { operazione: 'crm/eventi:registraEvento', esito: 'evento-non-registrato', ...campi }, err)
    return false
  }
}
