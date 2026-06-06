import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveMenuGiorno, type ResolveOptions, type RotazioneRow, type OverrideRow } from './resolveMenu'

export const DEFAULT_SCUOLA = '11111111-1111-1111-1111-111111111111'

export interface MensaConfig {
  cutoffOra: string            // 'HH:MM' o 'HH:MM:SS'
  giorniAttivi: number[]       // 1=lun … 7=dom
  settimaneRotazione: number
  sogliaSaldoBasso: number
}

const DEFAULT_CONFIG: MensaConfig = {
  cutoffOra: '09:30',
  giorniAttivi: [1, 2, 3, 4, 5],
  settimaneRotazione: 4,
  sogliaSaldoBasso: 5,
}

// Carica le impostazioni mensa dalla riga admin_settings della scuola.
export async function loadMensaConfig(supabase: SupabaseClient, scuolaId: string): Promise<MensaConfig> {
  const { data } = await supabase
    .from('admin_settings')
    .select('mensa_cutoff_ora, mensa_giorni_attivi, mensa_settimane_rotazione, mensa_soglia_saldo_basso')
    .eq('scuola_id', scuolaId)
    .maybeSingle()
  if (!data) return DEFAULT_CONFIG
  return {
    cutoffOra: (data.mensa_cutoff_ora as string) ?? DEFAULT_CONFIG.cutoffOra,
    giorniAttivi: (data.mensa_giorni_attivi as number[]) ?? DEFAULT_CONFIG.giorniAttivi,
    settimaneRotazione: (data.mensa_settimane_rotazione as number) ?? DEFAULT_CONFIG.settimaneRotazione,
    sogliaSaldoBasso: (data.mensa_soglia_saldo_basso as number) ?? DEFAULT_CONFIG.sogliaSaldoBasso,
  }
}

// Carica le opzioni complete per risolvere il menu (rotazione + override).
export async function loadResolveOptions(
  supabase: SupabaseClient,
  scuolaId: string,
  config?: MensaConfig
): Promise<ResolveOptions> {
  const cfg = config ?? (await loadMensaConfig(supabase, scuolaId))
  const [{ data: rot }, { data: ovr }] = await Promise.all([
    supabase.from('mensa_menu_rotazione').select('settimana, giorno_settimana, portate, ingredienti, allergeni, note').eq('scuola_id', scuolaId),
    supabase.from('mensa_menu_override').select('data, chiuso, portate, ingredienti, allergeni, note').eq('scuola_id', scuolaId),
  ])
  return {
    giorniAttivi: cfg.giorniAttivi,
    settimaneRotazione: cfg.settimaneRotazione,
    rotazione: (rot ?? []) as RotazioneRow[],
    override: (ovr ?? []) as OverrideRow[],
  }
}

// Data odierna del server in formato YYYY-MM-DD.
export function oggi(): string {
  return new Date().toISOString().slice(0, 10)
}

// Verifica se una data è prenotabile/disdicibile rispetto al cutoff.
//   - date passate: bloccate
//   - data odierna: bloccata se l'ora corrente supera il cutoff
//   - date future: sempre consentite
export function entroCutoff(dateStr: string, cutoffOra: string): boolean {
  const today = oggi()
  if (dateStr < today) return false
  if (dateStr > today) return true
  const [h, m] = cutoffOra.split(':').map(Number)
  const now = new Date()
  const cutoff = new Date()
  cutoff.setHours(h || 0, m || 0, 0, 0)
  return now.getTime() <= cutoff.getTime()
}

// Comodo: il menu di una data è "prenotabile" (giorno attivo e non chiuso)?
export async function giornoPrenotabile(
  supabase: SupabaseClient,
  scuolaId: string,
  dateStr: string,
  opts?: ResolveOptions
): Promise<{ attivo: boolean; chiuso: boolean }> {
  const options = opts ?? (await loadResolveOptions(supabase, scuolaId))
  const m = resolveMenuGiorno(dateStr, options)
  return { attivo: m.attivo, chiuso: m.chiuso }
}
