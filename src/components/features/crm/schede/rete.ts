import { logClient, nomeErrore } from '@/lib/logging/client'

/**
 * CRM della segreteria · le chiamate alle route delle schede, con il log che il browser deve lasciare.
 *
 * Un guasto che il browser non registra è un guasto che nessuno vede (AGENTS.md, «Logging
 * obbligatorio»): le tre schermate delle schede — elenco, dettaglio, nuova famiglia — passano da qui,
 * così il `catch` non si riscrive tre volte e non si dimentica mai.
 *
 * ── Cosa si scrive nel log ────────────────────────────────────────────────────────────────────
 * Il nome dell'operazione, il codice di stato e la CLASSE dell'errore (`nomeErrore`): mai il corpo
 * della risposta, mai l'indirizzo (porta la ricerca digitata, cioè un nome) e mai il `message` di
 * un'eccezione (può riecheggiare l'indirizzo). Sono dati di famiglie e di minori.
 *
 * ── Cosa NON si scrive ────────────────────────────────────────────────────────────────────────
 * Le risposte 4xx: sono la strada normale di un modulo (409 «esiste già», 422 «manca il motivo») e
 * non un guasto. Solo i 5xx e le chiamate che non sono nemmeno arrivate.
 */

/** La rotta della PAGINA, il luogo dell'incidente: non la rotta della fetch. */
export const ROUTE_LOG = '/admin/crm'

/**
 * Esegue la chiamata. `null` = non è arrivata una risposta (rete, estensione, timeout): chi chiama lo
 * tratta come un guasto. Una risposta `!ok` arriva comunque, perché il suo corpo può essere una
 * decisione del server (`SCHEDA_ESISTENTE`) da mostrare.
 */
export async function chiama(operazione: string, url: string, init?: RequestInit): Promise<Response | null> {
  try {
    const res = await fetch(url, init)
    if (res.status >= 500) {
      logClient({ livello: 'error', evento: 'react', messaggio: `crm-${operazione}: http ${res.status}`, route: ROUTE_LOG, stato: res.status })
    }
    return res
  } catch (e) {
    logClient({ livello: 'error', evento: 'react', messaggio: `crm-${operazione}-fallita: ${nomeErrore(e)}`, route: ROUTE_LOG })
    return null
  }
}

/** Una scrittura JSON: l'intestazione giusta e il corpo già serializzato. */
export function scrittura(metodo: 'POST' | 'PATCH' | 'PUT', corpo: unknown): RequestInit {
  return { method: metodo, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) }
}

/** Il corpo JSON di una risposta, o `null` se non lo è: chi legge non deve dipendere da un `try`. */
export async function leggiJson(res: Response, operazione: string): Promise<unknown> {
  try {
    return await res.json()
  } catch (e) {
    logClient({ livello: 'error', evento: 'react', messaggio: `crm-${operazione}-corpo-illeggibile: ${nomeErrore(e)}`, route: ROUTE_LOG, stato: res.status })
    return null
  }
}
