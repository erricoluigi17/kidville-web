/**
 * L'OBLIO ARRIVA ANCHE NELLA SCATOLA NERA (fase 4 della roadmap di robustezza, 2026-10-09).
 *
 * `scatola_nera.eliminazioni` tiene per 90 giorni ogni riga cancellata dalle tabelle
 * preziose (migrazione `*_scatola_nera_registro_eliminazioni.sql`). L'oblio cancella
 * righe anche lui — legami, documenti, l'account con le sue cascate — e senza questo
 * passo le copie di quelle righe resterebbero lì, leggibili, fino a 90 giorni dopo
 * che la famiglia ha chiesto di essere dimenticata.
 *
 * `public.scatola_nera_dimentica` toglie le righe che nominano la persona (in `id` o
 * in una colonna `*_id`) e scrive l'oblio in `scatola_nera.oblii` (data, uuid, tipo:
 * mai dati), il registro da cui si riapplicano gli oblii dopo un ripristino da una
 * copia vecchia. Si chiama IN CODA all'oblio, dopo l'ultima cancellazione.
 *
 * `completo: false` se la funzione esiste e ha rifiutato: l'oblio non è completo, e
 * chi risponde alla Direzione deve poterlo dire. Una funzione ASSENTE (il database
 * E2E della CI non è migrato, o la migrazione non è ancora applicata) vuol dire che
 * non esiste nemmeno la scatola: nessuna copia da togliere, quindi completo.
 *
 * Nei log solo conteggi: l'uuid della persona dimenticata non ci entra (come in tutto
 * l'oblio, vedi `gdpr-oblio-video-intenti.test.ts`).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { logEvento } from '@/lib/logging/logger'

const FUNZIONE_ASSENTE = new Set(['PGRST202', '42883', '3F000'])

export type TipoSoggettoScatola = 'alunno' | 'genitore' | 'personale' | 'altro'

export async function dimenticaNellaScatolaNera(
  supabase: SupabaseClient,
  soggetti: (string | null | undefined)[],
  tipo: TipoSoggettoScatola,
  op: string,
): Promise<{ righe: number; completo: boolean }> {
  const ids = [...new Set(soggetti.filter((s): s is string => typeof s === 'string' && s !== ''))]
  if (ids.length === 0) return { righe: 0, completo: true }

  const { data, error } = await supabase.rpc('scatola_nera_dimentica', {
    p_soggetti: ids,
    p_tipo: tipo,
    p_canale: op,
  })
  if (error) {
    const codice = (error as { code?: string }).code ?? null
    const assente = codice !== null && FUNZIONE_ASSENTE.has(codice)
    logEvento(
      'gdpr',
      assente ? 'info' : 'error',
      {
        operazione: op,
        esito: assente ? 'scatola-nera-assente' : 'scatola-nera-non-dimenticata',
        entita_tipo: tipo,
        n: ids.length,
        codice,
      },
      assente ? undefined : error,
    )
    return { righe: 0, completo: assente }
  }

  const righe = typeof data === 'number' ? data : Number(data ?? 0)
  // Evento critico: si logga anche il successo, e anche quando non c'era niente.
  logEvento('gdpr', 'info', {
    operazione: op,
    esito: 'scatola-nera-dimenticata',
    entita_tipo: tipo,
    n: righe,
  })
  return { righe, completo: true }
}
