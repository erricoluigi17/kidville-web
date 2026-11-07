import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { logEvento } from '@/lib/logging/logger'
import { schemaAnnoIndietro } from '@/lib/anno/schema'
import type { EsitoAnno, StatoAnno } from '@/lib/anno/tipi'

/**
 * La lettura degli anni di una sede e le due uscite «non ho potuto leggere», condivise da
 * `src/lib/auth/scope.ts` (che ha l'utente) e `src/lib/anno/pubblico.ts` (che non ce l'ha).
 * Sta qui, senza import di `scope.ts`, per non creare un import circolare.
 */
export type RigaAnnoSede = { id: string; anno_id: string; stato: StatoAnno; domande_aperte?: boolean | null }

export type AnniDellaSede = { righe: RigaAnnoSede[] } | { indietro: true } | { guasto: unknown }

export async function anniDellaSede(supabase: SupabaseClient, scuolaId: string): Promise<AnniDellaSede> {
  const { data, error } = await supabase
    .from('anni_sede')
    .select('id, anno_id, stato, domande_aperte')
    .eq('scuola_id', scuolaId)
  if (error) return schemaAnnoIndietro(error) ? { indietro: true } : { guasto: error }
  return { righe: (Array.isArray(data) ? data : []) as RigaAnnoSede[] }
}

export function esitoSchemaIndietro(azione: string): EsitoAnno {
  logEvento('anno-scolastico', 'info', { tipo: 'schema-anno-indietro', azione })
  return { annoSedeId: null, annoId: null, stato: null, schemaIndietro: true }
}

export function guastoAnno(azione: string, err: unknown): NextResponse {
  logEvento('anno-scolastico', 'error', { tipo: 'anno-lettura-fallita', azione }, err)
  return NextResponse.json({ error: 'Verifica di scope non riuscita', codice: 'LETTURA_FALLITA' }, { status: 500 })
}
