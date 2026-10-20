import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveMenuGiorno, type ResolveOptions, type RotazioneRow, type OverrideRow } from './resolveMenu'
import { oggiRoma, entroCutoff as entroCutoffRoma } from './cutoff'
import { colonnaNuovaAssente } from '@/lib/db/colonna-assente'
import { tabellaMancante } from '@/lib/db/tolleranza-schema'
import { guastoLetturaAccessoria } from '@/lib/db/guasto'

/**
 * UN GUASTO NON È «NESSUNA IMPOSTAZIONE» (fase 11, «errori non ignorati»).
 *
 * Queste letture DECIDONO: il cutoff dice se una prenotazione si accetta, la rotazione e gli
 * override dicono quale menu c'è — e quindi quali allergeni — e l'assegnazione dice quale menu
 * vale per la classe. Prima un `{ data: null, error }` diventava il default (cutoff 09:30), un
 * menu vuoto (zero conflitti, zero alert allergie, e il cron chiudeva «ok»), o il menu legacy
 * al posto di quello della classe. Ora un guasto LANCIA (errore con `cause`: il `catch` della
 * route, o `withRoute`, lo registra col codice Postgres e risponde 500).
 *
 * Unica eccezione, ed è quella di prima: uno schema che non ha ancora la colonna o la tabella
 * (il DB E2E della CI non è migrato) degrada al ripiego di sempre, con una riga `info` che lo dice.
 */
function schemaIndietro(error: { code?: string } | null): boolean {
  return colonnaNuovaAssente(error) || tabellaMancante(error)
}

function lettura<T>(operazione: string, esito: string, error: { code?: string } | null, ripiego: T): T {
  if (schemaIndietro(error)) {
    guastoLetturaAccessoria('mensa', operazione, esito, error)
    return ripiego
  }
  throw new Error(`Lettura mensa non riuscita (${esito})`, { cause: error })
}

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
  const { data, error } = await supabase
    .from('admin_settings')
    .select('mensa_cutoff_ora, mensa_giorni_attivi, mensa_settimane_rotazione, mensa_soglia_saldo_basso')
    .eq('scuola_id', scuolaId)
    .maybeSingle()
  if (error) return lettura('mensa/server:loadMensaConfig', 'impostazioni-non-lette', error, DEFAULT_CONFIG)
  if (!data) return DEFAULT_CONFIG
  return {
    cutoffOra: (data.mensa_cutoff_ora as string) ?? DEFAULT_CONFIG.cutoffOra,
    giorniAttivi: (data.mensa_giorni_attivi as number[]) ?? DEFAULT_CONFIG.giorniAttivi,
    settimaneRotazione: (data.mensa_settimane_rotazione as number) ?? DEFAULT_CONFIG.settimaneRotazione,
    sogliaSaldoBasso: (data.mensa_soglia_saldo_basso as number) ?? DEFAULT_CONFIG.sogliaSaldoBasso,
  }
}

// Carica le opzioni complete per risolvere il menu (rotazione + override).
// Se menuConfigId è passato, filtra solo le righe di quel menu; altrimenti
// torna le righe senza menu_config_id (legacy, menu unico).
export async function loadResolveOptions(
  supabase: SupabaseClient,
  scuolaId: string,
  config?: MensaConfig,
  menuConfigId?: string | null
): Promise<ResolveOptions> {
  const cfg = config ?? (await loadMensaConfig(supabase, scuolaId))

  let rotQ = supabase
    .from('mensa_menu_rotazione')
    .select('settimana, giorno_settimana, portate, ingredienti, allergeni, note, menu_config_id')
    .eq('scuola_id', scuolaId)
  let ovrQ = supabase
    .from('mensa_menu_override')
    .select('data, chiuso, portate, ingredienti, allergeni, note, menu_config_id')
    .eq('scuola_id', scuolaId)

  if (menuConfigId) {
    rotQ = rotQ.eq('menu_config_id', menuConfigId)
    ovrQ = ovrQ.eq('menu_config_id', menuConfigId)
  } else {
    rotQ = rotQ.is('menu_config_id', null)
    ovrQ = ovrQ.is('menu_config_id', null)
  }

  const [{ data: rot, error: errRot }, { data: ovr, error: errOvr }] = await Promise.all([rotQ, ovrQ])
  const rotazione = errRot
    ? lettura('mensa/server:loadResolveOptions', 'rotazione-non-letta', errRot, [] as RotazioneRow[])
    : ((rot ?? []) as RotazioneRow[])
  const override = errOvr
    ? lettura('mensa/server:loadResolveOptions', 'override-non-letti', errOvr, [] as OverrideRow[])
    : ((ovr ?? []) as OverrideRow[])
  return {
    giorniAttivi: cfg.giorniAttivi,
    settimaneRotazione: cfg.settimaneRotazione,
    rotazione,
    override,
  }
}

// Dato un alunno (con classe_sezione) e una data, restituisce il menu_config_id
// attivo per quella classe in quella data.
// Regola: tra tutte le righe mensa_class_menu_assignment per quella classe,
// prende quella con attivo_dal <= data più recente.
export async function resolveMenuConfigId(
  supabase: SupabaseClient,
  scuolaId: string,
  classeSezione: string | null | undefined,
  data: string
): Promise<string | null> {
  if (!classeSezione) return null
  const { data: row, error } = await supabase
    .from('mensa_class_menu_assignment')
    .select('menu_config_id')
    .eq('scuola_id', scuolaId)
    .eq('classe', classeSezione)
    .lte('attivo_dal', data)
    .order('attivo_dal', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) return lettura<string | null>('mensa/server:resolveMenuConfigId', 'assegnazione-menu-non-letta', error, null)
  return (row?.menu_config_id as string | null) ?? null
}

// Data odierna in formato YYYY-MM-DD, nel calendario di ROMA (non di UTC: fra
// mezzanotte e le 2 italiane il server su Vercel è ancora nel giorno prima).
export function oggi(adesso?: Date): string {
  return oggiRoma(adesso)
}

// Verifica se una data è prenotabile/disdicibile rispetto al cutoff, in ora
// italiana. La logica sta in `./cutoff` (pura, condivisa con l'interfaccia):
//   - date passate: bloccate
//   - data odierna: bloccata se l'ora italiana supera il cutoff
//   - date future: sempre consentite
export function entroCutoff(dateStr: string, cutoffOra: string, adesso?: Date): boolean {
  return entroCutoffRoma(dateStr, cutoffOra, adesso)
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
