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
 *
 * Un guasto del database LANCIA (errore con `cause`: il `catch` della route lo registra col
 * codice Postgres e risponde 500). Il testo composto qui viene SCRITTO in
 * `valutazioni.giudizio_testo`, che il genitore legge: un `{ data: null, error }` letto come
 * «nessun frammento» salvava una valutazione col giudizio descrittivo vuoto, e nessuno lo sapeva.
 */
export async function renderGiudizioDescrittivo(
  supabase: SupabaseClient,
  scuolaId: string | null | undefined,
  dims: Dimensioni
): Promise<string> {
  const { data, error } = await supabase
    .from('giudizio_template')
    .select('scuola_id, dimensione, valore, frammento')
    .eq('attivo', true)
  if (error) throw new Error('Lettura dei frammenti del giudizio descrittivo non riuscita', { cause: error })
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
