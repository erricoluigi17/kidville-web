import { logClient, nomeErrore } from '@/lib/logging/client'

/**
 * GLI INTENTI CHE LA PERSONA HA TOLTO DALLA SCHEDA, E CHE IL SERVER RIPORTA ANCORA.
 *
 * ─── PERCHÉ ESISTE ───────────────────────────────────────────────────────────────────────────
 * L'elenco del server (`GET /api/video-uploads`) riporta per sette giorni anche gli intenti
 * conclusi. Per la maggior parte basta guardare la fase: un annullato non si mostra, un pubblicato
 * nemmeno. Ma un intento del flusso vecchio che il rilascio ha reso inutilizzabile è `da-ricaricare`
 * **qualunque sia il suo stato** (la fase si decide dal flusso, non dallo stato): annullarlo con
 * «Togli» non lo fa uscire dall'elenco, e una scheda che dice «questo video va ricaricato» a ogni
 * apertura della galleria per una settimana, dopo che la persona l'ha letta e tolta, è rumore.
 * Quindi «Togli» si ricorda QUI, sul dispositivo — ma solo quando il ritiro dell'intento è riuscito
 * (`useVideoGalleria.rimuovi`, #141): se il server non l'ha confermato l'intento è ancora vivo, e un
 * video in preparazione uscirebbe in galleria mentre il telefono lo fa credere tolto. Chi chiama
 * `nascondiIntento` prima della conferma rimette in tabella proprio quel difetto.
 *
 * ─── COSA SI TIENE, E PERCHÉ È LECITO ────────────────────────────────────────────────────────
 * Solo uuid di intenti e l'istante in cui sono stati tolti, per utente: nessun nome di file, nessun
 * bambino, niente che identifichi una persona. È una comodità per-dispositivo (come un filtro
 * ricordato): se il `localStorage` manca o è pieno la scheda può ricomparire, e niente si perde.
 * Dopo otto giorni la voce si butta — un giorno oltre i sette in cui l'elenco riporta ancora
 * l'intento — così la lista non cresce per sempre; e non supera `MAX_NASCOSTI`.
 */

const PREFISSO_CHIAVE = 'kv:video-galleria-nascosti:'
const GIORNI_TENUTI = 8
const MS_GIORNO = 24 * 60 * 60 * 1000
const MAX_NASCOSTI = 100

/** La parte di `Storage` che serve: iniettabile, perché il collaudo non deve toccare quello vero. */
export interface DepositoNascosti {
  getItem(chiave: string): string | null
  setItem(chiave: string, valore: string): void
}

let segnalato = false

/** Un guasto del deposito si dice una volta per sessione: ripeterlo a ogni lettura sarebbe rumore. */
function segnala(motivo: string, err?: unknown): void {
  if (segnalato) return
  segnalato = true
  const campi: Record<string, string> = { motivo }
  if (err !== undefined) campi.error_code = nomeErrore(err)
  logClient({
    livello: 'warn',
    evento: 'offline',
    messaggio: 'video-galleria-nascosti-non-disponibili',
    campi,
  })
}

/** Il deposito del browser, o `null` quando non c'è: l'accesso stesso può lanciare (siti bloccati). */
function depositoDelBrowser(): DepositoNascosti | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch (err) {
    segnala('accesso', err)
    return null
  }
}

function leggiVoci(utenteId: string, deposito: DepositoNascosti | null, adesso: number): Record<string, number> {
  if (!deposito) return {}
  let grezzo: string | null
  try {
    grezzo = deposito.getItem(PREFISSO_CHIAVE + utenteId)
  } catch (err) {
    segnala('lettura', err)
    return {}
  }
  if (!grezzo) return {}
  let letto: unknown
  try {
    letto = JSON.parse(grezzo)
  } catch (err) {
    segnala('forma', err)
    return {}
  }
  if (typeof letto !== 'object' || letto === null || Array.isArray(letto)) return {}
  const voci: Record<string, number> = {}
  for (const [intentId, quando] of Object.entries(letto as Record<string, unknown>)) {
    // Una voce illeggibile o scaduta non si tiene: è meglio rimostrare una scheda che ricordare per
    // sempre qualcosa che non si capisce.
    if (typeof quando !== 'number' || !Number.isFinite(quando)) continue
    if (adesso - quando >= GIORNI_TENUTI * MS_GIORNO) continue
    voci[intentId] = quando
  }
  return voci
}

/** Gli intenti che questa persona ha tolto di mezzo su questo dispositivo. */
export function leggiNascosti(
  utenteId: string,
  adesso: number = Date.now(),
  deposito: DepositoNascosti | null = depositoDelBrowser(),
): Set<string> {
  return new Set(Object.keys(leggiVoci(utenteId, deposito, adesso)))
}

/** Ricorda che la persona ha tolto questo intento, e restituisce l'insieme aggiornato. */
export function nascondiIntento(
  utenteId: string,
  intentId: string,
  adesso: number = Date.now(),
  deposito: DepositoNascosti | null = depositoDelBrowser(),
): Set<string> {
  const voci = leggiVoci(utenteId, deposito, adesso)
  voci[intentId] = adesso
  // Oltre il tetto si butta il più vecchio: la lista di una persona non ha motivo di crescere.
  const ordinate = Object.entries(voci).sort((a, b) => b[1] - a[1]).slice(0, MAX_NASCOSTI)
  const tenute = Object.fromEntries(ordinate)
  if (deposito) {
    try {
      deposito.setItem(PREFISSO_CHIAVE + utenteId, JSON.stringify(tenute))
    } catch (err) {
      segnala('scrittura', err)
    }
  }
  return new Set(Object.keys(tenute))
}
