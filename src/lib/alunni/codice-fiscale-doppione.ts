import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Un ALTRO alunno ha già questo codice fiscale? Il controllo è GLOBALE di proposito: `alunni_codice_fiscale_key` è UNIQUE su
 * tutta la tabella, non per sede, quindi un filtro di sede qui direbbe «libero» per un codice che il database rifiuterebbe.
 * Sta in `lib` e non dentro la route perché il lock di isolamento fra sedi guarda le query delle route, e questa è l'unica
 * che deve vedere oltre la sede — e solo per rispondere sì o no: non restituisce mai né la riga né il suo id.
 *
 * Il confronto è quello del vincolo (il valore com'è). PostgREST non lancia: l'errore si legge dal valore di ritorno, e un
 * guasto NON è un «libero».
 */
export async function codiceFiscaleDiAltroAlunno(
  supabase: SupabaseClient,
  codiceFiscale: string,
  escludiAlunnoId: string,
): Promise<{ ok: true; usato: boolean } | { ok: false; error: unknown }> {
  const { data, error } = await supabase
    .from('alunni')
    .select('id')
    .eq('codice_fiscale', codiceFiscale)
    .neq('id', escludiAlunnoId)
    .limit(1)
  if (error) return { ok: false, error }
  return { ok: true, usato: (data ?? []).length > 0 }
}
