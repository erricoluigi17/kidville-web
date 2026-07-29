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
