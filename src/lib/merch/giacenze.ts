import type { SupabaseClient } from '@supabase/supabase-js'

// =============================================================================
// Giacenza AUTOMATICA del magazzino Merchandise (nessuna vista DB, 2 query).
//
//   disponibile(articolo, taglia) = Σ merch_rettifiche.quantita_delta
//                                 − Σ righe.quantita  (origine='magazzino',
//                                                      stato ∈ arrivato/consegnato)
//
// Il flusso fornitore si auto-bilancia (non tocca la disponibilità); evadere da
// magazzino impegna subito lo stock; l'annullo di una riga magazzino lo rilascia
// da solo (la riga non è più arrivato/consegnato). Le colonne "in arrivo" (righe
// ordinato dal fornitore) e "da consegnare" (righe arrivato) sono informative.
// =============================================================================

export interface GiacenzaCell {
  articolo_id: string | null
  nome: string
  taglia: string
  caricato: number
  impegnato: number
  disponibile: number
  inArrivo: number
  daConsegnare: number
}

export interface RettificaMov {
  articolo_id: string | null
  articolo_nome?: string | null
  taglia: string
  quantita_delta: number
}
export interface RigaMov {
  articolo_id: string | null
  articolo_nome?: string | null
  taglia: string
  quantita: number
  stato: string
  origine: string
}

const chiave = (aid: string | null, t: string) => `${aid ?? ''}|${t ?? ''}`

/** Calcolo puro della matrice giacenze da rettifiche + righe di movimento. */
export function calcolaGiacenze(rettifiche: RettificaMov[], righe: RigaMov[]): GiacenzaCell[] {
  const map = new Map<string, GiacenzaCell>()
  const ensure = (aid: string | null, taglia: string, nome?: string | null): GiacenzaCell => {
    const k = chiave(aid, taglia)
    let c = map.get(k)
    if (!c) {
      c = { articolo_id: aid, nome: nome || '', taglia, caricato: 0, impegnato: 0, disponibile: 0, inArrivo: 0, daConsegnare: 0 }
      map.set(k, c)
    } else if (!c.nome && nome) {
      c.nome = nome
    }
    return c
  }

  for (const r of rettifiche) {
    ensure(r.articolo_id, r.taglia ?? '', r.articolo_nome).caricato += Number(r.quantita_delta) || 0
  }
  for (const r of righe) {
    const c = ensure(r.articolo_id, r.taglia ?? '', r.articolo_nome)
    const q = Number(r.quantita) || 0
    if (r.origine === 'magazzino' && (r.stato === 'arrivato' || r.stato === 'consegnato')) c.impegnato += q
    if (r.origine === 'fornitore' && r.stato === 'ordinato') c.inArrivo += q
    if (r.stato === 'arrivato') c.daConsegnare += q
  }
  for (const c of map.values()) c.disponibile = c.caricato - c.impegnato
  return [...map.values()].sort((a, b) => a.nome.localeCompare(b.nome) || a.taglia.localeCompare(b.taglia))
}

/** Disponibile per un singolo articolo/taglia (0 se assente). */
export function disponibileDi(cells: GiacenzaCell[], articoloId: string | null, taglia: string): number {
  const k = chiave(articoloId, taglia ?? '')
  const c = cells.find((x) => chiave(x.articolo_id, x.taglia) === k)
  return c ? c.disponibile : 0
}

const SCHEMA_MANCANTE = new Set(['42P01', '42703', 'PGRST204', 'PGRST205'])
const uno = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null))

/**
 * Carica la matrice giacenze dei plessi indicati (2 query aggregate). Degrada a
 * matrice vuota dove il DB non è migrato (merch_rettifiche assente / colonne
 * origine/stato assenti sulle righe).
 */
export async function caricaGiacenze(supabase: SupabaseClient, plessi: string[]): Promise<GiacenzaCell[]> {
  if (plessi.length === 0) return []

  const rett = await supabase
    .from('merch_rettifiche')
    .select('articolo_id, articolo_nome, taglia, quantita_delta')
    .in('scuola_id', plessi)
  const rettifiche: RettificaMov[] =
    rett.error ? (SCHEMA_MANCANTE.has(rett.error.code ?? '') ? [] : []) : ((rett.data as unknown as RettificaMov[]) ?? [])

  const rows = await supabase
    .from('divise_ordini_righe')
    .select('articolo_id, articolo_nome, taglia, quantita, stato, origine, ordine:ordine_id ( scuola_id )')
    .in('stato', ['ordinato', 'arrivato', 'consegnato'])
    .limit(5000)
  type R = RigaMov & { ordine: { scuola_id?: string | null } | { scuola_id?: string | null }[] | null }
  const righe: RigaMov[] = rows.error
    ? []
    : ((rows.data as unknown as R[]) ?? []).filter((r) => {
        const sc = uno(r.ordine)?.scuola_id
        return sc != null && plessi.includes(sc)
      })

  return calcolaGiacenze(rettifiche, righe)
}
