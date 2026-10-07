import type { SupabaseClient } from '@supabase/supabase-js'
import { genitoriDiClassi, genitoriDiScuola } from '@/lib/notifiche/destinatari'
import { RIGHE_PER_PAGINA, MAX_PAGINE } from '@/lib/avvisi/statistiche'

// =============================================================================
// La notifica di un avviso, in un posto solo: la usano la creazione (POST) e la
// modifica che allarga i destinatari (PUT, 2026-10-07).
//
// Prima la logica stava inline nel POST e il PUT non notificava mai: aggiungere
// una classe a un avviso lasciava quelle famiglie senza avviso.
// =============================================================================

/** Priorità: modulo firmabile > richiesta di adesione > avviso. */
export function tipoNotificaAvviso(
  formModelId: string | null | undefined,
  tipo: string | null | undefined,
): 'modulo_da_compilare' | 'consenso_uscita' | 'avviso' {
  if (formModelId) return 'modulo_da_compilare'
  return tipo === 'adesione' ? 'consenso_uscita' : 'avviso'
}

export function titoloNotificaAvviso(tipoNotifica: string, titolo: string): string {
  if (tipoNotifica === 'modulo_da_compilare') return `Modulo da compilare: ${titolo}`
  if (tipoNotifica === 'consenso_uscita') return `Richiesta di consenso: ${titolo}`
  return `Nuovo avviso: ${titolo}`
}

/** I genitori destinatari dello stato dato: tutta la sede, oppure le classi. */
export async function destinatariAvviso(
  supabase: SupabaseClient,
  scuolaId: string,
  scope: string | null | undefined,
  classi: string[],
): Promise<string[]> {
  return (scope ?? 'globale') === 'globale'
    ? await genitoriDiScuola(supabase, scuolaId)
    : await genitoriDiClassi(supabase, scuolaId, classi)
}

/**
 * Chi ha GIÀ la notifica iniziale di questo avviso (non quelle di risposta o di
 * promemoria). Lancia se la lettura fallisce: chi chiama NON deve mandare niente
 * a un insieme che non sa calcolare — meglio nessuna notifica che una doppia a
 * tutta la sede. Paginata: PostgREST taglia a 1000 righe.
 */
export async function giaAvvisati(
  supabase: SupabaseClient,
  avvisoId: string,
  tipoNotifica: string,
): Promise<Set<string>> {
  const out = new Set<string>()
  let letto = 0
  for (let pagina = 0; pagina < MAX_PAGINE; pagina++) {
    const { data, count, error } = await supabase
      .from('notifiche')
      .select('utente_id', { count: 'exact' })
      .eq('entita_tipo', 'avviso')
      .eq('entita_id', avvisoId)
      .eq('tipo', tipoNotifica)
      .range(letto, letto + RIGHE_PER_PAGINA - 1)
    if (error) throw error
    const pezzo = (data ?? []) as Array<{ utente_id?: unknown }>
    for (const r of pezzo) if (typeof r.utente_id === 'string') out.add(r.utente_id)
    letto += pezzo.length
    if (letto >= (count ?? letto)) return out
    if (pezzo.length === 0) throw new Error('notifiche: lettura incompleta (pagina vuota)')
  }
  throw new Error('notifiche: lettura troncata al tetto di pagine')
}
