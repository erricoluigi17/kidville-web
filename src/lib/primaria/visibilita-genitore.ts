import type { SupabaseClient } from '@supabase/supabase-js'
import { logEvento } from '@/lib/logging/logger'

/**
 * QUANDO IL GENITORE VEDE UNA VOCE SCRITTA DAL DOCENTE (PRD §4.5).
 *
 * Una valutazione — e dal 2026-09-25 anche un impreparato segnato dal docente —
 * è visibile alla famiglia solo trascorso il buffer di sede
 * `admin_settings.notif_buffer_valutazioni_min` (predefinito 10') dalla
 * creazione: è la finestra in cui il docente può correggere o togliere una voce
 * sbagliata prima che la famiglia la veda. È la STESSA finestra della notifica
 * al genitore, che parte con lo stesso `bufferMin`: vedere la voce prima della
 * notifica, o la notifica prima della voce, sarebbe incoerente.
 *
 * Una regola sola in un posto solo: valutazioni e impreparati passano di qui.
 */

export const BUFFER_VALUTAZIONI_PREDEFINITO_MIN = 10

/**
 * Il buffer della sede, in minuti. Un guasto di lettura NON nasconde niente e
 * non rompe la pagina: si usa il predefinito, e il guasto si dichiara.
 */
export async function leggiBufferVisibilita(
  supabase: SupabaseClient,
  scuolaId: string | null,
  operazione: string,
): Promise<number> {
  if (!scuolaId) return BUFFER_VALUTAZIONI_PREDEFINITO_MIN
  const { data, error } = await supabase
    .from('admin_settings')
    .select('notif_buffer_valutazioni_min')
    .eq('scuola_id', scuolaId)
    .maybeSingle()
  if (error) {
    logEvento('db', 'warn', { operazione, esito: 'buffer-valutazioni-non-letto' }, error)
    return BUFFER_VALUTAZIONI_PREDEFINITO_MIN
  }
  const v = (data as { notif_buffer_valutazioni_min?: number | null } | null)?.notif_buffer_valutazioni_min
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : BUFFER_VALUTAZIONI_PREDEFINITO_MIN
}

/** L'istante (ISO) prima del quale una voce del docente è già visibile al genitore. */
export function sogliaVisibilita(bufferMin: number, adesso: Date = new Date()): string {
  return new Date(adesso.getTime() - bufferMin * 60_000).toISOString()
}

/** Una voce del DOCENTE creata a `creatoIl` è visibile al genitore con questa soglia? */
export function visibileAlGenitore(creatoIl: string | null | undefined, soglia: string): boolean {
  if (!creatoIl) return false
  const t = new Date(creatoIl).getTime()
  return Number.isFinite(t) && t <= new Date(soglia).getTime()
}

/**
 * Un impreparato come lo riceve il genitore da `GET /api/parent/primaria/valutazioni`
 * (campo `impreparati`). Mai `creato_da`: chi l'ha scritto non è un dato per la famiglia,
 * basta `origine` e, per le sue, `modificabile_dal_genitore`.
 */
export interface ImpreparatoGenitore {
  id: string
  tipo: 'impreparato' | 'giustificato'
  motivo: string | null
  materiaId: string | null
  materiaNome: string | null
  data: string
  origine: 'genitore' | 'docente'
  creato_il: string | null
  /** La SUA dichiarazione, e il giorno dichiarato non è passato (data di Roma). */
  modificabile_dal_genitore: boolean
}
