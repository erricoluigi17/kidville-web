import { NextResponse, type NextRequest } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AppUser } from '@/lib/auth/require-staff'
import { resolveScuolaScrittura } from '@/lib/auth/scope'
import { isScuolaE2E } from '@/lib/scuole/reali'
import { logEvento } from '@/lib/logging/logger'

/**
 * Aiuti lato server per le route che GENERANO voci di contabilità (rette e servizi
 * mensili): la sede su cui si scrive, la traccia in `registro_modifiche` e la
 * generazione dei servizi. Stavano dentro `genera-rette/route.ts`; vivono qui perché
 * la generazione manuale dei servizi (`genera-servizi`) deve fare le STESSE cose.
 */

/**
 * LA SEDE DELLA GENERAZIONE — una sola, e la STESSA per l'anteprima e per la conferma.
 *
 * Fino al 2026-07-31 i due verbi guardavano insiemi diversi: il GET filtrava
 * `.eq('scuola_id', …)` sui candidati, il POST chiamava `genera_rette_mensili(p_periodo)`,
 * una RPC senza parametro di sede, e generava per TUTTI i plessi. Non è un rischio
 * teorico: in produzione `registro_modifiche` conserva UNA sola esecuzione
 * (`generati: 25`) e le rette risultanti stanno su DUE sedi — 21 su Giugliano e 4
 * sulla sede finta di collaudo. Un clic, due plessi.
 *
 * Perciò la sede la risolve un punto solo, con la regola delle SCRITTURE
 * (`resolveScuolaScrittura`): dichiarata dal client se accessibile, altrimenti
 * l'unica sede attiva/accessibile, altrimenti **400** — mai «ne scelgo una io».
 *
 * In più: la sede di COLLAUDO non entra nella contabilità di produzione. Le 4
 * rette emesse sulla sede E2E sono dati finti dentro il database vero, che
 * entrano nei totali e nelle liste di morosità. Il presidio è doppio — qui un 400
 * leggibile (`SEDE_DI_COLLAUDO`), e nella RPC (`schools.operativa`) il rifiuto
 * strutturale, per chi la chiamasse senza passare da questa funzione.
 */
export async function sedeDellaGenerazione(
  request: Request,
  supabase: SupabaseClient,
  user: AppUser,
  operazione: string,
  preferita?: string | null,
): Promise<{ scuolaId?: string; response?: NextResponse }> {
  const sede = await resolveScuolaScrittura(request as NextRequest, supabase, user, preferita)
  if (sede.response || !sede.scuolaId) return sede
  const scuolaId = sede.scuolaId

  // Il nome è il secondo indizio di `isScuolaE2E` (il primo è il prefisso
  // dell'uuid). PostgREST non lancia: se la lettura fallisce si prosegue col
  // solo indizio dell'id — ma lo si dice, perché un predicato dimezzato in
  // silenzio è il modo in cui questi filtri smettono di funzionare.
  const { data: scuola, error } = await supabase
    .from('schools')
    .select('id, nome')
    .eq('id', scuolaId)
    .maybeSingle()
  if (error) {
    logEvento('pagamento', 'error', { operazione, esito: 'sede-non-riletta', scuola_id: scuolaId }, error)
  }
  const nome = (scuola as { nome?: string | null } | null)?.nome ?? ''
  if (isScuolaE2E({ id: scuolaId, nome })) {
    logEvento('pagamento', 'warn', {
      operazione, tipo: 'sede-collaudo', esito: 'generazione-rifiutata',
      utente: user.id, ruolo: user.role, scuola_id: scuolaId,
    })
    return {
      response: NextResponse.json(
        { error: 'Sede di collaudo: la generazione non è consentita', codice: 'SEDE_DI_COLLAUDO' },
        { status: 400 },
      ),
    }
  }
  return { scuolaId }
}

/** Traccia in `registro_modifiche` chi ha generato, quando e SU QUALE SEDE.
 *  Best-effort — non fa fallire la generazione — ma mai muta: `.then(() => {}, () => {})`
 *  scartava sia l'esito sia il rifiuto, e PostgREST NON lancia (l'errore torna
 *  dentro il risultato). Senza questa riga, «l'audit non è stato scritto» era
 *  indistinguibile da «è stato scritto». */
export async function tracciaAuditGenerazione(
  supabase: SupabaseClient,
  operazione: string,
  azione: string,
  nuovoValore: Record<string, unknown>,
  utenteId: string,
): Promise<void> {
  const { error } = await supabase.from('registro_modifiche').insert({
    azione,
    tabella_interessata: 'pagamenti',
    record_id: null,
    nuovo_valore: nuovoValore,
    utente_id: utenteId,
  })
  if (error) {
    logEvento('pagamento', 'error', { operazione, azione, esito: 'audit-non-scritto' }, error)
  }
}

export type EsitoServizi =
  | { ok: true; generati: number }
  | { ok: false; codice: 'SERVIZI_NON_GENERATI' | 'SERVIZI_NON_DISPONIBILI' }

export interface ParametriServizi {
  /** Primo del mese, `YYYY-MM-01`. Alternativo ad `anno`. */
  periodo?: string
  /** Anno di inizio dell'anno scolastico (set → giu). Alternativo a `periodo`. */
  anno?: number
  scuolaId: string
  /** `null`/assente = tutti gli iscritti della sede (mai un array vuoto). */
  alunnoIds?: string[] | null
  utenteId: string
  operazione: string
  /** Da dove nasce la generazione: insieme alle rette o a mano. Finisce nell'audit. */
  azione: 'rette' | 'manuale'
}

/** Funzione assente dallo schema: PostgREST PGRST202, Postgres 42883 (DB non migrato). */
function funzioneAssente(error: { code?: string | null }): boolean {
  return error.code === 'PGRST202' || error.code === '42883'
}

/**
 * Genera le voci dei SERVIZI MENSILI dei bambini iscritti nel periodo (o nell'anno).
 *
 * Non lancia mai e non fa mai crollare chi la chiama: se i servizi non si generano,
 * le rette appena scritte restano scritte e il guasto sta nell'esito e nel log `error`.
 * Il try/catch è QUI e non nel chiamante perché PostgREST non lancia ma `rpc()` di un
 * client finto, o una rete caduta, sì — e un servizio accessorio non deve poter
 * trasformare in 500 una generazione di rette riuscita.
 *
 * Funzione SQL assente (DB non ancora migrato, come quello degli E2E in CI):
 * `SERVIZI_NON_DISPONIBILI`, distinto da un guasto vero.
 */
export async function generaServizi(
  supabase: SupabaseClient,
  p: ParametriServizi,
): Promise<EsitoServizi> {
  const mensile = p.anno == null
  const funzione = mensile ? 'genera_servizi_mensili' : 'genera_servizi_anno'
  const args = mensile
    ? { p_periodo: p.periodo, p_scuola_id: p.scuolaId, p_alunno_ids: p.alunnoIds ?? null }
    : { p_anno_inizio: p.anno, p_scuola_id: p.scuolaId, p_alunno_ids: p.alunnoIds ?? null }

  let data: unknown
  try {
    const r = await supabase.rpc(funzione, args)
    if (r.error) {
      const assente = funzioneAssente(r.error)
      logEvento('pagamento', 'error', {
        operazione: p.operazione,
        esito: assente ? 'servizi-non-disponibili' : 'servizi-non-generati',
        tipo: funzione, scuola_id: p.scuolaId, azione: p.azione,
        ...(mensile ? { periodo: p.periodo } : { anno: p.anno }),
      }, r.error)
      return { ok: false, codice: assente ? 'SERVIZI_NON_DISPONIBILI' : 'SERVIZI_NON_GENERATI' }
    }
    data = r.data
  } catch (e) {
    logEvento('pagamento', 'error', {
      operazione: p.operazione, esito: 'servizi-non-generati',
      tipo: funzione, scuola_id: p.scuolaId, azione: p.azione,
      ...(mensile ? { periodo: p.periodo } : { anno: p.anno }),
    }, e)
    return { ok: false, codice: 'SERVIZI_NON_GENERATI' }
  }

  const generati = Number(data ?? 0)
  // L'audit è best-effort: un audit non scritto lo logga e non fa fallire.
  try {
    await tracciaAuditGenerazione(
      supabase, p.operazione, mensile ? 'genera_servizi' : 'genera_servizi_anno',
      {
        ...(mensile ? { periodo: p.periodo } : { anno_inizio: p.anno }),
        generati, scuola_id: p.scuolaId, azione: p.azione,
      },
      p.utenteId,
    )
  } catch (e) {
    logEvento('pagamento', 'error', {
      operazione: p.operazione, esito: 'audit-non-scritto', scuola_id: p.scuolaId,
    }, e)
  }
  // Un evento contabile va visto anche quando non fa niente: con 0 voci,
  // «nessun log» non distingue «nessun servizio dovuto» da «non è mai partito».
  logEvento('pagamento', 'info', {
    operazione: p.operazione, esito: 'servizi-generati',
    ...(mensile ? { periodo: p.periodo } : { anno: p.anno }),
    generati, scuola_id: p.scuolaId, azione: p.azione,
  })
  return { ok: true, generati }
}
