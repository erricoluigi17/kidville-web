import type { SupabaseClient } from '@supabase/supabase-js'
import { logEvento } from '@/lib/logging/logger'

/**
 * Sedi REALI e ATTIVE del deployment — punto unico di verità.
 *
 * Il predicato "scuola reale" nasceva inline in `POST /api/iscrizione`. Ora lo usa
 * anche `GET /api/iscrizione/sedi`, che alimenta il selettore di sede del wizard
 * pubblico: se i due divergessero, il genitore vedrebbe nell'elenco una sede che
 * il POST poi rifiuta (o, peggio, non vedrebbe quella su cui vuole iscriversi).
 * Da qui in poi il predicato è uno solo, e questo modulo è il suo unico posto.
 */

export interface SedeMinima {
  id: string
  nome: string
}

/**
 * True se la sede è quella di TEST del seed E2E. Due indizi, perché il seed della
 * CI usa un id con prefisso fisso (`e2e00000-…`) ma il nome è l'unico segnale su
 * un DB dove qualcuno abbia creato la sede a mano.
 */
export function isScuolaE2E(s: SedeMinima): boolean {
  const nome = s.nome ?? ''
  return String(s.id ?? '').startsWith('e2e00000') || /e2e/i.test(nome)
}

/** Un utente visto dal lato delle sue sedi: la primaria (`utenti.scuola_id`) e
 *  quelle del ponte `utenti_scuole`. Basta questo per classificarlo. */
export interface UtenteConSedi {
  /** `utenti.scuola_id`. */
  scuola_id?: string | null
  /** `utenti_scuole.scuola_id` dell'utente. Vuoto se il ponte non è leggibile. */
  sedi?: readonly (string | null | undefined)[]
}

/**
 * True se l'utente è un account di **collaudo**: gemello di `isScuolaE2E` sulle
 * PERSONE, e unico predicato del progetto per «questo non è un utente vero».
 *
 * Perché esiste — il 2026-07-29 il provisioning di Kidville Aversa e Kidville
 * Cesa ha collegato alla loro Direzione anche `admin.e2e@kidville.test`, perché
 * `admin/schools:POST` costruiva l'elenco dei candidati con «tutti gli admin».
 * Quell'account ha `ruolo='admin'` e la password stava in chiaro in un
 * repository PUBBLICO: due plessi veri con la Direzione aperta a chiunque
 * leggesse il codice. Un filtro mancante non rompe niente e non avvisa nessuno.
 *
 * Regola — è di collaudo chi ha la sede PRIMARIA E2E, oppure chi ha almeno una
 * sede e le ha TUTTE E2E. Una sola sede reale basta a farne un utente vero: il
 * verso in cui si sbaglia è «lo tratto come reale», perché il danno di escludere
 * un amministratore vero (una sede che non compare nel suo SedeSelector) è
 * visibile e rimediabile, mentre quello opposto è silenzioso.
 *
 * ⚠️ Insieme VUOTO ⇒ **false**. `[].every(...)` è vero, e senza questa guardia
 * ogni utente senza sede diventerebbe «di collaudo».
 *
 * @param nomiSedi id → nome, da una lettura di `schools`. Può essere parziale (o
 *   vuota): il prefisso `e2e00000-…` dell'id resta il primo indizio, il nome è
 *   solo il secondo — così il predicato regge anche quando quella lettura degrada.
 */
export function isUtenteCollaudo(
  utente: UtenteConSedi,
  nomiSedi: ReadonlyMap<string, string> = new Map(),
): boolean {
  const sede = (id: string): SedeMinima => ({ id, nome: nomiSedi.get(id) ?? '' })
  const primaria = utente.scuola_id ? String(utente.scuola_id) : null
  if (primaria && isScuolaE2E(sede(primaria))) return true

  const ponte = (utente.sedi ?? []).filter(Boolean).map((s) => String(s))
  const tutte = primaria ? [primaria, ...ponte] : ponte
  if (tutte.length === 0) return false
  return tutte.every((id) => isScuolaE2E(sede(id)))
}

export interface EsitoSedi {
  /** `schools` grezza: E2E incluse, flag `attiva` NON applicato. Serve solo a
   *  validare uno `scuola_id` arrivato esplicitamente dal link. */
  tutte: SedeMinima[]
  /** Sedi reali e attive, ordinate per nome: è quello che si mostra al pubblico. */
  reali: SedeMinima[]
  /** Errore della lettura di `schools` (PostgREST NON lancia: ritorna `{ error }`).
   *  Il degrado del solo filtro `attiva` NON finisce qui: è fail-open, non un errore. */
  error: { message: string; code?: string } | null
}

/**
 * Legge le sedi e separa reali da tutte.
 *
 * `operazione` è il nome della route chiamante (`iscrizione:POST`, `iscrizione/sedi:GET`):
 * finisce nella colonna `operazione` di `app_log` ed è la chiave con cui si chiede
 * "quale route ha fallito".
 */
export async function sediReali(
  supabase: SupabaseClient,
  operazione: string,
): Promise<EsitoSedi> {
  let tutte: SedeMinima[] = []
  try {
    const { data, error } = await supabase
      .from('schools')
      .select('id, nome')
      .order('nome', { ascending: true })
    if (error) {
      // Senza l'elenco delle sedi il form pubblico non sa dove iscrivere nessuno:
      // è un guasto, non una nota a piè di pagina.
      logEvento('multi_sede', 'error', { operazione, esito: 'schools-non-leggibile' }, error)
      return { tutte: [], reali: [], error: { message: error.message, code: error.code } }
    }
    tutte = ((data ?? []) as SedeMinima[]).map((s) => ({ id: s.id, nome: s.nome }))
  } catch (e) {
    // Il client Supabase non dovrebbe lanciare, ma se lo fa (rete, DNS) l'eccezione
    // non deve arrivare nuda al chiamante: un catch che non logga è un bug.
    logEvento('multi_sede', 'error', { operazione, esito: 'schools-eccezione' }, e)
    const msg = e instanceof Error ? e.message : 'errore lettura schools'
    return { tutte: [], reali: [], error: { message: msg } }
  }

  let reali = tutte.filter((s) => !isScuolaE2E(s))

  // Scarta le sedi disattivate (soft-delete `scuole.attiva = false`). FAIL-OPEN come
  // in /api/admin/sedi: se la lettura del flag fallisce NON filtriamo — meglio una
  // sede in più che nasconderle tutte per un errore transitorio (o per la colonna
  // assente sul DB E2E della CI, che non è migrato: PostgREST risponde 42703).
  const ids = reali.map((s) => s.id)
  if (ids.length > 0) {
    try {
      const { data: registry, error: regError } = await supabase
        .from('scuole')
        .select('id, attiva')
        .in('id', ids)
      if (regError) {
        logEvento('multi_sede', 'info', { operazione, esito: 'fail-open-attiva' }, regError)
      } else {
        const disattivate = new Set(
          ((registry ?? []) as { id: string; attiva: boolean | null }[])
            .filter((r) => r.attiva === false)
            .map((r) => r.id),
        )
        if (disattivate.size > 0) reali = reali.filter((s) => !disattivate.has(s.id))
      }
    } catch (e) {
      logEvento('multi_sede', 'info', { operazione, esito: 'fail-open-attiva' }, e)
    }
  }

  return { tutte, reali, error: null }
}
