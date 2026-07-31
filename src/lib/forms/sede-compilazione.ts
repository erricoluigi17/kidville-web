import type { SupabaseClient } from '@supabase/supabase-js'
import { sediReali } from '@/lib/scuole/reali'
import { logEvento } from '@/lib/logging/logger'

// =============================================================================
// La sede di una COMPILAZIONE (`form_submissions.scuola_id`): una semantica sola.
//
// Il difetto che questo modulo chiude (audit 2026-07-31, R25): `NULL` voleva
// dire «tutte le sedi» a chi scriveva e «nessuna sede» a chi leggeva. I quattro
// lettori messi in scope da PR #60 filtrano con `.in('scuola_id', plessi)`, e in
// SQL `NULL IN (…)` vale NULL — non true. Una riga senza sede non la vedeva più
// NESSUNO, nemmeno la Direzione: la compilazione di una famiglia entrava nel
// database e spariva dalla vista di ogni operatore. Il commento nel codice
// affermava il contrario, che è il modo più efficace per impedire a chi indaga
// di sospettare.
//
// La regola: la sede si RISOLVE dai dati che ci sono, in ordine di attendibilità,
// e se non se ne trova nessuna l'invio si RIFIUTA. Le due alternative sono
// entrambe peggiori: inventare una sede archivia una domanda nel plesso
// sbagliato, scrivere NULL la perde in silenzio.
//
// Unica eccezione, e non è un'eccezione: un impianto con ZERO sedi reali (il
// database E2E della CI, la cui unica scuola è quella finta) non ha niente da
// isolare. Lì `null` è la risposta esatta, non un ripiego — ed è la stessa
// scelta già presa da `degradoSedeLecito`.
// =============================================================================

export interface EsitoSedeCompilazione {
  /** Sede da scrivere sulla riga. `null` SOLO quando non c'è nulla da isolare. */
  scuolaId: string | null
  /** `true` ⇒ la sede non è determinabile: l'invio va rifiutato con 400. */
  ambigua: boolean
}

/**
 * Risolve la sede di una compilazione.
 *
 * @param candidate  sedi in ordine di attendibilità decrescente: la sede di chi
 *   compila, poi quella dichiarata sul modello. Valori vuoti vengono saltati.
 * @param operazione nome della route chiamante (`forms/submit:POST`): finisce
 *   nella colonna `operazione` di `app_log`.
 */
export async function risolviSedeCompilazione(
  supabase: SupabaseClient,
  candidate: readonly (string | null | undefined)[],
  operazione: string,
): Promise<EsitoSedeCompilazione> {
  for (const c of candidate) {
    if (typeof c === 'string' && c.trim() !== '') return { scuolaId: c, ambigua: false }
  }

  const { reali, error } = await sediReali(supabase, operazione)
  if (error) {
    // Non sapere quante sedi ci sono non può valere «una sola»: si nega.
    logEvento('modulistica', 'error', {
      operazione, esito: 'sedi-non-leggibili-invio-rifiutato',
    }, error)
    return { scuolaId: null, ambigua: true }
  }
  if (reali.length === 1) return { scuolaId: reali[0].id, ambigua: false }
  if (reali.length === 0) {
    // Nessuna sede reale: non c'è isolamento da garantire (è il DB della CI).
    logEvento('modulistica', 'info', { operazione, esito: 'nessuna-sede-da-isolare' })
    return { scuolaId: null, ambigua: false }
  }

  // Configurazione mancante, non input malformato: un modello che vale per tutte
  // le sedi non può ricevere compilazioni su un impianto che ne ha più d'una,
  // perché la domanda non finirebbe in nessun elenco. Livello `error`.
  logEvento('modulistica', 'error', {
    operazione, esito: 'sede-compilazione-ambigua', sedi: reali.length,
  })
  return { scuolaId: null, ambigua: true }
}
