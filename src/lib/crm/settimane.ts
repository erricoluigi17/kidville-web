import type { SupabaseClient } from '@supabase/supabase-js'
import type { FasciaRow, SettimanaRow } from './tipi'

/**
 * CRM DELLA SEGRETERIA · LE SETTIMANE DI DISPONIBILITÀ.
 *
 *   una settimana mai toccata è uguale all'ultima registrata prima di lei
 *
 * Ogni «proprietario» (una persona, oppure la sede: `utente_id` nullo) ha delle SETTIMANE REGISTRATE
 * (`crm_settimane`, una testata col lunedì) e, figlie, le sue FASCE (`crm_fasce`). Per sapere le fasce di un
 * proprietario in una settimana W si prende la sua settimana registrata più recente NON SUCCESSIVA a W
 * (spec §6.2). Una testata senza fasce è una settimana volutamente vuota, e vuote restano le successive finché
 * qualcuno non le cambia. Chi salva una settimana lo fa con `crm_salva_settimana`, che sostituisce tutte le
 * fasce di quel proprietario in una scrittura sola: la copia di ciò che si ereditava e la modifica non possono
 * restare a metà.
 *
 * Questo modulo è la lettura. Le funzioni di calcolo sono PURE e lavorano su GIORNI CIVILI (`YYYY-MM-DD`).
 *
 * ── IL LUNEDÌ NON PASSA DA UNA `Date` LOCALE ───────────────────────────────────────────
 * Domenica 25/10/2026 alle 3 di notte l'ora legale finisce, e il processo gira in UTC su Vercel e in
 * Europe/Rome sul Mac: il lunedì di quella domenica dev'essere il 19/10 in entrambi. Il giorno civile non ha
 * fuso, quindi si fa aritmetica su un mezzogiorno UTC (che in nessun fuso cambia giorno) e si leggono i campi
 * UTC. Mai `new Date(anno, mese, giorno)` né `getDay()` locale. Gli ORARI di Roma, invece, li converte
 * `istanteCivile` (`src/lib/format/confini-giorno.ts`) dentro `slot.ts`: qui non ci sono istanti.
 */

/** Una fascia già risolta per una settimana precisa: è ciò che il calcolo degli slot legge. */
export interface FasciaEffettiva {
  /** nullo = la fascia della sede (riceve chi sceglie chi fissa la visita) */
  utenteId: string | null
  /** il lunedì della settimana IN CUI VALE (non quello della settimana registrata da cui eredita) */
  settimana: string
  /** 1 = lunedì … 7 = domenica (ISO) */
  giornoSettimana: number
  /** `HH:MM`, orologio di Roma */
  oraInizio: string
  oraFine: string
  durataSlotMin: number
}

/**
 * Da dove vengono le fasce di un proprietario in una settimana:
 *  · `registrata` — la settimana ha la sua testata;
 *  · `ereditata`  — la testata è di una settimana precedente (`daSettimana`);
 *  · `nessuna`    — il proprietario non ha mai registrato niente fino a quella settimana.
 */
export type OrigineSettimana = 'registrata' | 'ereditata' | 'nessuna'

export interface FasceDelProprietario {
  utenteId: string | null
  origine: OrigineSettimana
  /** il lunedì della testata da cui vengono le fasce (la stessa settimana, se `registrata`); nullo se `nessuna` */
  daSettimana: string | null
  fasce: FasciaEffettiva[]
}

/** Più settimane di così in un periodo sono un errore di chi chiama (la agenda ne chiede una, al più dieci). */
const SETTIMANE_MAX = 60

const FORMA_YMD = /^\d{4}-\d{2}-\d{2}$/

/** Il mezzogiorno UTC di un giorno civile, o `null` se la data non esiste (`2026-02-30`, `ieri`). */
function mezzogiornoUtc(ymd: string): Date | null {
  if (!FORMA_YMD.test(ymd ?? '')) return null
  const d = new Date(`${ymd}T12:00:00Z`)
  if (Number.isNaN(d.getTime())) return null
  // Un giorno che non esiste può essere "aggiustato" (30 febbraio → 2 marzo): se non torna uguale, non esiste.
  return d.toISOString().slice(0, 10) === ymd ? d : null
}

function sommaGiorni(d: Date, n: number): string {
  const r = new Date(d.getTime())
  r.setUTCDate(r.getUTCDate() + n)
  return r.toISOString().slice(0, 10)
}

/**
 * Il lunedì della settimana di un giorno civile `YYYY-MM-DD` (qualunque giorno: domenica compresa, che
 * appartiene alla settimana che finisce). Una data senza forma o inesistente torna com'è: la valida chi chiama.
 */
export function lunediDi(ymd: string): string {
  const d = mezzogiornoUtc(ymd)
  if (!d) return ymd
  const iso = d.getUTCDay() === 0 ? 7 : d.getUTCDay()
  return sommaGiorni(d, -(iso - 1))
}

/** La settimana si può modificare? La in corso (quella di `oggi`, a Roma) e le future sì; le passate no. */
export function settimanaModificabile(settimana: string, oggi: string): boolean {
  return settimana >= lunediDi(oggi)
}

/** I lunedì delle settimane che toccano `dal`…`al` (estremi compresi). Vuoto se l'intervallo non ha senso. */
export function settimaneDelPeriodo(dal: string, al: string): string[] {
  const da = mezzogiornoUtc(dal)
  const a = mezzogiornoUtc(al)
  if (!da || !a || al < dal) return []
  const ultimo = lunediDi(al)
  const out: string[] = []
  for (let lunedi = lunediDi(dal); lunedi <= ultimo && out.length < SETTIMANE_MAX; ) {
    out.push(lunedi)
    const d = mezzogiornoUtc(lunedi)
    if (!d) break
    lunedi = sommaGiorni(d, 7)
  }
  return out
}

/** La settimana registrata più recente non successiva a `settimana` per quel proprietario (la sede è `null`). */
export function settimanaDiRiferimento(
  settimane: SettimanaRow[],
  utenteId: string | null,
  settimana: string,
): SettimanaRow | null {
  let migliore: SettimanaRow | null = null
  for (const s of settimane) {
    if ((s.utente_id ?? null) !== utenteId) continue
    if (s.settimana > settimana) continue
    if (migliore === null || s.settimana > migliore.settimana) migliore = s
  }
  return migliore
}

/** `HH:MM:SS` (come Postgres restituisce un `time`) → `HH:MM`. */
const hhmm = (ora: string) => (ora ?? '').slice(0, 5)

/** I proprietari che compaiono nelle testate: la sede per prima, poi le persone per uuid. */
function proprietariPresenti(settimane: SettimanaRow[]): (string | null)[] {
  const persone = new Set<string>()
  let sede = false
  for (const s of settimane) {
    if (s.utente_id === null || s.utente_id === undefined) sede = true
    else persone.add(s.utente_id)
  }
  return [...(sede ? [null] : []), ...[...persone].sort()]
}

/**
 * Le fasce di ogni proprietario nella settimana di `settimana` (qualunque giorno: si normalizza al lunedì).
 *
 * Senza `proprietari` escono quelli che hanno almeno una testata (la sede per prima). Con `proprietari` escono
 * ESATTAMENTE quelli e nell'ordine detto, anche se non hanno mai registrato niente (origine `nessuna`, fasce
 * vuote): è come la schermata ha una riga per la sede e una per ogni persona della sede, e non una per chi ha
 * una vecchia testata ma non è più della sede.
 */
export function fasceDellaSettimana(
  settimane: SettimanaRow[],
  fasce: FasciaRow[],
  settimana: string,
  proprietari?: (string | null)[],
): FasceDelProprietario[] {
  const lunedi = lunediDi(settimana)
  return (proprietari ?? proprietariPresenti(settimane)).map((utenteId) => {
    const rif = settimanaDiRiferimento(settimane, utenteId, lunedi)
    if (!rif) return { utenteId, origine: 'nessuna', daSettimana: null, fasce: [] }
    const mie: FasciaEffettiva[] = fasce
      .filter((f) => f.settimana_id === rif.id)
      .map((f) => ({
        utenteId,
        settimana: lunedi,
        giornoSettimana: f.giorno_settimana,
        oraInizio: hhmm(f.ora_inizio),
        oraFine: hhmm(f.ora_fine),
        durataSlotMin: f.durata_slot_min,
      }))
      .sort((x, y) => x.giornoSettimana - y.giornoSettimana || (x.oraInizio < y.oraInizio ? -1 : x.oraInizio > y.oraInizio ? 1 : 0))
    return { utenteId, origine: rif.settimana === lunedi ? 'registrata' : 'ereditata', daSettimana: rif.settimana, fasce: mie }
  })
}

/**
 * Le testate e le fasce che servono a risolvere le settimane di `dal`…`al` per una sede: due letture, entrambe
 * con `.eq('scuola_id')`. LANCIA l'errore del database (l'oggetto PostgREST tale e quale): il chiamante lo passa
 * a `rispostaErroreDb`, che sa distinguere «tabelle assenti» (503) da un guasto (500). Un `[]` direbbe alla
 * segretaria «nessuno è disponibile» quando in realtà non lo sappiamo.
 *
 *  1. `crm_settimane` con `settimana <= lunedì di al`. Le testate vecchie servono: una settimana mai toccata
 *     eredita dall'ultima registrata, anche di mesi prima. Si ordinano dalla più recente.
 *  2. `crm_fasce` delle sole testate che qualche settimana del periodo prende come riferimento.
 */
export async function leggiSettimaneEFasce(
  supabase: SupabaseClient,
  scuolaId: string,
  dal: string,
  al: string,
): Promise<{ settimane: SettimanaRow[]; fasce: FasciaRow[] }> {
  const lunedi = settimaneDelPeriodo(dal, al)
  if (lunedi.length === 0) return { settimane: [], fasce: [] }

  const t = await supabase
    .from('crm_settimane')
    .select('*')
    .eq('scuola_id', scuolaId)
    .lte('settimana', lunedi[lunedi.length - 1])
    .order('settimana', { ascending: false })
  if (t.error) throw t.error
  const settimane = (t.data ?? []) as SettimanaRow[]

  const riferimenti = new Set<string>()
  for (const w of lunedi) {
    for (const utenteId of proprietariPresenti(settimane)) {
      const rif = settimanaDiRiferimento(settimane, utenteId, w)
      if (rif) riferimenti.add(rif.id)
    }
  }
  if (riferimenti.size === 0) return { settimane, fasce: [] }

  const f = await supabase.from('crm_fasce').select('*').eq('scuola_id', scuolaId).in('settimana_id', [...riferimenti])
  if (f.error) throw f.error
  return { settimane, fasce: (f.data ?? []) as FasciaRow[] }
}

/**
 * Le fasce di ogni settimana che tocca `dal`…`al`, già risolte (registrate ed ereditate), tutte della sede
 * `scuolaId`. Ognuna vale solo nella sua `settimana`. Lancia sull'errore del database.
 */
export async function caricaFasceEffettive(
  supabase: SupabaseClient,
  scuolaId: string,
  dal: string,
  al: string,
): Promise<FasciaEffettiva[]> {
  const { settimane, fasce } = await leggiSettimaneEFasce(supabase, scuolaId, dal, al)
  const out: FasciaEffettiva[] = []
  for (const w of settimaneDelPeriodo(dal, al)) {
    for (const p of fasceDellaSettimana(settimane, fasce, w)) out.push(...p.fasce)
  }
  return out
}
