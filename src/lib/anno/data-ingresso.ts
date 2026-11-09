import type { SupabaseClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import { logEvento } from '@/lib/logging/logger'
import { annoAttivoDiSede } from '@/lib/anno/frequenze'
import { erroreAnno } from '@/lib/anno/errori'
import { schemaAnnoIndietro } from '@/lib/anno/schema'
import { dataCivile } from '@/i18n/config'

/**
 * LA REGOLA DELLA DATA D'ISCRIZIONE (consegna 8 della PR 4.1, Ruling I3) — UN SOLO POSTO, per il POST e per il PATCH di
 * `admin/students`.
 *
 * La data di iscrizione scelta passa sulla frequenza dell'anno attivo della sede (`data_ingresso`). Fuori dal periodo di
 * quell'anno il database direbbe `ANNO_NON_COERENTE` (422): lo si dice PRIMA di scrivere, perché una scheda cambiata a
 * metà non si può "annullare" da qui.
 *  - DOPO la fine dell'anno attivo → 422 `ANNO_NON_COERENTE`, niente si scrive;
 *  - PRIMA del suo inizio → accettata: `alunni.data_iscrizione` resta quella scritta e la frequenza riceve
 *    `data_ingresso` = inizio dell'anno (come il riempimento: chi c'era già entra il primo giorno);
 *  - dentro l'anno → `data_ingresso` è la data scelta.
 * Schema indietro (il DB della CI) o sede senza anno attivo → `dataIngresso: null`, `annoSedeId: null`: si scrive solo
 * `alunni`. Un periodo che non si riesce a leggere non blocca la scrittura (warn col solo codice): la regola decide solo
 * il caso certo.
 *
 * PR 4.5.11 · UNA DATA FUTURA È UN AVVISO, NON UN ERRORE. Se la data d'ingresso (dopo l'adattamento all'inizio dell'anno) cade DOPO
 * oggi (giorno di Roma) ma dentro l'anno, la scheda si salva comunque e la risposta porta `avviso: 'data-ingresso-futura'`: da quel
 * giorno il bambino comparirà alla famiglia e negli elenchi, non prima. Il log è `info` e non porta la data.
 */
export const AVVISO_DATA_INGRESSO_FUTURA = 'data-ingresso-futura' as const

export type EsitoDataIngresso =
  | { ok: true; dataIngresso: string | null; annoSedeId: string | null; avviso: typeof AVVISO_DATA_INGRESSO_FUTURA | null }
  | { ok: false; response: NextResponse }

export async function risolviDataIngresso(
  supabase: SupabaseClient,
  { scuolaId, dataIscrizione, operazione, oggi = dataCivile() }: {
    scuolaId: string | null | undefined
    dataIscrizione: unknown
    operazione: string
    /** Il giorno di Roma (`YYYY-MM-DD`); si passa solo nelle prove. */
    oggi?: string
  },
): Promise<EsitoDataIngresso> {
  let dataIngresso =
    typeof dataIscrizione === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dataIscrizione) ? dataIscrizione : null
  const annoSedeId = dataIngresso ? await annoAttivoDiSede(supabase, scuolaId) : null
  if (dataIngresso && annoSedeId) {
    const periodo = await supabase.from('anni_sede').select('inizio, fine').eq('id', annoSedeId).maybeSingle()
    if (periodo.error) {
      logEvento('anno-scolastico', 'warn', {
        tipo: 'periodo-anno-non-letto',
        error_code: (periodo.error as { code?: string }).code ?? null,
        operazione,
      })
    } else if (periodo.data) {
      const { inizio, fine } = periodo.data as { inizio: string; fine: string }
      if (dataIngresso < inizio) {
        dataIngresso = inizio
      } else if (dataIngresso > fine) {
        logEvento('anno-scolastico', 'warn', { tipo: 'data-ingresso-fuori-anno', error_code: 'ANNO_NON_COERENTE', operazione })
        return { ok: false, response: erroreAnno({ message: 'ANNO_NON_COERENTE' }, operazione) as NextResponse }
      }
    }
  }
  // Futura solo se la scheda ha davvero una frequenza dove scrivere la data: senza anno attivo (o schema indietro) non c'è niente da avvisare.
  const futura = Boolean(dataIngresso && annoSedeId && dataIngresso > oggi)
  if (futura) logEvento('anno-scolastico', 'info', { tipo: AVVISO_DATA_INGRESSO_FUTURA, operazione })
  return { ok: true, dataIngresso, annoSedeId, avviso: futura ? AVVISO_DATA_INGRESSO_FUTURA : null }
}

/**
 * PR 4.5.11 · «L'ISCRIZIONE COMINCIA IL …» — la data d'ingresso futura di una famiglia che non ha ancora nessun figlio attivo.
 *
 * Le frequenze non sono leggibili dal browser: la lettura passa dal server (`GET /api/parent/students`) e ne esce la sola data.
 * Si guardano le frequenze VIVE (`in_attesa`, `iscritto`) con `data_ingresso` dopo oggi (giorno di Roma) in QUALUNQUE anno non
 * ancora cominciato, non solo nell'anno attivo: la famiglia nuova che arriva l'anno prossimo ha la frequenza nel 2027/28.
 *
 * `data` è valorizzata solo se OGNI figlio collegato ha una frequenza così, oppure è uscito (ritirato o archiviato, giro 2): se uno è fermo
 * per un'altra ragione la frase «comincia il …» direbbe il falso, e si ripiega sul pannello di sempre. È la data più vicina fra i figli.
 *  · `indietro` = il database non ha lo schema dell'anno (la CI): comportamento di oggi, riga `info`;
 *  · `guasto` = ogni altro errore, e anche un'eccezione: il chiamante NON deve dire né «comincia il …» né «nessuna iscrizione».
 */
export type EsitoIngressoFuturo =
  | { stato: 'ok'; data: string | null }
  | { stato: 'indietro' }
  | { stato: 'guasto' }

export async function ingressoFuturoDeiFigli(
  supabase: SupabaseClient,
  alunni: readonly string[],
  { oggi = dataCivile() }: { oggi?: string } = {},
): Promise<EsitoIngressoFuturo> {
  if (alunni.length === 0) return { stato: 'ok', data: null }
  try {
    const { data, error } = await supabase
      .from('frequenze')
      .select('alunno_id, data_ingresso')
      .in('alunno_id', [...alunni])
      .in('stato', ['in_attesa', 'iscritto'])
      .gt('data_ingresso', oggi)
    if (error) {
      const codice = (error as { code?: string }).code ?? null
      if (schemaAnnoIndietro(error)) {
        logEvento('anno-scolastico', 'info', { tipo: 'ingresso-futuro-schema-indietro', error_code: codice })
        return { stato: 'indietro' }
      }
      logEvento('anno-scolastico', 'warn', { tipo: 'ingresso-futuro-non-letto', error_code: codice }, error)
      return { stato: 'guasto' }
    }
    const primaPerFiglio = new Map<string, string>()
    for (const r of (data ?? []) as { alunno_id: string; data_ingresso: string }[]) {
      if (typeof r.alunno_id !== 'string' || typeof r.data_ingresso !== 'string') continue
      const gia = primaPerFiglio.get(r.alunno_id)
      if (!gia || r.data_ingresso < gia) primaPerFiglio.set(r.alunno_id, r.data_ingresso)
    }
    if (primaPerFiglio.size === 0) return { stato: 'ok', data: null }
    // (giro 2, B3) I fratelli. Un figlio senza ingresso futuro ammesso se è USCITO (ritirato o archiviato: il passaggio d'anno, o un ritiro):
    // la famiglia che ha un figlio uscito e uno nuovo legge l'ingresso del nuovo, non «nessuna iscrizione attiva». Se invece l'altro figlio
    // è fermo per un'altra ragione (aspetta la classe, per esempio) la frase direbbe il falso: si ripiega sul pannello di sempre.
    const senza = alunni.filter((id) => !primaPerFiglio.has(id))
    if (senza.length > 0) {
      const { data: schede, error: errScheda } = await supabase.from('alunni').select('id, stato, archiviato_il').in('id', senza)
      if (errScheda) {
        logEvento('anno-scolastico', 'warn', { tipo: 'ingresso-futuro-non-letto', error_code: (errScheda as { code?: string }).code ?? null }, errScheda)
        return { stato: 'guasto' }
      }
      const uscito = (r: { stato?: string | null; archiviato_il?: string | null }) => r.archiviato_il != null || r.stato === 'ritirato'
      const lette = (schede ?? []) as { id: string; stato?: string | null; archiviato_il?: string | null }[]
      if (lette.length !== senza.length || !lette.every(uscito)) return { stato: 'ok', data: null }
    }
    return { stato: 'ok', data: [...primaPerFiglio.values()].sort()[0] ?? null }
  } catch (err) {
    logEvento('anno-scolastico', 'warn', { tipo: 'ingresso-futuro-non-letto' }, err)
    return { stato: 'guasto' }
  }
}
