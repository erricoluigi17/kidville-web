/**
 * Allergie e note mediche: dalla domanda di iscrizione alla scheda dell'alunno.
 *
 * ─── PERCHÉ ESISTE (2026-10-09) ─────────────────────────────────────────────
 * La cucina legge `alunni.allergies`, non la domanda. Fino a oggi i due rami che
 * RIUSANO una scheda già esistente (re-iscrizione: abbinamento per codice fiscale,
 * oppure per nome + cognome + data di nascita) scrivevano solo classe e retta; un
 * attimo dopo `scrubSanitariDomanda` toglieva allergie e note mediche dalla domanda.
 * Il dato dichiarato dalla famiglia non arrivava in scheda e spariva dalla domanda.
 * Misurato in produzione il 2026-10-09: 276 bambini con la domanda svuotata, 148
 * con la scheda senza nessun dato sanitario (secondo il titolare erano tutti «no» o
 * «nessuna»), 123 con la scheda piena di dati vecchi, mai confrontati con la
 * dichiarazione nuova. Le rimozioni erano più vecchie di ogni backup.
 *
 * ─── LA REGOLA, IN UN POSTO SOLO ────────────────────────────────────────────
 *  · campo della scheda vuoto → si scrive il valore della domanda;
 *  · la scheda contiene già quel testo → niente da scrivere;
 *  · la scheda dice altro → NON si sovrascrive mai: si AGGIUNGE in coda, con la data
 *    della domanda. «Nessuna» non deve poter cancellare «arachidi», e una dichiarazione
 *    nuova non deve sparire perché in scheda c'era già qualcosa. Chi legge vede
 *    entrambe le cose, e la segreteria sistema il testo;
 *  · dalla domanda si toglie solo ciò che è DAVVERO in scheda (`copiaSanitariPresente`).
 *
 * La stessa regola, in SQL, sta nel job notturno `iscrizioni_sanitari_tick`
 * (migrazione `*_sanitari_solo_con_copia_presente.sql`): la normalizzazione è la stessa
 * (spazi compressi, minuscole), e un disaccordo fra le due fa solo CONSERVARE il dato.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { CHIAVI_SANITARIE_ISCRIZIONE } from '@/lib/gdpr/anonimizza'
import { logEvento } from '@/lib/logging/logger'

export type CampoSanitario = (typeof CHIAVI_SANITARIE_ISCRIZIONE)[number]
export type SanitariScheda = Partial<Record<CampoSanitario, unknown>>

const FORMATO_DATA = new Intl.DateTimeFormat('it-IT', {
  timeZone: 'Europe/Rome',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
})

/** Spazi compressi e minuscole: è il confronto, non il testo che si scrive. */
export function normalizzaSanitario(valore: unknown): string {
  if (valore === null || valore === undefined) return ''
  return String(valore).trim().replace(/\s+/g, ' ').toLowerCase()
}

function testo(valore: unknown): string {
  return valore === null || valore === undefined ? '' : String(valore).trim()
}

function campo(figlio: unknown, k: CampoSanitario): unknown {
  return figlio && typeof figlio === 'object' ? (figlio as Record<string, unknown>)[k] : undefined
}

/** La scheda contiene già quello che dice la domanda? Una domanda muta è sempre «contenuta». */
function contiene(scheda: unknown, domanda: unknown): boolean {
  const d = normalizzaSanitario(domanda)
  return d === '' || normalizzaSanitario(scheda).includes(d)
}

/**
 * Cosa scrivere sulla scheda di un alunno che ESISTE GIÀ perché accolga i dati
 * sanitari della domanda. Restituisce solo i campi che cambiano (un oggetto vuoto
 * se la scheda contiene già tutto).
 */
export function sanitariDaScrivere(
  scheda: SanitariScheda,
  figlio: unknown,
  dataDomanda: Date,
): Partial<Record<CampoSanitario, string>> {
  const out: Partial<Record<CampoSanitario, string>> = {}
  for (const k of CHIAVI_SANITARIE_ISCRIZIONE) {
    const d = testo(campo(figlio, k))
    if (d === '') continue
    const s = testo(scheda[k])
    if (s === '') out[k] = d
    else if (!contiene(s, d)) out[k] = `${s}\nDalla domanda di iscrizione del ${FORMATO_DATA.format(dataDomanda)}: ${d}`
  }
  return out
}

/** Ogni dato sanitario della domanda per questo bambino è già nella scheda? */
export function copiaSanitariPresente(scheda: SanitariScheda, figlio: unknown): boolean {
  return CHIAVI_SANITARIE_ISCRIZIONE.every((k) => contiene(scheda[k], campo(figlio, k)))
}

/** La domanda porta almeno un dato sanitario per questo bambino? */
export function haSanitari(figlio: unknown): boolean {
  return CHIAVI_SANITARIE_ISCRIZIONE.some((k) => testo(campo(figlio, k)) !== '')
}

/**
 * I dati sanitari di una scheda che ESISTE GIÀ, da confrontare con la domanda.
 * `null` se la lettura non riesce: chi chiama allora non tocca i sanitari della
 * scheda e NON li toglie dalla domanda. Il dato resta dov'è finché qualcuno non
 * lo porta in scheda: perderlo costa più che conservarlo una notte in più.
 */
export async function leggiSanitariScheda(
  supabase: SupabaseClient,
  alunnoId: string,
  operazione: string,
): Promise<SanitariScheda | null> {
  const { data, error } = await supabase
    .from('alunni')
    .select('allergies, note_mediche')
    .eq('id', alunnoId)
    .maybeSingle()
  if (error || !data) {
    logEvento('db', 'warn', {
      operazione,
      esito: 'sanitari-scheda-non-letti',
      entita_tipo: 'alunni',
      entita_id: alunnoId,
      codice: (error as { code?: string } | null)?.code ?? null,
    })
    return null
  }
  return data as SanitariScheda
}
