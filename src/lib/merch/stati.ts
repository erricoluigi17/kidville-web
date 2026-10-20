import type { SupabaseClient } from '@supabase/supabase-js'
import { logEvento } from '@/lib/logging/logger'
import { guastoSecondario } from '@/lib/db/guasto'

// =============================================================================
// Macchina a stati logistici del Merchandise (enforced server-side).
//
// Stato PER RIGA (una riga polo M può essere arrivata mentre la felpa L è ancora
// da ordinare). Lo stato della TESTATA `divise_ordini.stato` resta nel vocabolario
// legacy (inviato/confermato/consegnato/annullato, CHECK invariato) ed è DERIVATO
// dagli stati riga → nessuna migrazione del CHECK, retrocompatibilità piena.
//
//   da_ordinare → ordinato (crea PO / segna manuale)
//               → arrivato (evasione da magazzino, origine='magazzino')
//   ordinato    → arrivato (check-in PO) | da_ordinare (annullo PO)
//   arrivato    → consegnato (consegna all'alunno)
//   + annullato da ogni stato non terminale.
// consegnato/annullato = terminali (il cambio taglia genera una NUOVA riga).
// =============================================================================

export const STATI_RIGA = ['da_ordinare', 'ordinato', 'arrivato', 'consegnato', 'annullato'] as const
export type StatoRiga = (typeof STATI_RIGA)[number]

export const TRANSIZIONI: Record<StatoRiga, StatoRiga[]> = {
  da_ordinare: ['ordinato', 'arrivato', 'annullato'],
  ordinato: ['arrivato', 'da_ordinare', 'annullato'],
  arrivato: ['consegnato', 'annullato'],
  consegnato: [],
  annullato: [],
}

/** True se la transizione `da → a` è consentita dalla macchina a stati. */
export function puoTransire(da: StatoRiga, a: StatoRiga): boolean {
  if (da === a) return false
  return TRANSIZIONI[da]?.includes(a) ?? false
}

/**
 * True se un PO è completo: almeno una riga attiva e tutte le attive
 * (non annullate) sono arrivate o consegnate → il PO può essere chiuso.
 */
export function poCompleto(stati: StatoRiga[]): boolean {
  const attive = stati.filter((s) => s !== 'annullato')
  return attive.length > 0 && attive.every((s) => s === 'arrivato' || s === 'consegnato')
}

export type StatoTestata = 'inviato' | 'confermato' | 'consegnato' | 'annullato'

/**
 * Deriva lo stato della testata (vocabolario legacy) dagli stati delle righe:
 *  - nessuna riga attiva (tutte annullate/vuoto) → 'annullato';
 *  - tutte le attive consegnate → 'consegnato';
 *  - almeno una in lavorazione (ordinato/arrivato/consegnato) → 'confermato';
 *  - altrimenti (tutte da_ordinare) → 'inviato'.
 */
export function derivaStatoTestata(statiRiga: StatoRiga[]): StatoTestata {
  const attive = statiRiga.filter((s) => s !== 'annullato')
  if (attive.length === 0) return 'annullato'
  if (attive.every((s) => s === 'consegnato')) return 'consegnato'
  if (attive.some((s) => s === 'ordinato' || s === 'arrivato' || s === 'consegnato')) return 'confermato'
  return 'inviato'
}

const SCHEMA_MANCANTE = new Set(['42P01', '42703', 'PGRST200', 'PGRST204', 'PGRST205'])
const OPERAZIONE = 'merch/stati:sincronizzaTestata'

/**
 * Ricalcola e sincronizza lo stato della testata `divise_ordini.stato` dagli
 * stati correnti delle sue righe. Best-effort: se le colonne non esistono
 * (DB e2e CI non migrato) o l'ordine non ha righe, non fa nulla.
 * Ritorna lo stato derivato (o null se non applicabile).
 */
export async function sincronizzaTestata(
  supabase: SupabaseClient,
  ordineId: string,
): Promise<StatoTestata | null> {
  try {
    const { data, error } = await supabase
      .from('divise_ordini_righe')
      .select('stato')
      .eq('ordine_id', ordineId)
    if (error) {
      // Il DB E2E della CI non è migrato: è il caso previsto, e la riga è `info`.
      if (SCHEMA_MANCANTE.has(error.code ?? '')) {
        logEvento('db', 'info', { operazione: OPERAZIONE, esito: 'righe-schema-assente', entita_id: ordineId, ripiego: true }, error)
        return null
      }
      // Altrove è un guasto: la testata resta con lo stato di prima, e senza questa riga
      // nessuno saprebbe perché un ordine consegnato risulta ancora «confermato».
      guastoSecondario('db', OPERAZIONE, 'righe-non-lette', error)
      return null
    }
    const stati = (data ?? []).map((r) => String(r.stato) as StatoRiga)
    if (stati.length === 0) return null
    const derivato = derivaStatoTestata(stati)
    const { error: errTestata } = await supabase.from('divise_ordini').update({ stato: derivato }).eq('id', ordineId)
    // Passo accessorio dopo la scrittura vera (lo stato della riga): non si risponde 500 a
    // un'operazione riuscita, ma la testata NON è stata allineata e il chiamante non deve
    // crederlo — `null` = «non applicato».
    if (errTestata) {
      guastoSecondario('db', OPERAZIONE, 'testata-non-sincronizzata', errTestata)
      return null
    }
    return derivato
  } catch (err) {
    guastoSecondario('db', OPERAZIONE, 'sincronizzazione-fallita', err)
    return null
  }
}
