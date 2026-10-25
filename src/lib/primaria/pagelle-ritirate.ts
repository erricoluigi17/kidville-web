import type { SupabaseClient } from '@supabase/supabase-js'
import { logEvento } from '@/lib/logging/logger'
import { colonnaNuovaAssente } from '@/lib/db/colonna-assente'

/**
 * LE PAGELLE RITIRATE DA UNA RIAPERTURA DELLO SCRUTINIO.
 *
 * Una riapertura non cancella più le pagelle consegnate: le COPIA in
 * `ritirate/<scrutinio>/<alunno>-<istante>.pdf` dello stesso bucket e marca la riga
 * (`ritirata_il`, `file_ritirati`). La riga resta una per alunno (vincolo di unicità su
 * scrutinio e alunno): «in vigore» vuol dire `ritirata_il IS NULL`, e chi chiede le
 * pagelle in vigore lo deve dire.
 *
 * Senza le colonne (DB della CI, 42703) si legge come prima, senza filtro, e lo si dice:
 * lì la riapertura cancella ancora le righe, quindi «tutte» e «in vigore» coincidono.
 */

export const PREFISSO_RITIRATE = 'ritirate'

/** `ritirate/<scrutinio>/<alunno>-<AAAAMMGGhhmmssmmm>.pdf`: l'istante della riapertura, mai due uguali. */
export function percorsoPagellaRitirata(scrutinioId: string, alunnoId: string, adesso: Date): string {
  const istante = adesso.toISOString().replace(/\D/g, '').slice(0, 17)
  return `${PREFISSO_RITIRATE}/${scrutinioId}/${alunnoId}-${istante}.pdf`
}

const OP_IN_VIGORE = 'primaria/pagelle-ritirate:pagelleInVigore'

/** Gli alunni con una pagella archiviata IN VIGORE in questo scrutinio. Contratto `{ data, error }`. */
export async function pagelleInVigore(
  supabase: SupabaseClient,
  scrutinioId: string,
): Promise<{ data: { alunno_id: string }[] | null; error: unknown }> {
  const vigenti = await supabase
    .from('pagelle')
    .select('alunno_id')
    .eq('scrutinio_id', scrutinioId)
    .is('ritirata_il', null)
  if (!vigenti.error || !colonnaNuovaAssente(vigenti.error)) {
    return { data: (vigenti.data as { alunno_id: string }[] | null) ?? null, error: vigenti.error }
  }
  logEvento('db', 'info', { operazione: OP_IN_VIGORE, esito: 'colonna-ritiro-assente', scrutinio_id: scrutinioId })
  const tutte = await supabase.from('pagelle').select('alunno_id').eq('scrutinio_id', scrutinioId)
  return { data: (tutte.data as { alunno_id: string }[] | null) ?? null, error: tutte.error }
}
