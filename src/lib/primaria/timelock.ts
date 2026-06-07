import type { SupabaseClient } from '@supabase/supabase-js'

export type LockTipo = 'classe_orale' | 'scritto_pratico'

// Scadenze di default (giorni) se admin_settings non è configurato.
const DEFAULT_CLASSE_ORALE = 2
const DEFAULT_SCRITTO_PRATICO = 15

interface Deadlines {
  classeOrale: number
  scrittoPratico: number
}

export async function getDeadlines(
  supabase: SupabaseClient,
  scuolaId: string | null | undefined
): Promise<Deadlines> {
  if (!scuolaId) return { classeOrale: DEFAULT_CLASSE_ORALE, scrittoPratico: DEFAULT_SCRITTO_PRATICO }
  const { data } = await supabase
    .from('admin_settings')
    .select('timelock_giorni_classe_orale, timelock_giorni_scritto_pratico')
    .eq('scuola_id', scuolaId)
    .maybeSingle()
  return {
    classeOrale: data?.timelock_giorni_classe_orale ?? DEFAULT_CLASSE_ORALE,
    scrittoPratico: data?.timelock_giorni_scritto_pratico ?? DEFAULT_SCRITTO_PRATICO,
  }
}

/**
 * Calcola se una registrazione è bloccata per superamento del termine.
 * `eventDate` è la data dell'evento (lezione/prova) in ISO (YYYY-MM-DD).
 * Il blocco effettivo è scavalcabile solo dal dirigente (vedi /api/primaria/sblocca).
 */
export async function isOltreScadenza(
  supabase: SupabaseClient,
  scuolaId: string | null | undefined,
  eventDate: string,
  lockTipo: LockTipo
): Promise<{ locked: boolean; giorniLimite: number; giorniTrascorsi: number }> {
  const deadlines = await getDeadlines(supabase, scuolaId)
  const limite = lockTipo === 'scritto_pratico' ? deadlines.scrittoPratico : deadlines.classeOrale
  const ev = new Date(eventDate + 'T00:00:00')
  const oggi = new Date()
  const giorniTrascorsi = Math.floor((oggi.getTime() - ev.getTime()) / 86_400_000)
  return { locked: giorniTrascorsi > limite, giorniLimite: limite, giorniTrascorsi }
}
