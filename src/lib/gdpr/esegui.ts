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
// Oltre alla bonifica finanziaria (riconciliazione/incassi/cassa) l'oblio scrub-a
// anche il TESTO LIBERO UGC introdotto da C5 (moderazione + sospensioni chat):
//   - segnalazioni.motivo / segnalazioni.note_gestione
//   - conversazioni_sospensioni.motivo
// Questi campi possono citare il nome di un minore o un dato sanitario (es.
// un'allergia) e non hanno FK verso utenti/alunni (denormalizzati apposta per
// sopravvivere agli altri oblii): senza questo scrub resterebbero per sempre.
// Il genitore li aggancia per segnalante/segnalato e sospendente/sospeso;
// l'alunno per l'OGGETTO segnalato (voce di diario, media, thread di chat).
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
 * (che lo azzera), applica il patch PII, cancella il tracciamento di lettura
 * news legato a quell'identità (altrimenti resterebbe joinabile a tempo
 * indefinito) e bonifica il testo libero UGC (segnalazioni + sospensioni) in
 * cui il genitore è coinvolto. Ritorna i conteggi delle righe toccate.
 */
export async function anonimizzaParent(
  supabase: SupabaseClient,
  parentId: string,
  at: string,
  op: string,
): Promise<{ newsVisualizzazioniRimosse: number; segnalazioniBonificate: number; sospensioniBonificate: number }> {
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

  // 4. Bonifica del testo libero UGC (C5) in cui il genitore è coinvolto:
  //    motivo/note_gestione possono citare il nome di un minore o un dato
  //    sanitario. Nessuna FK verso parents → serve lo scrub esplicito. Degrada
  //    se lo schema C5 è assente (DB E2E CI non migrato).
  //
  //    ⚠️ SPAZIO-ID: queste colonne NON contengono `parents.id`. Sono scritte
  //    con l'identità del gate, cioè `auth.user.id` (= `utenti.id`):
  //      - `segnalazioni.segnalante_id`  ← `segnalante.id` (api/segnalazioni:POST)
  //      - `segnalazioni.segnalato_id`   ← id utente segnalato
  //      - `conversazioni_sospensioni.sospesa_da`    ← `auth.user.id`
  //      - `conversazioni_sospensioni.sospesa_verso` ← `chat_threads.parent_id`/
  //        `teacher_id`, a loro volta confrontati con `auth.user.id` alla
  //        creazione del thread.
  //    Filtrando per `parentId` il match era impossibile: lo scrub non trovava
  //    MAI una riga e la Direzione leggeva «0 bonificate» credendo non ci fosse
  //    nulla da bonificare. Si usa quindi l'`authUserId` raccolto al punto 1 —
  //    stesso ponte già usato per `news_visualizzazioni`, e se manca si salta il
  //    ramo per la stessa ragione: senza bridge il genitore non è raggiungibile
  //    in spazio-id `utenti`.
  let segnalazioniBonificate = 0
  let sospensioniBonificate = 0
  if (authUserId) {
    const { data: segDel, error: errSeg } = await supabase
      .from('segnalazioni')
      .update({ motivo: null, note_gestione: null })
      .or(`segnalante_id.eq.${authUserId},segnalato_id.eq.${authUserId}`)
      .select('id')
    if (errSeg) {
      if (!schemaAssente(errSeg)) logErrore({ operazione: op, evento: 'oblio_segnalazioni_parent' }, errSeg)
    } else {
      segnalazioniBonificate = (segDel ?? []).length
    }

    const { data: sospDel, error: errSosp } = await supabase
      .from('conversazioni_sospensioni')
      .update({ motivo: null })
      .or(`sospesa_da.eq.${authUserId},sospesa_verso.eq.${authUserId}`)
      .select('id')
    if (errSosp) {
      if (!schemaAssente(errSosp)) logErrore({ operazione: op, evento: 'oblio_sospensioni_parent' }, errSosp)
    } else {
      sospensioniBonificate = (sospDel ?? []).length
    }
  }

  return { newsVisualizzazioniRimosse, segnalazioniBonificate, sospensioniBonificate }
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
): Promise<{
  riconciliazione: number
  incassi: number
  cassa: number
  file: number
  segnalazioniBonificate: number
  sospensioniBonificate: number
}> {
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

  // 3f. Bonifica del testo libero UGC (C5) agganciato ai CONTENUTI del minore.
  //     Le segnalazioni non hanno FK verso l'alunno: l'aggancio passa dall'oggetto
  //     segnalato (voce di diario / media / thread), via tipo_oggetto + oggetto_id
  //     o thread_id. Ogni ramo degrada in silenzio se lo schema C5 è assente.
  let segnalazioniBonificate = 0
  let sospensioniBonificate = 0

  // 3f-a) Segnalazioni su voci di diario dell'alunno.
  const { data: diarioRows, error: errDiario } = await supabase
    .from('eventi_diario')
    .select('id')
    .eq('alunno_id', alunno.id)
  if (errDiario && !schemaAssente(errDiario)) {
    logErrore({ operazione: op, evento: 'oblio_segnalazioni_diario_select' }, errDiario)
  }
  const diarioIds = ((diarioRows ?? []) as { id: string }[]).map((d) => d.id)
  if (diarioIds.length > 0) {
    const { data: segDiario, error: errSegD } = await supabase
      .from('segnalazioni')
      .update({ motivo: null, note_gestione: null })
      .eq('tipo_oggetto', 'voce_diario')
      .in('oggetto_id', diarioIds)
      .select('id')
    if (errSegD) {
      if (!schemaAssente(errSegD)) logErrore({ operazione: op, evento: 'oblio_segnalazioni_diario' }, errSegD)
    } else {
      segnalazioniBonificate += (segDiario ?? []).length
    }
  }

  // 3f-b) Segnalazioni su media di galleria taggati all'alunno.
  const { data: mediaRows, error: errMedia } = await supabase
    .from('galleria_media_v2')
    .select('id')
    .contains('tag_students', [alunno.id])
  if (errMedia && !schemaAssente(errMedia)) {
    logErrore({ operazione: op, evento: 'oblio_segnalazioni_media_select' }, errMedia)
  }
  const mediaIds = ((mediaRows ?? []) as { id: string }[]).map((m) => m.id)
  if (mediaIds.length > 0) {
    const { data: segMedia, error: errSegM } = await supabase
      .from('segnalazioni')
      .update({ motivo: null, note_gestione: null })
      .eq('tipo_oggetto', 'media_galleria')
      .in('oggetto_id', mediaIds)
      .select('id')
    if (errSegM) {
      if (!schemaAssente(errSegM)) logErrore({ operazione: op, evento: 'oblio_segnalazioni_media' }, errSegM)
    } else {
      segnalazioniBonificate += (segMedia ?? []).length
    }
  }

  // 3f-c) Segnalazioni sui messaggi + sospensioni dei thread di chat dell'alunno.
  //       Un alunno ha DUE genitori (student_parents molti-a-molti): se solo uno
  //       chiede la cancellazione, un thread con l'ALTRO genitore (non
  //       anonimizzato) o con la maestra non verrebbe mai toccato dallo scrub di
  //       anonimizzaParent — questo è l'unico ramo che lo copre.
  const { data: threadRows, error: errThread } = await supabase
    .from('chat_threads')
    .select('id')
    .eq('student_id', alunno.id)
  if (errThread && !schemaAssente(errThread)) {
    logErrore({ operazione: op, evento: 'oblio_segnalazioni_thread_select' }, errThread)
  }
  const threadIds = ((threadRows ?? []) as { id: string }[]).map((t) => t.id)
  if (threadIds.length > 0) {
    const { data: segChat, error: errSegC } = await supabase
      .from('segnalazioni')
      .update({ motivo: null, note_gestione: null })
      .eq('tipo_oggetto', 'messaggio_chat')
      .in('thread_id', threadIds)
      .select('id')
    if (errSegC) {
      if (!schemaAssente(errSegC)) logErrore({ operazione: op, evento: 'oblio_segnalazioni_chat' }, errSegC)
    } else {
      segnalazioniBonificate += (segChat ?? []).length
    }

    const { data: sospChat, error: errSospC } = await supabase
      .from('conversazioni_sospensioni')
      .update({ motivo: null })
      .in('thread_id', threadIds)
      .select('id')
    if (errSospC) {
      if (!schemaAssente(errSospC)) logErrore({ operazione: op, evento: 'oblio_sospensioni_chat' }, errSospC)
    } else {
      sospensioniBonificate += (sospChat ?? []).length
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

  return { riconciliazione, incassi, cassa, file, segnalazioniBonificate, sospensioniBonificate }
}
