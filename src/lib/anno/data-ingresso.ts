import type { SupabaseClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import { logEvento } from '@/lib/logging/logger'
import { annoAttivoDiSede } from '@/lib/anno/frequenze'
import { erroreAnno } from '@/lib/anno/errori'

/**
 * LA REGOLA DELLA DATA D'ISCRIZIONE (consegna 8 della PR 4.1, Ruling I3) — UN SOLO POSTO, per il POST e per il PATCH di
 * `admin/students`.
 *
 * La data di iscrizione scelta passa sulla frequenza dell'anno attivo della sede (`data_ingresso`). Fuori dal periodo di
 * quell'anno il database direbbe `ANNO_NON_COERENTE` (422): lo si dice PRIMA di scrivere, perché una scheda cambiata a
 * metà non si può "annullare" da qui.
 *  - DOPO la fine dell'anno attivo → 422 `ANNO_NON_COERENTE`, niente si scrive;
 *  - PRIMA del suo inizio → accettata: `alunni.data_iscrizione` resta quella scritta e la frequenza riceve
 *    `data_ingresso` = inizio dell'anno (come il riempimento: chi c'era già entra il primo giorno);
 *  - dentro l'anno → `data_ingresso` è la data scelta.
 * Schema indietro (il DB della CI) o sede senza anno attivo → `dataIngresso: null`, `annoSedeId: null`: si scrive solo
 * `alunni`. Un periodo che non si riesce a leggere non blocca la scrittura (warn col solo codice): la regola decide solo
 * il caso certo.
 */
export type EsitoDataIngresso =
  | { ok: true; dataIngresso: string | null; annoSedeId: string | null }
  | { ok: false; response: NextResponse }

export async function risolviDataIngresso(
  supabase: SupabaseClient,
  { scuolaId, dataIscrizione, operazione }: { scuolaId: string | null | undefined; dataIscrizione: unknown; operazione: string },
): Promise<EsitoDataIngresso> {
  let dataIngresso =
    typeof dataIscrizione === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dataIscrizione) ? dataIscrizione : null
  const annoSedeId = dataIngresso ? await annoAttivoDiSede(supabase, scuolaId) : null
  if (dataIngresso && annoSedeId) {
    const periodo = await supabase.from('anni_sede').select('inizio, fine').eq('id', annoSedeId).maybeSingle()
    if (periodo.error) {
      logEvento('anno-scolastico', 'warn', {
        tipo: 'periodo-anno-non-letto',
        error_code: (periodo.error as { code?: string }).code ?? null,
        operazione,
      })
    } else if (periodo.data) {
      const { inizio, fine } = periodo.data as { inizio: string; fine: string }
      if (dataIngresso < inizio) {
        dataIngresso = inizio
      } else if (dataIngresso > fine) {
        logEvento('anno-scolastico', 'warn', { tipo: 'data-ingresso-fuori-anno', error_code: 'ANNO_NON_COERENTE', operazione })
        return { ok: false, response: erroreAnno({ message: 'ANNO_NON_COERENTE' }, operazione) as NextResponse }
      }
    }
  }
  return { ok: true, dataIngresso, annoSedeId }
}
