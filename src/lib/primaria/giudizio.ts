import type { SupabaseClient } from '@supabase/supabase-js'

export interface Dimensioni {
  autonomia: boolean
  continuita: boolean
  tipologia: 'nota' | 'non_nota'
  risorse: 'interne' | 'esterne' | 'entrambe'
}

interface Frammento {
  scuola_id: string | null
  dimensione: string
  valore: string
  frammento: string
}

/**
 * Compone il giudizio descrittivo auto-generato dalle 4 dimensioni, usando i
 * frammenti configurabili (giudizio_template). Preferisce i frammenti specifici
 * della scuola; in mancanza usa i default globali (scuola_id IS NULL).
 * Il testo resta modificabile dal docente lato client.
 */
export async function renderGiudizioDescrittivo(
  supabase: SupabaseClient,
  scuolaId: string | null | undefined,
  dims: Dimensioni
): Promise<string> {
  const { data } = await supabase
    .from('giudizio_template')
    .select('scuola_id, dimensione, valore, frammento')
    .eq('attivo', true)
  const frammenti = (data ?? []) as Frammento[]

  const pick = (dimensione: string, valore: string): string => {
    const specifico = frammenti.find((f) => f.scuola_id === scuolaId && f.dimensione === dimensione && f.valore === valore)
    if (specifico) return specifico.frammento
    const globale = frammenti.find((f) => f.scuola_id === null && f.dimensione === dimensione && f.valore === valore)
    return globale?.frammento ?? ''
  }

  const parts = [
    pick('autonomia', String(dims.autonomia)),
    pick('continuita', String(dims.continuita)),
    pick('tipologia', dims.tipologia),
    pick('risorse', dims.risorse),
  ].filter(Boolean)

  if (parts.length === 0) return ''
  return `L'alunno ${parts.join(', ')}.`
}
