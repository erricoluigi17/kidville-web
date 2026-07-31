import type { SupabaseClient } from '@supabase/supabase-js'
import { schemaAssente } from '@/lib/news/schema-assente'
import { logEvento, logErrore } from '@/lib/logging/logger'

// =============================================================================
// La SEDE di una richiesta di cancellazione account (W1).
//
// PERCHÉ ESISTE. Fino al 2026-07-31 i due canali dell'oblio self-service — quello
// in-app (`parent/account/richiesta-cancellazione`) e quello pubblico via
// magic-link (`public/cancellazione-account/conferma`) — scrivevano
// `richieste_cancellazione.scuola_id` così:
//
//     auth.user.scuola_id ?? await scuolaUnicaReale(admin)
//
// e `scuolaUnicaReale` è DEPRECATA: da quando le sedi reali sono tre risponde
// sempre `null`. Il ripiego, cioè, non ripiega più: produce `NULL`.
//
// Una richiesta con `scuola_id NULL` non è un dettaglio cosmetico, è un DIRITTO
// BLOCCATO:
//   · il GET della Direzione filtra `.in('scuola_id', plessi)` e i NULL non
//     rientrano in nessun `IN`: la richiesta non compare in nessun pannello;
//   · la POST di evasione nega esplicitamente la sede nulla (403), e deve farlo:
//     l'anonimizzazione è irreversibile e senza plesso non si sa chi è competente;
//   · l'indice unico parziale su `stato='pending'` impedisce di ripresentarla.
// Risultato: il genitore vede per sempre «richiesta in corso» e nessuno la vede
// mai. Il fallimento è totale e silenzioso.
//
// LA REGOLA. La sede si ricava dal DATO che ce l'ha davvero — i FIGLI del
// genitore — non da «quante sedi esistono». È la stessa derivazione già usata da
// `assertParentInScope` e dalla tab «Genitori» di `admin/parents`: `parents` non
// ha `scuola_id` e non deve averlo, perché un genitore può legittimamente avere
// figli in due plessi.
//
// QUANDO NON SI RIESCE, SI DICHIARA. Nessun ritorno «null implicito»: chi non
// riesce a stabilire la sede riceve `{ scuolaId: null, motivo }` e deve
// rifiutare la richiesta con un errore leggibile. Meglio un genitore che legge
// «non è stato possibile registrare la richiesta, contatta la segreteria» di un
// genitore che crede di aver esercitato un diritto che nessuno vedrà mai.
// =============================================================================

/** Sede risolta, con le sedi dei figli da cui è stata dedotta (per l'osservabilità). */
export interface SedeRisolta {
  scuolaId: string
  sedi: string[]
}

/** Sede NON risolta: `lettura` = guasto del database, `indeterminabile` = nessun dato. */
export interface SedeNonRisolta {
  scuolaId: null
  motivo: 'indeterminabile' | 'lettura'
  sedi: string[]
}

export type EsitoSede = SedeRisolta | SedeNonRisolta

/**
 * Risolve la sede da attribuire a una richiesta di cancellazione.
 *
 * Ordine di preferenza:
 *  1. `preferita` (la sede dell'identità del genitore) **se** è una delle sedi in
 *     cui stanno i suoi figli — è insieme il dato dichiarato e quello vero;
 *  2. altrimenti una sede dei FIGLI, scelta in modo DETERMINISTICO (ordine
 *     crescente dell'uuid) così che due invii identici non finiscano in plessi
 *     diversi. Se i figli sono in più sedi la scelta è per forza parziale: la
 *     riga resta una sola (l'indice unico parziale su `pending` non ne ammette
 *     due), e l'evasione dichiara i figli rimasti fuori dal proprio scope —
 *     vedi `admin/gdpr/richieste`. Qui si lascia una riga di log persistita
 *     perché quel caso non passi inosservato;
 *  3. altrimenti `preferita` da sola (genitore senza figli collegati: ha comunque
 *     diritto a cancellare il proprio account);
 *  4. altrimenti si dichiara `indeterminabile`.
 *
 * PostgREST non lancia: si controlla `{ error }`. Uno schema assente (DB E2E
 * della CI non migrato) degrada su `preferita`; un errore inatteso NON viene
 * confuso con «nessun figlio» — sarebbe un oblio negato per un guasto passeggero
 * senza che nessuno lo sappia — ma torna col motivo `lettura`.
 *
 * Non lancia mai: un guasto qui non deve trasformarsi in un 500 su una pagina
 * del profilo del genitore.
 */
export async function risolviSedeRichiestaCancellazione(
  admin: SupabaseClient,
  parentId: string,
  preferita: string | null | undefined,
  operazione: string,
): Promise<EsitoSede> {
  const sedePropria = typeof preferita === 'string' && preferita.trim() ? preferita : null
  if (!parentId) return { scuolaId: null, motivo: 'indeterminabile', sedi: [] }

  let sedi: string[] = []
  try {
    // Una query sola, stessa forma di `assertParentInScope`: il legame porta con
    // sé la sede del minore via embed `!inner` (un legame senza alunno non serve).
    const { data, error } = await admin
      .from('student_parents')
      .select('student_id, alunni!inner(scuola_id)')
      .eq('parent_id', parentId)
    if (error) {
      if (!schemaAssente(error)) {
        logErrore({ operazione, evento: 'sede_richiesta_non_risolta' }, error)
        return { scuolaId: null, motivo: 'lettura', sedi: [] }
      }
      // Schema assente: nessun figlio conoscibile, si prosegue col solo `preferita`.
    } else {
      const righe = (data ?? []) as Array<{ alunni: unknown }>
      const insieme = new Set<string>()
      for (const r of righe) {
        // PostgREST rende l'embed come oggetto (relazione molti-a-uno) ma può
        // renderlo come array a seconda di come deduce la cardinalità: si
        // normalizza, altrimenti la sede si perderebbe in silenzio.
        const emb = Array.isArray(r.alunni) ? r.alunni : [r.alunni]
        for (const a of emb) {
          const sede = (a as { scuola_id?: unknown } | null)?.scuola_id
          if (typeof sede === 'string' && sede) insieme.add(sede)
        }
      }
      sedi = [...insieme].sort()
    }
  } catch (e) {
    logErrore({ operazione, evento: 'sede_richiesta_non_risolta' }, e)
    return { scuolaId: null, motivo: 'lettura', sedi: [] }
  }

  if (sedi.length > 1) {
    // Persistito (`gdpr` è in EVENTI_PERSISTITI): la richiesta di un genitore con
    // figli in più plessi va evasa a più mani, e chi la evade deve poterlo sapere.
    // Solo conteggi: nessun uuid di minore, nessuna PII.
    logEvento('gdpr', 'warn', { operazione, esito: 'sede-richiesta-multipla', n: sedi.length })
  }

  if (sedePropria && sedi.includes(sedePropria)) return { scuolaId: sedePropria, sedi }
  if (sedi.length > 0) return { scuolaId: sedi[0], sedi }
  if (sedePropria) return { scuolaId: sedePropria, sedi }
  return { scuolaId: null, motivo: 'indeterminabile', sedi }
}
