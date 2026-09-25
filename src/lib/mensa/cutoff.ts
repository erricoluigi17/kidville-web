import { dataCivile } from '@/i18n/config'
import { oraDiRomaAdesso } from '@/lib/presenze/orario'

/**
 * ─── IL CUTOFF DELLA MENSA, IN ORA ITALIANA ──────────────────────────────────
 *
 * Modulo PURO: nessun import server-only, lo usano sia la route
 * (`/api/mensa/prenotazioni`, tramite `@/lib/mensa/server`) sia l'interfaccia del
 * genitore. Server e schermo devono dare la STESSA risposta, altrimenti il pulsante
 * resta acceso su una data che il server rifiuta (o viceversa).
 *
 * Il difetto che chiude: la versione precedente prendeva «oggi» da
 * `toISOString()` (data UTC) e l'ora da `setHours()` (fuso del PROCESSO, UTC su
 * Vercel). Con il cutoff alle 09:30 il blocco scattava alle 11:30 italiane d'estate
 * e alle 10:30 d'inverno; e fra mezzanotte e le 2 italiane «ieri» risultava ancora
 * «oggi», quindi prenotabile. Qui data e ora si chiedono al fuso `Europe/Rome`
 * tramite gli helper che il repo ha già (`dataCivile`, `oraDiRomaAdesso`): nessun
 * secondo calendario.
 */

/** `HH:MM` o `HH:MM:SS` (la colonna `admin_settings.mensa_cutoff_ora` è un `time`). */
const FORMA_CUTOFF = /^(\d{1,2}):([0-5]\d)(?::([0-5]\d))?$/

/** La data di oggi a Roma, `YYYY-MM-DD` — la stessa forma delle colonne `date`. */
export function oggiRoma(adesso: Date = new Date()): string {
  return dataCivile(adesso)
}

/**
 * Millisecondi trascorsi dalla mezzanotte ITALIANA dell'istante dato.
 * Ore e minuti vengono da `oraDiRomaAdesso` (che conosce l'ora legale); secondi e
 * millisecondi sono gli stessi in ogni fuso con offset a minuti interi, quindi si
 * leggono dall'istante così com'è.
 */
function msDallaMezzanotteRoma(adesso: Date): number {
  const [h, m] = oraDiRomaAdesso(adesso).split(':').map(Number)
  return ((h * 60 + m) * 60 + adesso.getUTCSeconds()) * 1000 + adesso.getUTCMilliseconds()
}

/**
 * La data è ancora prenotabile/disdicibile rispetto all'orario limite?
 *   - data passata (secondo il calendario di Roma) → false
 *   - data futura → true
 *   - oggi → true finché l'ora italiana non supera il cutoff (il cutoff stesso è
 *     ancora dentro: 09:30:00 sì, 09:30:01 no)
 *
 * Un cutoff illeggibile vale come mezzanotte: per oggi si blocca. È la scelta
 * prudente (nessun ticket si muove) e la stessa di prima, quando le parti mancanti
 * diventavano 0.
 */
export function entroCutoff(data: string, cutoffOra: string, adesso: Date = new Date()): boolean {
  const oggi = oggiRoma(adesso)
  if (data < oggi) return false
  if (data > oggi) return true
  const m = FORMA_CUTOFF.exec((cutoffOra ?? '').trim())
  const cutoffMs = m
    ? ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3] ?? 0)) * 1000
    : 0
  return msDallaMezzanotteRoma(adesso) <= cutoffMs
}
