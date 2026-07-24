import type { SupabaseClient } from '@supabase/supabase-js'
import { patchAlunno, patchParent, scrubSuggerimenti } from '@/lib/gdpr/anonimizza'
import { schemaAssente } from '@/lib/news/schema-assente'
import { logErrore } from '@/lib/logging/logger'

// =============================================================================
// Esecuzione dell'oblio, PER SINGOLA ENTITÀ e riusabile.
//
// La route admin/gdpr/erase (diritto all'oblio classico, alunno-centrica) è
// LOCKATA dal suo test e resta invariata. Questo modulo estrae le stesse
// operazioni — ma per un SINGOLO genitore e per un SINGOLO alunno — così il
// nuovo flusso "richiesta di cancellazione avviata dal genitore" può riusarle
// senza duplicare la logica di bonifica finanziaria né toccare la route esistente.
//
// Tutte le funzioni sono best-effort: loggano ogni ramo che fallisce (mai un
// catch muto), degradano in silenzio quando lo schema è assente (DB E2E CI non
// migrato) e NON mettono PII nei log (solo conteggi/uuid).
// =============================================================================

/** Riga alunno minima necessaria all'anonimizzazione + bonifica finanziaria. */
export interface AlunnoOblio {
  id: string
  documento_path?: string | null
  codice_fiscale?: string | null
  fiscal_code?: string | null
}

/**
 * Anonimizza UN genitore: raccoglie l'`auth_user_id` PRIMA di `patchParent`
 * (che lo azzera), applica il patch PII e cancella il tracciamento di lettura
 * news legato a quell'identità (altrimenti resterebbe joinabile a tempo
 * indefinito). Ritorna il numero di righe `news_visualizzazioni` rimosse.
 */
export async function anonimizzaParent(
  supabase: SupabaseClient,
  parentId: string,
  at: string,
  op: string,
): Promise<{ newsVisualizzazioniRimosse: number }> {
  // 1. Raccogli l'auth_user_id prima dell'azzeramento.
  const { data: pRow, error: errP } = await supabase
    .from('parents')
    .select('auth_user_id')
    .eq('id', parentId)
    .maybeSingle()
  if (errP && !schemaAssente(errP)) logErrore({ operazione: op, evento: 'raccolta_auth_parent' }, errP)
  const authUserId = (pRow?.auth_user_id as string | null) ?? null

  // 2. Anonimizza il genitore (sgancia anche il login: auth_user_id → null).
  const { error: errU } = await supabase.from('parents').update(patchParent(parentId, at)).eq('id', parentId)
  if (errU) logErrore({ operazione: op, evento: 'patch_parent' }, errU)

  // 3. Oblio del tracciamento di lettura news per quell'identità.
  let newsVisualizzazioniRimosse = 0
  if (authUserId) {
    const { data: visDel, error: errVis } = await supabase
      .from('news_visualizzazioni')
      .delete()
      .in('utente_id', [authUserId])
      .select('post_id')
    if (errVis) {
      if (!schemaAssente(errVis)) logErrore({ operazione: op, evento: 'oblio_news_visualizzazioni' }, errVis)
    } else {
      newsVisualizzazioniRimosse = (visDel ?? []).length
    }
  }
  return { newsVisualizzazioniRimosse }
}

/**
 * Anonimizza UN alunno + bonifica i suoi dati finanziari collegati
 * (riconciliazione/incassi/cassa), con la stessa logica del diritto all'oblio
 * admin (causale/controparte/`suggerimenti.label` e testo libero di cassa che
 * potrebbero contenere CF/nome del minore). Il chiamante decide se l'alunno è
 * eleggibile (es. NON iscritto): qui non c'è alcun gate di stato.
 */
export async function anonimizzaAlunno(
  supabase: SupabaseClient,
  alunno: AlunnoOblio,
  at: string,
  op: string,
): Promise<{ riconciliazione: number; incassi: number; cassa: number; file: number }> {
  // 1. Anonimizza l'anagrafica dell'alunno.
  const { error: e1 } = await supabase.from('alunni').update(patchAlunno(alunno.id, at)).eq('id', alunno.id)
  if (e1) logErrore({ operazione: op, evento: 'patch_alunno' }, e1)

  const cf = [alunno.codice_fiscale, alunno.fiscal_code]
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .find((v) => v.length > 0) ?? ''

  let riconciliazione = 0
  let incassi = 0
  let cassa = 0

  // Pagamenti dell'alunno (l'aggancio movimento→alunno passa dal pagamento).
  const { data: pagRows, error: errPag } = await supabase.from('pagamenti').select('id').eq('alunno_id', alunno.id)
  if (errPag) logErrore({ operazione: op, evento: 'bonifica_pagamenti' }, errPag)
  const pagIds = ((pagRows ?? []) as { id: string }[]).map((p) => p.id)

  if (pagIds.length > 0) {
    // 3a. Movimenti CONFERMATI collegati → azzera causale/controparte + scrub label.
    const { data: movConf, error: errMovSel } = await supabase
      .from('riconciliazione_movimenti')
      .select('id, suggerimenti')
      .in('pagamento_id', pagIds)
      .eq('stato', 'confermato')
    if (errMovSel) logErrore({ operazione: op, evento: 'bonifica_riconciliazione_select' }, errMovSel)
    for (const m of (movConf ?? []) as { id: string; suggerimenti: unknown }[]) {
      const { error: errU } = await supabase
        .from('riconciliazione_movimenti')
        .update({ causale: null, controparte: null, suggerimenti: scrubSuggerimenti(m.suggerimenti) })
        .eq('id', m.id)
      if (errU) logErrore({ operazione: op, evento: 'bonifica_riconciliazione_update' }, errU)
      else riconciliazione++
    }

    // 3b. Incassi generati dalla riconciliazione (nota «Riconciliazione: …») → azzera la nota.
    const { data: incBon, error: errInc } = await supabase
      .from('incassi')
      .update({ note: null })
      .in('pagamento_id', pagIds)
      .ilike('note', 'Riconciliazione:%')
      .select('id')
    if (errInc) logErrore({ operazione: op, evento: 'bonifica_incassi' }, errInc)
    else incassi = (incBon ?? []).length
  }

  // 3c. Movimenti NON confermati la cui causale cita il CF (alfanumerico puro).
  if (cf) {
    const { data: movCf, error: errMovCf } = await supabase
      .from('riconciliazione_movimenti')
      .update({ causale: null, controparte: null })
      .neq('stato', 'confermato')
      .ilike('causale', `%${cf}%`)
      .select('id')
    if (errMovCf) logErrore({ operazione: op, evento: 'bonifica_riconciliazione_cf' }, errMovCf)
    else riconciliazione += (movCf ?? []).length
  }

  // 3d. Movimenti NON confermati agganciati all'alunno via `suggerimenti.pagamento_id`.
  if (pagIds.length > 0) {
    const pagSet = new Set(pagIds)
    const { data: movNc, error: errNcSel } = await supabase
      .from('riconciliazione_movimenti')
      .select('id, suggerimenti')
      .neq('stato', 'confermato')
    if (errNcSel) logErrore({ operazione: op, evento: 'bonifica_riconciliazione_nonconf_select' }, errNcSel)
    for (const m of (movNc ?? []) as { id: string; suggerimenti: unknown }[]) {
      const sugg = Array.isArray(m.suggerimenti) ? (m.suggerimenti as Record<string, unknown>[]) : []
      const riferito = sugg.some(
        (s) => s && typeof s === 'object' && pagSet.has(String((s as { pagamento_id?: unknown }).pagamento_id)),
      )
      if (!riferito) continue
      const { error: errU } = await supabase
        .from('riconciliazione_movimenti')
        .update({ causale: null, controparte: null, suggerimenti: scrubSuggerimenti(m.suggerimenti) })
        .eq('id', m.id)
      if (errU) logErrore({ operazione: op, evento: 'bonifica_riconciliazione_nonconf_update' }, errU)
      else riconciliazione++
    }
  }

  // 3e. Testo libero dei movimenti di cassa che citano il CF (cassa_movimenti
  //     NON ha alunno_id). Degrada in silenzio se lo schema cassa è assente.
  if (cf) {
    const like = `%${cf}%`
    const { data: cassaBon, error: errCassa } = await supabase
      .from('cassa_movimenti')
      .update({ descrizione: '[rimosso]', note: '[rimosso]', storno_motivo: '[rimosso]' })
      .or(`descrizione.ilike.${like},note.ilike.${like},storno_motivo.ilike.${like}`)
      .select('id')
    if (errCassa) {
      if (!schemaAssente(errCassa)) logErrore({ operazione: op, evento: 'bonifica_cassa' }, errCassa)
    } else {
      cassa = (cassaBon ?? []).length
    }
  }

  // 4. Rimuovi il file PII dell'alunno (best-effort; bucket fatture escluso a monte).
  let file = 0
  if (alunno.documento_path) {
    try {
      await supabase.storage.from('form_attachments').remove([String(alunno.documento_path)])
      file = 1
    } catch {
      /* file già assente o bucket diverso: ignora (best-effort) */
    }
  }

  return { riconciliazione, incassi, cassa, file }
}
