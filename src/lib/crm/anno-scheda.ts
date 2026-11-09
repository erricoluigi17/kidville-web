import { NextResponse, type NextRequest } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { caricaCalendario, statoCalendario } from '@/lib/anno/calendario'
import { guastoAnno } from '@/lib/anno/lettura'
import { schemaAnnoIndietro } from '@/lib/anno/schema'
import type { EsitoAnno } from '@/lib/anno/tipi'
import { resolveAnnoScrittura } from '@/lib/auth/scope'
import type { AppUser } from '@/lib/auth/require-staff'
import { logEvento } from '@/lib/logging/logger'
import { rispostaErroreDb } from './errori'
import { annoDellaScheda, annoIngressoDaAnno } from './quota-anno'
import type { AnnoIngresso } from './tipi'

/**
 * CRM · L'ANNO DELLA SCHEDA (compito 4.5.9), la parte che legge e scrive il database.
 *
 * Dalla PR 4.5 una scheda dichiara il SUO anno con `crm_bambini.anno_id` (un `anni_scolastici.id`, quello che la sede ha nel suo
 * calendario), e la quota d'iscrizione lo segue: non dipende più da «oggi». Due cose:
 *
 *  · `annoDiQuotaDellaScheda` — per la route della quota: legge `anno_id` del bambino e lo traduce nell'anno d'apertura (2027 per il
 *    2027/28) con il calendario della sede. `null` = la scheda non ha un anno che la sede conosca, e la route ricade sul vecchio
 *    calcolo dall'etichetta `anno_ingresso`, com'è sempre stato;
 *  · `risolviAnnoScelto` — per le route che SCRIVONO la scheda e ricevono un `annoId`: lo controlla (è un anno della sede? non è
 *    `chiuso`?), chiede a `resolveAnnoScrittura` il gettone se serve, e dà i tre valori da scrivere INSIEME (`anno_id`,
 *    `anno_ingresso`, `quota_anno`): se se ne scrivesse uno solo, il trigger `crm_bambini_anno_da_etichetta` ricalcolerebbe l'anno
 *    dall'altro, e due scritture separate lo farebbero scattare due volte.
 *
 * Sul database senza lo schema dell'anno (la CI non è migrata) non c'è niente da fare: l'`annoId` è ignorato con un log `info` e la
 * route scrive come prima. Nei log solo uuid e codici.
 */

export type AnnoSceltoScheda = {
  /** `anni_scolastici.id`, in forma canonica. */
  annoId: string
  /** L'anno d'apertura: 2027 per il 2027/28. */
  annoInizio: number
  /** L'etichetta relativa coerente con l'anno scelto, per le schede e le viste che la leggono ancora. */
  annoIngresso: Exclude<AnnoIngresso, 'non_indicato'>
  /** L'esito di `resolveAnnoScrittura`: porta il gettone, se l'anno lo chiede (agosto). */
  esito: EsitoAnno
}

/** I tre valori da scrivere insieme su `crm_bambini` per l'anno scelto. */
export function valoriAnnoScelto(s: AnnoSceltoScheda): { anno_id: string; anno_ingresso: AnnoSceltoScheda['annoIngresso']; quota_anno: number } {
  return { anno_id: s.annoId, anno_ingresso: s.annoIngresso, quota_anno: s.annoInizio }
}

const rifiutoNonDellaSede = () =>
  NextResponse.json({ error: 'L’anno scelto non è di questa sede.', codice: 'ANNO_NON_DELLA_SEDE' }, { status: 422 })
const rifiutoChiuso = () =>
  NextResponse.json({ error: 'L’anno scelto è chiuso: non si possono più aggiungere schede.', codice: 'ANNO_CHIUSO' }, { status: 422 })

/**
 * Controlla un `annoId` ricevuto da una route che scrive la scheda. Torna l'anno scelto, oppure `{ schemaIndietro: true }` (database
 * non migrato: si scrive come prima), oppure la risposta pronta: 422 `ANNO_NON_DELLA_SEDE` (l'anno non è della sede della scheda),
 * 422 `ANNO_CHIUSO` (un anno chiuso non riceve schede nuove), o gli errori di `resolveAnnoScrittura`.
 */
export async function risolviAnnoScelto(
  request: NextRequest,
  supabase: SupabaseClient,
  user: AppUser,
  scuolaId: string,
  annoId: string,
  operazione: string,
): Promise<AnnoSceltoScheda | { schemaIndietro: true } | NextResponse> {
  const calendario = await caricaCalendario(supabase, scuolaId)
  if (!calendario) {
    if ((await statoCalendario(supabase, scuolaId)) === 'non_disponibile') {
      logEvento('anno-scolastico', 'info', { tipo: 'crm-anno-scelto-ignorato', operazione, scuola_id: scuolaId })
      return { schemaIndietro: true }
    }
    // Il calendario esiste ma non si è potuto leggere: scrivere con l'etichetta metterebbe la scheda in un anno che nessuno ha scelto.
    return guastoAnno(operazione, new Error('calendario-non-letto'))
  }

  const cercato = annoId.toLowerCase()
  const riga = calendario.find((r) => r.annoId.toLowerCase() === cercato)
  if (!riga) {
    logEvento('anno-scolastico', 'warn', {
      tipo: 'crm-anno-non-della-sede', operazione, error_code: 'ANNO_NON_DELLA_SEDE', utente: user.id, scuola_id: scuolaId,
    })
    return rifiutoNonDellaSede()
  }
  if (riga.stato === 'chiuso') {
    logEvento('anno-scolastico', 'warn', {
      tipo: 'crm-anno-chiuso', operazione, error_code: 'ANNO_CHIUSO', utente: user.id, scuola_id: scuolaId,
    })
    return rifiutoChiuso()
  }

  // Gli stati e il gettone li decide l'unico posto che li conosce (`in_chiusura` chiede il gettone «agosto»).
  const esito = await resolveAnnoScrittura(request, supabase, user, scuolaId, { dichiarato: riga.annoId, usi: 1 })
  if (esito instanceof NextResponse) return esito
  if (esito.schemaIndietro) return { schemaIndietro: true }

  return { annoId: riga.annoId, annoInizio: riga.annoInizio, annoIngresso: annoIngressoDaAnno(riga, calendario), esito }
}

/**
 * L'anno d'apertura della scheda di un bambino, letto da `crm_bambini.anno_id` e dal calendario della sede: `{ anno }` con il
 * numero, oppure `{ anno: null }` quando la scheda non ha un anno che la sede conosca (o lo schema dell'anno non c'è): chi chiama
 * ricade sul calcolo dall'etichetta. Un guasto vero della lettura è la risposta d'errore pronta.
 */
export async function annoDiQuotaDellaScheda(
  supabase: SupabaseClient,
  scuolaId: string,
  bambinoId: string,
  operazione: string,
): Promise<{ anno: number | null } | { response: NextResponse }> {
  const { data, error } = await supabase
    .from('crm_bambini')
    .select('anno_id')
    .eq('id', bambinoId)
    .eq('scuola_id', scuolaId)
    .maybeSingle()
  if (error) {
    if (schemaAnnoIndietro(error)) {
      logEvento('anno-scolastico', 'info', { tipo: 'crm-anno-scheda-schema-indietro', operazione, scuola_id: scuolaId })
      return { anno: null }
    }
    return { response: rispostaErroreDb(error, operazione) }
  }
  const annoId = (data as { anno_id?: unknown } | null)?.anno_id
  if (typeof annoId !== 'string' || annoId === '') return { anno: null }

  const anno = annoDellaScheda(annoId, await caricaCalendario(supabase, scuolaId))
  if (anno === null) {
    logEvento('anno-scolastico', 'info', { tipo: 'crm-anno-scheda-non-nel-calendario', operazione, scuola_id: scuolaId })
  }
  return { anno }
}
