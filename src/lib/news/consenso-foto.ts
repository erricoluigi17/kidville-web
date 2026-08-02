// =============================================================================
// Consenso fotografico sul canale «sito web della Scuola» (privacy F4).
//
// PERCHÉ ESISTE. Il bucket `news` è PUBBLICO e servito senza login: è, alla
// lettera, il «sito web della Scuola» di cui parla il modulo d'iscrizione. Le
// famiglie rispondono a tre consensi distinti — galleria riservata, sito,
// social — perché il consenso alla pubblicazione è granulare per canale (provv.
// Garante 725 del 27/11/2025). Fino al 2026-07-31 la sola difesa su questo
// canale era una spunta nell'editor che viveva in `useState`: non arrivava al
// server, non veniva archiviata, non consultava nessun dato. L'operatore
// dichiarava un consenso che il sistema non poteva né onorare né dimostrare.
//
// COSA CAMBIA. Chi pubblica dichiara CHI è ritratto (eventualmente «nessuno»), e
// il server verifica il consenso di ciascun bambino su `alunni.consenso_foto_sito`
// prima di scrivere la riga. La dichiarazione viene archiviata insieme al post:
// chi, quando, con quale versione del testo, su quali bambini.
//
// DUE DIFFERENZE DALLA GALLERIA, entrambe volute:
//  1. NON esiste l'esenzione «foto privata». Nella galleria un bambino taggato
//     da solo passa, perché quella foto la vedono solo i suoi genitori. Qui il
//     pubblico è chiunque abbia l'indirizzo: un bambino solo, senza consenso,
//     blocca esattamente come cinque.
//  2. È FAIL-CLOSED sull'incertezza. Se il consenso non è leggibile — colonna
//     assente sul DB E2E non migrato, guasto di lettura, uuid che non appartiene
//     a un alunno delle sedi di chi pubblica — si BLOCCA. «Non lo so» non può
//     valere «sì»: è esattamente l'errore che il ciclo sta chiudendo.
// =============================================================================

import { logEvento } from '@/lib/logging/logger'

// `contieneFoto` sta in un modulo PURO (`./foto-nel-post`) perché serve anche
// all'editor, che è un componente client e non può tirarsi dietro il logger.
export { contieneFoto } from './foto-nel-post'

/** Colonna di `alunni` che registra il consenso per il canale pubblico. */
export const COLONNA_CONSENSO_SITO = 'consenso_foto_sito'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = { from: (t: string) => any }

export type EsitoConsensoSito =
  | { esito: 'ok' }
  | { esito: 'bloccato'; bambini: { id: string; nome: string }[] }
  | { esito: 'non-verificabile' }

/**
 * Verifica il consenso «sito» dei bambini dichiarati come ritratti.
 *
 * @param sedi le sedi accessibili a chi pubblica. La query è ristretta a queste:
 *   senza il vincolo, un uuid preso a caso restituirebbe il NOME di un minore di
 *   un altro plesso dentro il messaggio d'errore. Un id che non torna indietro
 *   non è «senza consenso»: è non verificabile, e blocca lo stesso.
 */
export async function verificaConsensoSito(
  supabase: Db,
  ids: string[],
  sedi: string[],
): Promise<EsitoConsensoSito> {
  const unici = [...new Set(ids)]
  if (unici.length === 0) return { esito: 'ok' }
  // Nessuna sede risolta ⇒ non si può verificare niente. Il motivo è già a log
  // in `resolveScuoleAttive` (warn `sedi-attive-non-accessibili`).
  if (sedi.length === 0) return { esito: 'non-verificabile' }

  const { data: rows, error } = await supabase
    .from('alunni')
    .select(`id, nome, cognome, ${COLONNA_CONSENSO_SITO}`)
    .in('id', unici)
    .in('scuola_id', sedi)

  // PostgREST non lancia: ritorna `{ error }`. Su un ambiente non migrato la
  // colonna non esiste (`42703`) e senza questo controllo l'assenza si
  // travestirebbe da «nessun consenso trovato» — fail-closed sì, ma MUTO.
  // Configurazione mancante = livello `error`, mai `info`.
  if (error) {
    logEvento('news', 'error', {
      operazione: 'verificaConsensoSito',
      esito: 'lettura-consensi-fallita',
      // Solo il conteggio: gli id sono di minori e non servono a diagnosticare.
      dichiarati: unici.length,
      error_code: (error as { code?: string }).code ?? null,
    }, error)
    return { esito: 'non-verificabile' }
  }

  const list = (rows ?? []) as Array<Record<string, unknown>>
  const perId = new Map(list.map((r) => [String(r.id), r]))
  const bambini: { id: string; nome: string }[] = []
  for (const id of unici) {
    const r = perId.get(id)
    if (!r) {
      // Fuori dalle proprie sedi, o inesistente: non verificabile → blocca.
      bambini.push({ id, nome: id })
      continue
    }
    if (r[COLONNA_CONSENSO_SITO] !== true) {
      bambini.push({ id, nome: `${r.nome ?? ''} ${r.cognome ?? ''}`.trim() || id })
    }
  }
  return bambini.length > 0 ? { esito: 'bloccato', bambini } : { esito: 'ok' }
}
