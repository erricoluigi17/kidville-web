import type { SupabaseClient } from '@supabase/supabase-js'
import type { NextResponse } from 'next/server'
import { rispostaCrmNonRiuscita, rispostaErroreDb, rispostaErroreDbSchema } from '@/lib/crm/errori'
import type { AppuntamentoRow, BambinoRow, SchedaRow } from '@/lib/crm/tipi'
import { logEvento } from '@/lib/logging/logger'
import { erroreDbSoloCodice } from '@/lib/supabase/errore-tecnico'
import { meseDiNascita } from './eta'

type Appuntamento = Pick<AppuntamentoRow, 'id' | 'inizio' | 'fine' | 'stato'>
type AppuntamentoScheda = Appuntamento & Pick<AppuntamentoRow, 'scheda_id'>
type SchedaPerTelefono = Pick<SchedaRow, 'id' | 'creato_via'>
type BambinoScheda = Pick<BambinoRow, 'id' | 'scheda_id' | 'data_nascita' | 'creata_il'>
const LIMITE_RIGHE_POSTGREST = 1000

export interface VisitaAi {
  id: string
  inizio: string
  stato: Exclude<AppuntamentoRow['stato'], 'annullato'>
}

interface DettagliScheda {
  visita: VisitaAi | null
  bambini: { id: string; nascita: string | null }[]
}

/** La prima visita in programma che deve ancora finire, altrimenti l’ultima passata. */
export function visitaDi(appuntamenti: Appuntamento[], adesso: Date): VisitaAi | null {
  const ordinati = appuntamenti
    .filter((v): v is Appuntamento & { stato: VisitaAi['stato'] } => v.stato !== 'annullato')
    .sort((a, b) => Date.parse(a.inizio) - Date.parse(b.inizio) || a.id.localeCompare(b.id))
  const ora = adesso.getTime()
  const visita = ordinati.find((v) => v.stato === 'in_programma' && Date.parse(v.fine) > ora) ?? ordinati.at(-1)
  if (!visita) return null
  return { id: visita.id, inizio: visita.inizio, stato: visita.stato }
}

/** La scheda attiva più vecchia della sede con quel numero normalizzato. */
export async function schedaPerTelefono(
  supabase: SupabaseClient, scuolaId: string, telefonoNorm: string, operazione: string,
): Promise<{ scheda: SchedaPerTelefono | null } | { response: NextResponse }> {
  const { data, error } = await supabase.from('crm_schede')
    .select('id, creato_via, creata_il')
    .eq('scuola_id', scuolaId)
    .is('anonimizzata_il', null)
    .overlaps('telefoni_norm', [telefonoNorm])
    .order('creata_il', { ascending: true })
    .order('id', { ascending: true })
    .limit(1)
    .maybeSingle<SchedaPerTelefono>()
  if (error) return { response: rispostaErroreDbSchema(erroreDbSoloCodice(error), operazione) }
  return { scheda: data ? { id: data.id, creato_via: data.creato_via } : null }
}

/** Visite e bambini (solo ID e mese di nascita) delle schede della sede. */
export async function dettagliSchede(
  supabase: SupabaseClient, scuolaId: string, schedaIds: string[], adesso: Date, operazione: string,
): Promise<{ perScheda: Map<string, DettagliScheda> } | { response: NextResponse }> {
  const perScheda = new Map<string, DettagliScheda>()
  if (schedaIds.length === 0) return { perScheda }

  const [appuntamenti, bambini] = await Promise.all([
    supabase.from('crm_appuntamenti')
      .select('id, scheda_id, inizio, fine, stato')
      .eq('scuola_id', scuolaId)
      .in('scheda_id', schedaIds)
      .neq('stato', 'annullato')
      .overrideTypes<AppuntamentoScheda[], { merge: false }>(),
    supabase.from('crm_bambini')
      .select('id, scheda_id, data_nascita, creata_il')
      .eq('scuola_id', scuolaId)
      .in('scheda_id', schedaIds)
      .order('creata_il', { ascending: true })
      .order('id', { ascending: true })
      .overrideTypes<BambinoScheda[], { merge: false }>(),
  ])
  const errore = appuntamenti.error ?? bambini.error
  if (errore) return { response: rispostaErroreDb(erroreDbSoloCodice(errore), operazione) }

  // Al tetto di PostgREST le righe possono essere state tagliate senza errore.
  if (Math.max(appuntamenti.data?.length ?? 0, bambini.data?.length ?? 0) >= LIMITE_RIGHE_POSTGREST) {
    logEvento('crm', 'error', {
      operazione, esito: 'max-rows-raggiunto', scuola_id: scuolaId, limite: LIMITE_RIGHE_POSTGREST,
    })
    return { response: rispostaCrmNonRiuscita() }
  }

  const visitePerScheda = new Map<string, Appuntamento[]>()
  for (const visita of appuntamenti.data ?? []) {
    const visite = visitePerScheda.get(visita.scheda_id)
    if (visite) visite.push(visita)
    else visitePerScheda.set(visita.scheda_id, [visita])
  }

  for (const id of schedaIds) {
    perScheda.set(id, { visita: visitaDi(visitePerScheda.get(id) ?? [], adesso), bambini: [] })
  }
  for (const bambino of bambini.data ?? []) {
    perScheda.get(bambino.scheda_id)?.bambini.push({ id: bambino.id, nascita: meseDiNascita(bambino.data_nascita) })
  }
  return { perScheda }
}
