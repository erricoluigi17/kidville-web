import type { SupabaseClient } from '@supabase/supabase-js'
import { logEvento } from '@/lib/logging/logger'
import { oggiRoma } from '@/lib/storici/retroattivita'
import { COLONNE_PERIODO, periodoPerData, type PeriodoScrutinio } from '@/lib/primaria/periodo'

/**
 * IL QUADRIMESTRE DI UNA DATA LETTO DAL DATABASE, E SE IL SUO SCRUTINIO È CHIUSO.
 *
 * La regola «quale periodo copre quel giorno» sta in `periodo.ts` (pura, importabile dal
 * browser); qui ci sono le letture e il log, che dal browser non devono arrivare.
 *
 * FAIL-CLOSED SUI GUASTI, FAIL-OPEN SULLA CONFIGURAZIONE MANCANTE (D4). Una lettura che
 * fallisce dà `{ ok: false }`: chi chiama risponde 500 e non scrive niente, perché «non so
 * se è chiuso» non si traduce né in «aperto» né in «chiuso». Periodi assenti o senza date
 * invece non sono un guasto: il voto entra, senza periodo, e il caso si segnala al log.
 *
 * La chiusura è per CLASSE (`scrutini.section_id`) e per PERIODO: lo scrutinio chiuso
 * della 2A non congela i voti della 2B, e quello del primo quadrimestre non congela il
 * secondo. Se due periodi si sovrappongono e uno dei due è chiuso, la data è chiusa (D14):
 * basta UNO dei coprenti, non solo quello che vince lo spareggio.
 */

export interface QuadrimestriLetti {
  /** I periodi di ogni sede (anche quelli senza date, che servono a segnalare la configurazione mancante). */
  periodi: Map<string, PeriodoScrutinio[]>
  /** Gli scrutini chiusi, con chiave `${sectionId}:${periodoId}`. */
  chiusi: Set<string>
}

export async function leggiPeriodi(
  supabase: SupabaseClient,
  scuolaIds: readonly string[],
): Promise<{ ok: true; periodi: PeriodoScrutinio[] } | { ok: false; error: unknown }> {
  if (scuolaIds.length === 0) return { ok: true, periodi: [] }
  const { data, error } = await supabase
    .from('scrutinio_periodi')
    .select(COLONNE_PERIODO)
    .in('scuola_id', [...scuolaIds])
  if (error) return { ok: false, error }
  return { ok: true, periodi: (data ?? []) as unknown as PeriodoScrutinio[] }
}

export async function leggiQuadrimestri(
  supabase: SupabaseClient,
  input: { scuolaIds: readonly string[]; sectionIds: readonly string[] },
): Promise<{ ok: true; letti: QuadrimestriLetti } | { ok: false }> {
  const periodi = new Map<string, PeriodoScrutinio[]>()
  const chiusi = new Set<string>()
  // Senza sedi `leggiPeriodi` non legge e non restituisce periodi: di conseguenza nemmeno gli scrutini.
  const lettiPeriodi = await leggiPeriodi(supabase, input.scuolaIds)
  if (!lettiPeriodi.ok) {
    logEvento('registro', 'error', { operazione: 'primaria/quadrimestre', esito: 'periodi-non-letti' }, lettiPeriodi.error)
    return { ok: false }
  }
  for (const p of lettiPeriodi.periodi) {
    const della = periodi.get(p.scuola_id)
    if (della) della.push(p)
    else periodi.set(p.scuola_id, [p])
  }

  // Senza un periodo con entrambe le date nessuno scrutinio può congelare niente.
  const idConDate = lettiPeriodi.periodi.filter((p) => p.data_inizio && p.data_fine).map((p) => p.id)
  if (idConDate.length === 0) return { ok: true, letti: { periodi, chiusi } }

  const { data, error } = await supabase
    .from('scrutini')
    .select('section_id, periodo_id')
    .in('section_id', [...input.sectionIds])
    .in('periodo_id', idConDate)
    .eq('stato', 'chiuso')
  if (error) {
    logEvento('registro', 'error', { operazione: 'primaria/quadrimestre', esito: 'scrutini-non-letti' }, error)
    return { ok: false }
  }
  for (const r of (data ?? []) as unknown as { section_id: string; periodo_id: string }[]) {
    chiusi.add(`${r.section_id}:${r.periodo_id}`)
  }
  return { ok: true, letti: { periodi, chiusi } }
}

/** `true` se almeno uno dei periodi che coprono `data` ha lo scrutinio chiuso per quella classe. `scuolaId` null: `false`. */
export function chiusoIn(letti: QuadrimestriLetti, scuolaId: string | null, sectionId: string, data: string): boolean {
  if (!scuolaId) return false
  const { coprenti } = periodoPerData(letti.periodi.get(scuolaId) ?? [], data)
  return coprenti.some((periodoId) => letti.chiusi.has(`${sectionId}:${periodoId}`))
}

export type StatoQuadrimestre =
  | { ok: true; periodoId: string | null; chiuso: boolean; dateMancanti: boolean }
  | { ok: false }

/**
 * Sede → ultimo giorno di Roma in cui ha scritto il log «date mancanti». Un voto su due
 * di una sede non configurata ripeterebbe lo stesso errore a ogni richiesta: una riga al
 * giorno per sede basta a farlo vedere senza coprire il resto. Resta in memoria del
 * processo e non si azzera: sono al più tante voci quante le sedi.
 */
const ultimoLogDateMancanti = new Map<string, string>()

export async function statoQuadrimestre(
  supabase: SupabaseClient,
  scuolaId: string | null,
  sectionId: string,
  data: string,
  adesso: Date = new Date(),
): Promise<StatoQuadrimestre> {
  if (!scuolaId) return { ok: true, periodoId: null, chiuso: false, dateMancanti: false }

  const lettura = await leggiQuadrimestri(supabase, { scuolaIds: [scuolaId], sectionIds: [sectionId] })
  if (!lettura.ok) return { ok: false }

  const esito = periodoPerData(lettura.letti.periodi.get(scuolaId) ?? [], data)
  const chiuso = chiusoIn(lettura.letti, scuolaId, sectionId, data)

  if (esito.dateMancanti) {
    const oggi = oggiRoma(adesso)
    if (ultimoLogDateMancanti.get(scuolaId) !== oggi) {
      ultimoLogDateMancanti.set(scuolaId, oggi)
      logEvento('config', 'error', {
        operazione: 'primaria/periodo',
        esito: 'date-quadrimestre-mancanti',
        scuola_id: scuolaId,
        data,
      })
    }
  }
  return { ok: true, periodoId: esito.periodoId, chiuso, dateMancanti: esito.dateMancanti }
}

/** La funzione SQL non esiste ancora: database non migrato (CI E2E). `PGRST202` per PostgREST, `42883` per Postgres. */
const FUNZIONE_ASSENTE = new Set(['PGRST202', '42883'])

function conteggio(valore: unknown): number {
  return typeof valore === 'number' && Number.isFinite(valore) ? valore : 0
}

/**
 * Riassegna `periodo_id` a voti e «impreparato» di UNA sede dopo che le sue date sono
 * cambiate. Mai solleva: `true` se il ricalcolo è andato, `false` altrimenti (e il motivo
 * è già nel log). `operazione` è il nome della route chiamante, per riconoscerla nel log.
 */
export async function ricalcolaPeriodiSede(
  supabase: SupabaseClient,
  scuolaId: string,
  operazione: string,
): Promise<boolean> {
  try {
    const { data, error } = await supabase.rpc('primaria_ricalcola_periodi', { p_scuola_id: scuolaId })
    if (error) {
      const codice = (error as { code?: unknown }).code
      if (typeof codice === 'string' && FUNZIONE_ASSENTE.has(codice)) {
        logEvento('registro', 'info', { operazione, esito: 'ricalcolo-non-disponibile-schema', scuola_id: scuolaId })
        return false
      }
      logEvento('registro', 'error', { operazione, esito: 'ricalcolo-periodi-non-riuscito', scuola_id: scuolaId }, error)
      return false
    }
    const risposta = (data ?? {}) as { valutazioni?: unknown; impreparati?: unknown }
    logEvento('registro', 'info', {
      operazione,
      esito: 'periodi-ricalcolati',
      scuola_id: scuolaId,
      n_valutazioni: conteggio(risposta.valutazioni),
      n_impreparati: conteggio(risposta.impreparati),
    })
    return true
  } catch (e) {
    logEvento('registro', 'error', { operazione, esito: 'ricalcolo-periodi-non-riuscito', scuola_id: scuolaId }, e)
    return false
  }
}
