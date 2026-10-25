import type { SupabaseClient } from '@supabase/supabase-js'
import { logEvento } from '@/lib/logging/logger'

// =============================================================================
// PRESA CON SCADENZA SUI GIRI DEL CRON (sessione 8 della seconda serie di robustezza, D12).
//
// Un giro che dura minuti (la sincronizzazione SDI: 185-242 s misurati l'11/09) non deve partire
// due volte insieme: due giri leggono le stesse fatture «in volo», le chiedono due volte ad Aruba
// e mandano due volte la stessa notifica di scarto. `pg_advisory_xact_lock` con PostgREST dura una
// chiamata sola, non un giro HTTP: qui la presa è una riga in `cron_prese` con una scadenza, presa
// e rilasciata da due RPC (`cron_presa_prendi`, `cron_presa_rilascia`), con il tempo del database.
//
// Un giro che muore a metà (Vercel lo taglia a `maxDuration`) non rilascia: la presa scade da sola
// dopo DURATA_PRESA_CRON_S, che per questo è PIÙ LUNGA della vita massima della route.
// =============================================================================

/** 330 s: più dei 300 di `maxDuration`, come la presa della coda delle stampe storiche. */
export const DURATA_PRESA_CRON_S = 330

/**
 * PostgREST non trova la funzione (PGRST202) o Postgres non la conosce (42883): DB non migrato (la
 * CI, o la finestra del merge). Insieme LOCALE a questa chiamata, sul modello di `RPC_ASSENTE` in
 * `src/app/api/avvisi/[id]/risposte/route.ts` (§5 della specifica): `src/lib/db/tolleranza-schema.ts`
 * non si allarga, perché fuori da questa finestra una RPC che manca è schema a metà.
 */
const RPC_ASSENTE = new Set(['PGRST202', '42883'])

export type EsitoPresaCron =
  | { esito: 'presa'; token: string | null }
  | { esito: 'altrui' }
  | { esito: 'guasto' }

/**
 * `presa` col token da rilasciare (null sul DB non migrato: il giro parte senza freno, come prima,
 * e lo si dice); `altrui` se un altro giro la tiene; `guasto` se non si è potuto sapere.
 */
export async function prendiPresaCron(db: SupabaseClient, job: string): Promise<EsitoPresaCron> {
  try {
    const { data, error } = await db.rpc('cron_presa_prendi', { p_job: job, p_durata_s: DURATA_PRESA_CRON_S })
    if (error) {
      if (RPC_ASSENTE.has(error.code ?? '')) {
        // `info`, non `warn`: è lo schema di prima, atteso sul DB della CI e per i pochi minuti fra
        // deploy e migrazione (§5). Se in produzione la RPC mancasse davvero, lo dice il controllo
        // `migrazioni` di /api/health (sessione 7).
        logEvento('cron', 'info', { operazione: job, esito: 'presa-senza-rpc' }, error)
        return { esito: 'presa', token: null }
      }
      logEvento('cron', 'error', { operazione: job, esito: 'presa-non-riuscita' }, error)
      return { esito: 'guasto' }
    }
    if (typeof data !== 'string' || data === '') {
      logEvento('cron', 'info', { operazione: job, esito: 'presa-altrui' })
      return { esito: 'altrui' }
    }
    return { esito: 'presa', token: data }
  } catch (err) {
    logEvento('cron', 'error', { operazione: job, esito: 'presa-non-eseguita' }, err)
    return { esito: 'guasto' }
  }
}

/** Non lancia mai: un rilascio fallito si logga, e la presa scade da sola. */
export async function rilasciaPresaCron(db: SupabaseClient, job: string, token: string | null): Promise<void> {
  if (!token) return
  try {
    const { data, error } = await db.rpc('cron_presa_rilascia', { p_job: job, p_token: token })
    if (error) {
      logEvento('cron', 'error', { operazione: job, esito: 'presa-non-rilasciata' }, error)
      return
    }
    if (data !== true) logEvento('cron', 'warn', { operazione: job, esito: 'presa-gia-scaduta' })
  } catch (err) {
    logEvento('cron', 'error', { operazione: job, esito: 'presa-non-rilasciata' }, err)
  }
}
