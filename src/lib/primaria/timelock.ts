import type { SupabaseClient } from '@supabase/supabase-js'
import { logEvento } from '@/lib/logging/logger'

export type LockTipo = 'classe_orale' | 'scritto_pratico'

// Scadenze di default (giorni) se admin_settings non è configurato.
const DEFAULT_CLASSE_ORALE = 2
const DEFAULT_SCRITTO_PRATICO = 15

export interface Deadlines {
  classeOrale: number
  scrittoPratico: number
}

const TERMINI_PREDEFINITI: Deadlines = {
  classeOrale: DEFAULT_CLASSE_ORALE,
  scrittoPratico: DEFAULT_SCRITTO_PRATICO,
}

const FORMA_YMD = /^(\d{4})-(\d{2})-(\d{2})$/

/**
 * La DATA DI ROMA (`YYYY-MM-DD`) di un istante.
 *
 * Il runtime (Vercel) gira in UTC: fra mezzanotte e l'una (le due in ora legale)
 * la data UTC è ancora quella di ieri, e un termine calcolato lì scadeva un giorno
 * dopo per chi lavorava a quell'ora. Il fuso si CHIEDE a `Intl`, che conosce l'ora
 * legale, invece di assumere uno scarto fisso.
 */
export function dataRomaDi(istante: Date | string): string {
  const d = typeof istante === 'string' ? new Date(istante) : istante
  return d.toLocaleDateString('en-CA', { timeZone: 'Europe/Rome' })
}

/**
 * Giorni di CALENDARIO fra due date `YYYY-MM-DD` (b − a).
 *
 * Si contano sulle date, non sui millisecondi: a cavallo del cambio d'ora un
 * giorno dura 23 o 25 ore, e `Math.floor(ms / 86_400_000)` sbagliava di uno
 * proprio in quelle due notti. `Date.UTC` sulle tre cifre non ha fuso né ora
 * legale: è aritmetica di calendario pura.
 */
export function giorniFraDate(a: string, b: string): number {
  const ma = FORMA_YMD.exec(a)
  const mb = FORMA_YMD.exec(b)
  if (!ma || !mb) return Number.NaN
  const ta = Date.UTC(Number(ma[1]), Number(ma[2]) - 1, Number(ma[3]))
  const tb = Date.UTC(Number(mb[1]), Number(mb[2]) - 1, Number(mb[3]))
  return Math.round((tb - ta) / 86_400_000)
}

/** Il limite in giorni che vale per quel tipo di voce. */
export function limitePer(termini: Deadlines, lockTipo: LockTipo): number {
  return lockTipo === 'scritto_pratico' ? termini.scrittoPratico : termini.classeOrale
}

/**
 * Il calcolo PURO del termine: nessuna lettura, nessun orologio implicito.
 *
 * `giorniTrascorsi` = giorni di calendario fra la data dell'evento e OGGI A ROMA.
 * Bloccato se sono PIÙ del limite: con limite 2 la lezione di lunedì si firma
 * ancora mercoledì, non più giovedì (la semantica di sempre, ora sul giorno giusto).
 * Una data illeggibile è bloccata: fail-closed, un termine che non si sa calcolare
 * non si considera rispettato.
 */
export function calcolaScadenza(
  eventDate: string,
  giorniLimite: number,
  adesso: Date = new Date(),
): { locked: boolean; giorniLimite: number; giorniTrascorsi: number } {
  const giorniTrascorsi = giorniFraDate(eventDate, dataRomaDi(adesso))
  if (Number.isNaN(giorniTrascorsi)) return { locked: true, giorniLimite, giorniTrascorsi }
  return { locked: giorniTrascorsi > giorniLimite, giorniLimite, giorniTrascorsi }
}

/**
 * Legge i termini della sede e DICE se la lettura è fallita.
 *
 * PostgREST non lancia: prima un guasto su `admin_settings` diventava in silenzio
 * «nessuna impostazione» e si ripiegava sui predefiniti. Qui l'errore torna al
 * chiamante, che decide: `permesso-voce` risponde 500 `LETTURA_FALLITA`,
 * `getDeadlines` (le route storiche) ripiega ma lo LOGGA.
 */
export async function leggiTermini(
  supabase: SupabaseClient,
  scuolaId: string | null | undefined,
): Promise<{ ok: true; termini: Deadlines } | { ok: false; error: unknown }> {
  if (!scuolaId) return { ok: true, termini: { ...TERMINI_PREDEFINITI } }
  const { data, error } = await supabase
    .from('admin_settings')
    .select('timelock_giorni_classe_orale, timelock_giorni_scritto_pratico')
    .eq('scuola_id', scuolaId)
    .maybeSingle()
  if (error) return { ok: false, error }
  const riga = data as { timelock_giorni_classe_orale?: number | null; timelock_giorni_scritto_pratico?: number | null } | null
  return {
    ok: true,
    termini: {
      classeOrale: riga?.timelock_giorni_classe_orale ?? DEFAULT_CLASSE_ORALE,
      scrittoPratico: riga?.timelock_giorni_scritto_pratico ?? DEFAULT_SCRITTO_PRATICO,
    },
  }
}

export async function getDeadlines(
  supabase: SupabaseClient,
  scuolaId: string | null | undefined
): Promise<Deadlines> {
  const letti = await leggiTermini(supabase, scuolaId)
  if (letti.ok) return letti.termini
  // Il ripiego resta (le route storiche non hanno un ramo d'errore qui), ma non è
  // più muto: i predefiniti coincidono oggi con le impostazioni di tutte le sedi,
  // e il giorno in cui una sede li cambia un guasto silenzioso sarebbe invisibile.
  logEvento('registro', 'error', {
    operazione: 'primaria/timelock',
    esito: 'termini-non-letti-ripiego-predefiniti',
    scuola_id: scuolaId ?? null,
  }, letti.error)
  return { ...TERMINI_PREDEFINITI }
}

/**
 * Calcola se una registrazione è bloccata per superamento del termine.
 * `eventDate` è la data dell'evento (lezione/prova) in ISO (YYYY-MM-DD).
 * Il blocco effettivo è scavalcabile solo dal dirigente (vedi /api/primaria/sblocca).
 *
 * «Oggi» è la data di ROMA di `adesso` (vedi `dataRomaDi`), non quella del server.
 */
export async function isOltreScadenza(
  supabase: SupabaseClient,
  scuolaId: string | null | undefined,
  eventDate: string,
  lockTipo: LockTipo,
  adesso: Date = new Date(),
): Promise<{ locked: boolean; giorniLimite: number; giorniTrascorsi: number }> {
  const deadlines = await getDeadlines(supabase, scuolaId)
  return calcolaScadenza(eventDate, limitePer(deadlines, lockTipo), adesso)
}
