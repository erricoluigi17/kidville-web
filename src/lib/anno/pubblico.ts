import type { SupabaseClient } from '@supabase/supabase-js'
import { logEvento } from '@/lib/logging/logger'
import { formaConfronto } from '@/lib/auth/scope'
import { anniDellaSede, esitoSchemaIndietro, guastoAnno, type RigaAnnoSede } from '@/lib/anno/lettura'

// =============================================================================
// L'ANNO PER LE PORTE SENZA UTENTE (il modulo pubblico), Compito 3.2 / decisione P22.
//
// ⚠️ DUE UUID CHE NON SI SCAMBIANO.
//  · `anni_scolastici.id` — l'anno, uguale per tutte le sedi: ciò che restituisce `anno_di`, ciò che
//    `opzioni.annoId` e `AnnoPubblico.annoId` portano, ciò che si scrive in `anno_id`.
//  · `anni_sede.id` — l'anno DI UNA SEDE: ciò che restituisce `anno_attivo` e `AnnoPubblico.annoSedeId`.
// =============================================================================

export type AnnoPubblico =
  | { annoSedeId: string; annoId: string }
  | { annoSedeId: null; annoId: null; schemaIndietro: true }
  | { annoSedeId: null; annoId: null; senzaAnno: true }

const FORMA_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * L'anno per le porte SENZA utente (il modulo pubblico): l'anno `corrente` della sede, oppure
 * `opzioni.annoId` (un `anni_scolastici.id`) se la sede ce l'ha E ha `domande_aperte`. Mai un cookie,
 * mai un ruolo, mai un gettone: la funzione non riceve nemmeno `request`.
 *
 * Non rifiuta mai: la famiglia che compila il modulo non deve veder fallire l'invio per l'anno.
 * Se non c'è un `corrente` (agosto) restituisce `senzaAnno: true` con un `warn` (P18: senza, ad agosto
 * ogni domanda sarebbe archiviata senza anno e nessuno lo vedrebbe); lo stesso se la lettura fallisce
 * (lì il log `error` lo scrive `guastoAnno`). Il chiamante scrive senza `anno_id`: la riserva permanente
 * di `enrollment_submissions` lo assegna.
 */
export async function annoPerScritturaPubblica(
  supabase: SupabaseClient,
  scuolaId: string,
  opzioni: { annoId?: string } = {},
): Promise<AnnoPubblico> {
  const azione = 'annoPerScritturaPubblica'
  const anni = await anniDellaSede(supabase, scuolaId)
  if ('indietro' in anni) {
    const e = esitoSchemaIndietro(azione)
    return { annoSedeId: null, annoId: null, schemaIndietro: e.schemaIndietro as true }
  }
  if ('guasto' in anni) {
    guastoAnno(azione, anni.guasto)
    return { annoSedeId: null, annoId: null, senzaAnno: true }
  }
  let riga: RigaAnnoSede | undefined
  if (opzioni.annoId) {
    const voluto = formaConfronto(opzioni.annoId)
    riga = anni.righe.find((r) => formaConfronto(String(r.anno_id)) === voluto && r.domande_aperte === true)
  }
  if (!riga) {
    const correnti = anni.righe.filter((r) => r.stato === 'corrente')
    if (correnti.length === 1) riga = correnti[0]
  }
  if (!riga) {
    logEvento('anno-scolastico', 'warn', {
      tipo: 'anno-pubblico-senza-corrente',
      azione,
      error_code: 'ANNO_DA_SPECIFICARE',
      // la sede solo se è un uuid: passa la redazione
      scuola_id: FORMA_UUID.test(scuolaId) ? scuolaId : undefined,
    })
    return { annoSedeId: null, annoId: null, senzaAnno: true }
  }
  return { annoSedeId: riga.id, annoId: riga.anno_id }
}
