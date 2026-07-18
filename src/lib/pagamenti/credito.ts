import type { SupabaseClient } from '@supabase/supabase-js'

// =============================================================================
// Credito famiglia (slice S3 — Contabilità v2).
//
// `crediti_famiglia` è un ledger ancorato a **parents.id** (registry anagrafico,
// NON utenti.id): ogni riga porta la variazione (`importo`) e il saldo cumulato
// (`saldo_dopo`). Vincoli DB: `importo <> 0`, `saldo_dopo >= 0`, causale in
// {eccedenza, utilizzo, rettifica, storno}.
//
// Degradazione (DB E2E CI non migrato): se la tabella/colonna non esiste, gli
// helper non lanciano — tornano un esito che lascia al chiamante rispondere 503
// SENZA aver scritto un incasso parziale. L'ordine è sempre: prima verifica
// disponibilità (lettura), poi scrivi.
// =============================================================================

/** Codici Postgres/PostgREST che indicano "schema non ancora migrato". */
const SCHEMA_MANCANTE = new Set(['42P01', 'PGRST205', '42703', 'PGRST204'])

const round2 = (n: number) => Math.round(n * 100) / 100

function codiceDi(error: unknown): string {
  return (error as { code?: string } | null)?.code ?? ''
}

export interface AccreditaInput {
  /** parents.id — già risolto dal chiamante (vedi resolveParentRegistry). */
  parentId: string
  scuolaId: string
  /** Importo dell'eccedenza da accreditare (> 0). */
  importo: number
  /** Incasso che ha generato l'eccedenza (per l'audit/collegamento). */
  incassoId?: string | null
  creatoDa?: string | null
}

export type AccreditaResult =
  | { ok: true; saldoDopo: number; id: string }
  | { ok: false; motivo: 'non_disponibile' }
  | { ok: false; motivo: 'errore'; error: unknown }

/**
 * Saldo credito corrente di un parent (parents.id) = `saldo_dopo` dell'ultima
 * riga del ledger. `0` se non ci sono righe o se lo schema non è disponibile
 * (degradazione: nessun credito noto, mai un'eccezione).
 */
export async function saldoCredito(
  supabase: SupabaseClient,
  parentId: string,
): Promise<number> {
  const { data, error } = await supabase
    .from('crediti_famiglia')
    .select('saldo_dopo')
    .eq('parent_id', parentId)
    .order('creato_il', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) return 0
  return Number((data as { saldo_dopo?: number | string } | null)?.saldo_dopo ?? 0)
}

/**
 * True se la feature credito famiglia è disponibile su questo DB (tabella
 * presente). Probe di sola lettura, senza effetti: il chiamante la usa per
 * decidere PRIMA di scrivere l'incasso, così un DB non migrato produce un 503
 * pulito e nessuna scrittura parziale.
 */
export async function creditoDisponibile(supabase: SupabaseClient): Promise<boolean> {
  const { error } = await supabase.from('crediti_famiglia').select('id').limit(1)
  if (error && SCHEMA_MANCANTE.has(codiceDi(error))) return false
  return true
}

/**
 * Accredita un'eccedenza in `crediti_famiglia`: legge il saldo corrente e
 * inserisce una riga causale 'eccedenza' con `saldo_dopo` aggiornato.
 *
 * Verifica la disponibilità (lettura) PRIMA di scrivere: tabella/colonna assente
 * → `{ ok:false, motivo:'non_disponibile' }` senza aver inserito nulla, così il
 * chiamante può rispondere 503 senza incasso parziale.
 */
export async function accreditaEccedenza(
  supabase: SupabaseClient,
  input: AccreditaInput,
): Promise<AccreditaResult> {
  const importo = round2(Number(input.importo))
  if (!(importo > 0)) {
    // importo <= 0 violerebbe il CHECK (importo <> 0) e non ha senso: non scrivere.
    return { ok: false, motivo: 'errore', error: new Error('importo eccedenza non positivo') }
  }

  // 1) verifica disponibilità + saldo corrente (una sola lettura).
  const cur = await supabase
    .from('crediti_famiglia')
    .select('saldo_dopo')
    .eq('parent_id', input.parentId)
    .order('creato_il', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (cur.error) {
    if (SCHEMA_MANCANTE.has(codiceDi(cur.error))) return { ok: false, motivo: 'non_disponibile' }
    return { ok: false, motivo: 'errore', error: cur.error }
  }
  const saldoAttuale = Number((cur.data as { saldo_dopo?: number | string } | null)?.saldo_dopo ?? 0)
  const saldoDopo = round2(saldoAttuale + importo)

  // 2) scrivi la riga di credito.
  const ins = await supabase
    .from('crediti_famiglia')
    .insert({
      parent_id: input.parentId,
      scuola_id: input.scuolaId,
      causale: 'eccedenza',
      importo,
      saldo_dopo: saldoDopo,
      incasso_id: input.incassoId ?? null,
      creato_da: input.creatoDa ?? null,
    })
    .select('id, saldo_dopo')
    .single()
  if (ins.error) {
    if (SCHEMA_MANCANTE.has(codiceDi(ins.error))) return { ok: false, motivo: 'non_disponibile' }
    return { ok: false, motivo: 'errore', error: ins.error }
  }

  return { ok: true, saldoDopo, id: (ins.data as { id: string }).id }
}
