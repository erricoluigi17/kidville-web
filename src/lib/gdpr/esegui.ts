import type { SupabaseClient } from '@supabase/supabase-js'
import {
  patchAlunno,
  patchParent,
  scrubSuggerimenti,
  scrubDomandaIscrizione,
  type SoggettiIscrizione,
} from '@/lib/gdpr/anonimizza'
import { scrubProvaConsensi } from '@/lib/gdpr/consensi-oblio'
import { schemaAssente } from '@/lib/news/schema-assente'
import { BUCKET_GALLERIA, percorsoNelBucket } from '@/lib/gallery/storage'
import { logErrore, logEvento } from '@/lib/logging/logger'

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

/** Il bucket degli allegati del modulo d'iscrizione (documenti d'identità). */
export const BUCKET_ISCRIZIONI = 'form_attachments'

// =============================================================================
// S22 — L'OBLIO SEGUE IL DATO, NON LA RIGA.
//
// Fino al 2026-07-31 questo modulo ragionava per RIGHE: azzerava le colonne di
// `alunni`/`parents` e si fermava lì. Due conseguenze misurate sul campo:
//
//  · la DOMANDA DI ISCRIZIONE — la tabella di ORIGINE, quella che ha raccolto
//    tutto, comprese allergie e note mediche del minore — non era toccata da
//    nessuno dei tre canali di oblio;
//  · il documento d'identità degli ADULTI non usciva MAI dallo storage. Il
//    percorso veniva azzerato in `parents.documento_path` (e questo faceva
//    *sembrare* che il file fosse sparito) mentre l'oggetto restava nel bucket,
//    e il suo percorso restava per giunta leggibile dentro la domanda.
//
// Un dato cancellato a metà è un dato non cancellato: su una richiesta GDPR
// diventa una risposta falsa data a una famiglia. Da qui la regola operativa di
// queste tre funzioni: **ogni oblio parziale deve essere VISIBILE** — conteggio
// dei file non rimossi nel valore di ritorno, nella risposta HTTP e nel log.
// =============================================================================

/**
 * Scrubba dentro `enrollment_submissions` le persone che sono soggetto
 * dell'oblio (per codice fiscale o per percorso dell'allegato), e restituisce i
 * `documento_path` incontrati: sono file da togliere dallo storage, e per gli
 * ADULTI la domanda è l'unico posto che li conosce ancora.
 *
 * NON si restringe alla sede: il titolare del trattamento è la cooperativa, una
 * sola per i tre plessi, e lo stesso bambino può aver presentato domanda in due
 * sedi. Chi ha diritto all'oblio ne ha diritto ovunque il dato sia finito; la
 * verifica di CHI può chiedere l'oblio è a monte, nella route (`assertAlunnoInScope`).
 *
 * Mai PII nei log: solo conteggi. Degrada in silenzio se la tabella non c'è (DB
 * E2E della CI non migrato).
 */
export async function obliaIscrizioni(
  supabase: SupabaseClient,
  soggetti: SoggettiIscrizione,
  at: string,
  op: string,
): Promise<{ domandeScrubbate: number; documenti: string[] }> {
  // Varianti del CF da cercare: `@>` è sensibile alle maiuscole, e la famiglia
  // scrive il codice fiscale come le pare. Il match definitivo lo rifà comunque
  // `scrubDomandaIscrizione`, che confronta normalizzato.
  const cfVarianti = new Set<string>()
  for (const raw of soggetti.codiciFiscali ?? []) {
    const v = typeof raw === 'string' ? raw.trim() : ''
    if (!v) continue
    cfVarianti.add(v)
    cfVarianti.add(v.toUpperCase())
  }
  const pathCercati = new Set(
    (soggetti.documentoPaths ?? [])
      .map((v) => (typeof v === 'string' ? v.trim() : ''))
      .filter((v) => v.length > 0),
  )
  if (cfVarianti.size === 0 && pathCercati.size === 0) return { domandeScrubbate: 0, documenti: [] }

  // Le domande candidate si raccolgono PRIMA e si scrivono UNA volta sola: una
  // domanda che contiene sia il bambino sia il genitore non va riscritta due
  // volte (la seconda ripartirebbe dal `data` già letto, non da quello scritto).
  const candidate = new Map<string, unknown>()
  const filtri: Record<string, unknown>[] = []
  for (const ramo of ['children', 'adults'] as const) {
    for (const cf of cfVarianti) {
      filtri.push({ [ramo]: [{ codice_fiscale: cf }] })
      filtri.push({ [ramo]: [{ fiscal_code: cf }] })
    }
    for (const p of pathCercati) filtri.push({ [ramo]: [{ documento_path: p }] })
  }

  for (const filtro of filtri) {
    const { data, error } = await supabase
      .from('enrollment_submissions')
      .select('id, data')
      .contains('data', filtro)
    if (error) {
      if (!schemaAssente(error)) logErrore({ operazione: op, evento: 'oblio_iscrizioni_select' }, error)
      // Fermarsi al primo errore: se la tabella non è leggibile, insistere con
      // gli altri filtri produrrebbe solo altre righe di log identiche.
      return { domandeScrubbate: 0, documenti: [] }
    }
    for (const r of (data ?? []) as { id: string; data: unknown }[]) {
      if (!candidate.has(r.id)) candidate.set(r.id, r.data)
    }
  }

  let domandeScrubbate = 0
  const documenti: string[] = []
  for (const [id, dataOriginale] of candidate) {
    const scrub = scrubDomandaIscrizione(dataOriginale, soggetti, at)
    if (scrub.personeScrubbate === 0) continue
    const { error: errUpd } = await supabase
      .from('enrollment_submissions')
      .update({ data: scrub.data, updated_at: at })
      .eq('id', id)
    if (errUpd) {
      // Non si tace: questa è la riga che conserva il codice fiscale e i dati
      // sanitari di un minore. Se l'UPDATE non passa, l'oblio è parziale.
      logErrore({ operazione: op, evento: 'oblio_iscrizioni_update' }, errUpd)
      continue
    }
    domandeScrubbate++
    documenti.push(...scrub.documenti)
  }

  // Evento critico → si logga anche il SUCCESSO (una riga, solo conteggi):
  // senza, «nessun log» non distinguerebbe «niente da fare» da «non è mai
  // partito niente». `gdpr` è in EVENTI_PERSISTITI: la riga resta in app_log.
  if (candidate.size > 0) {
    logEvento('gdpr', 'info', {
      operazione: op,
      esito: 'oblio-iscrizioni',
      n_domande: domandeScrubbate,
      n_file: documenti.length,
    })
  }
  return { domandeScrubbate, documenti: [...new Set(documenti)] }
}

/**
 * Rimuove dallo storage i file di un oblio, CONTANDO quelli che non sono usciti.
 *
 * Sostituisce il `try { … } catch { /* ignora *\/ }` che c'era prima e che non
 * lasciava traccia di niente: se la rimozione falliva, il documento d'identità
 * di un minore restava nel bucket e nessuno lo sapeva — né chi aveva eseguito
 * l'oblio, né la famiglia che l'aveva chiesto.
 *
 * Nel log MAI il percorso: contiene l'uuid di chi ha caricato e il nome del file
 * scelto dalla famiglia, che quasi sempre è il nome di una persona.
 */
export async function rimuoviFileOblio(
  supabase: SupabaseClient,
  bucket: string,
  percorsi: (string | null | undefined)[],
  op: string,
): Promise<{ rimossi: number; nonRimossi: number }> {
  const unici = [
    ...new Set(
      percorsi.map((p) => (typeof p === 'string' ? p.trim() : '')).filter((p) => p.length > 0),
    ),
  ]
  if (unici.length === 0) return { rimossi: 0, nonRimossi: 0 }

  try {
    const { data, error } = await supabase.storage.from(bucket).remove(unici)
    if (error) {
      logEvento('storage', 'error', {
        operazione: op,
        esito: 'oblio-file-non-rimosso',
        bucket,
        n_file: unici.length,
      }, error)
      return { rimossi: 0, nonRimossi: unici.length }
    }
    // Lo Storage risponde con gli oggetti effettivamente rimossi: un percorso
    // che non c'era più non è un guasto (l'esito voluto è comunque raggiunto),
    // ma va detto — è il segnale di un oblio già eseguito, o di un percorso
    // scritto in tabella e mai caricato.
    const rimossi = Array.isArray(data) ? data.length : unici.length
    if (rimossi < unici.length) {
      logEvento('gdpr', 'info', {
        operazione: op,
        esito: 'oblio-file-gia-assenti',
        bucket,
        n_file: unici.length - rimossi,
      })
    }
    logEvento('gdpr', 'info', { operazione: op, esito: 'oblio-file-rimossi', bucket, n_file: rimossi })
    return { rimossi, nonRimossi: 0 }
  } catch (e) {
    // Guasto di TRASPORTO: `remove()` non ritorna, lancia. Stesso trattamento —
    // e soprattutto stessa VISIBILITÀ — dell'errore restituito.
    logEvento('storage', 'error', {
      operazione: op,
      esito: 'oblio-file-non-rimosso',
      bucket,
      n_file: unici.length,
    }, e)
    return { rimossi: 0, nonRimossi: unici.length }
  }
}

/**
 * Oblio delle FOTO del minore in galleria.
 *
 * `esegui.ts` bonificava le *segnalazioni* sui media, ma il media restava: riga,
 * file nel bucket e uuid del bambino dentro `tag_students`. L'informativa
 * pubblicata promette «fotografie e video: fino alla revoca del consenso e
 * comunque non oltre la durata dell'iscrizione».
 *
 * Due comportamenti, deliberatamente diversi:
 *  · foto in cui il minore è l'UNICO taggato → la riga si cancella e il file
 *    esce dal bucket: quel contenuto riguarda solo lui;
 *  · foto di GRUPPO → si toglie soltanto il suo tag. Dentro c'è l'immagine di
 *    altri bambini, e l'oblio di uno non autorizza a cancellare il dato altrui;
 *    ciò che si rimuove è il collegamento identificante «questo è X».
 */
export async function obliaFotoAlunno(
  supabase: SupabaseClient,
  alunnoId: string,
  op: string,
): Promise<{ fotoRimosse: number; fotoSganciate: number; fileNonRimossi: number }> {
  const { data, error } = await supabase
    .from('galleria_media_v2')
    .select('id, file_url, tag_students')
    .contains('tag_students', [alunnoId])
  if (error) {
    if (!schemaAssente(error)) logErrore({ operazione: op, evento: 'oblio_galleria_select' }, error)
    return { fotoRimosse: 0, fotoSganciate: 0, fileNonRimossi: 0 }
  }

  const righe = (data ?? []) as { id: string; file_url?: string | null; tag_students?: unknown }[]
  const daCancellare: string[] = []
  const fileDaRimuovere: string[] = []
  let fotoSganciate = 0

  for (const r of righe) {
    const tags = Array.isArray(r.tag_students) ? (r.tag_students as string[]) : []
    const altri = [...new Set(tags.filter((t) => t && t !== alunnoId))]
    if (altri.length === 0) {
      daCancellare.push(r.id)
      const p = percorsoNelBucket(r.file_url)
      if (p) fileDaRimuovere.push(p)
      continue
    }
    const { error: errU } = await supabase
      .from('galleria_media_v2')
      .update({ tag_students: altri })
      .eq('id', r.id)
    if (errU) logErrore({ operazione: op, evento: 'oblio_galleria_untag' }, errU)
    else fotoSganciate++
  }

  let fotoRimosse = 0
  let fileNonRimossi = 0
  if (daCancellare.length > 0) {
    const { error: errDel } = await supabase.from('galleria_media_v2').delete().in('id', daCancellare)
    if (errDel) {
      logErrore({ operazione: op, evento: 'oblio_galleria_delete' }, errDel)
    } else {
      fotoRimosse = daCancellare.length
      // Il file si toglie DOPO la riga: se la DELETE non passa, cancellare
      // l'immagine lascerebbe in galleria una scheda rotta al posto di una foto.
      const esito = await rimuoviFileOblio(supabase, BUCKET_GALLERIA, fileDaRimuovere, op)
      fileNonRimossi = esito.nonRimossi
    }
  }
  return { fotoRimosse, fotoSganciate, fileNonRimossi }
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
): Promise<{
  newsVisualizzazioniRimosse: number
  segnalazioniBonificate: number
  sospensioniBonificate: number
  provaConsensiScrubbate: number
  iscrizioniScrubbate: number
  fileRimossi: number
  fileNonRimossi: number
}> {
  // 1. Raccogli PRIMA dell'azzeramento: l'`auth_user_id` (ponte verso lo
  //    spazio-id `utenti`), il codice fiscale e il percorso del documento
  //    d'identità. `patchParent` li azzera tutti e tre, e senza il CF non si
  //    ritrova più la domanda d'iscrizione in cui quell'adulto compare — che è
  //    esattamente il modo in cui il difetto era diventato invisibile.
  let pRow: Record<string, unknown> | null = null
  {
    const esteso = await supabase
      .from('parents')
      .select('auth_user_id, fiscal_code, documento_path')
      .eq('id', parentId)
      .maybeSingle()
    if (esteso.error && schemaAssente(esteso.error)) {
      // DB E2E della CI non migrato: una colonna in meno non può far perdere
      // anche l'`auth_user_id`, da cui dipendono news/segnalazioni/sospensioni.
      const minimo = await supabase.from('parents').select('auth_user_id').eq('id', parentId).maybeSingle()
      if (minimo.error && !schemaAssente(minimo.error)) {
        logErrore({ operazione: op, evento: 'raccolta_auth_parent' }, minimo.error)
      }
      pRow = (minimo.data as Record<string, unknown> | null) ?? null
    } else {
      if (esteso.error) logErrore({ operazione: op, evento: 'raccolta_auth_parent' }, esteso.error)
      pRow = (esteso.data as Record<string, unknown> | null) ?? null
    }
  }
  const authUserId = (pRow?.auth_user_id as string | null) ?? null
  const cfParent = (pRow?.fiscal_code as string | null) ?? null
  const docParent = (pRow?.documento_path as string | null) ?? null

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

  // 5. Prova del consenso (W5): si tolgono `ip` e `user_agent`, si lascia il
  //    resto. La tabella `consensi_accettazioni` non ha FK verso `parents` —
  //    apposta, per sopravvivere a questa anonimizzazione — e proprio per questo
  //    restava fuori dall'oblio: l'IP di una famiglia rimaneva in tabella senza
  //    scadenza, agganciato a un `parent_id` ancora unico. Il fatto e la
  //    versione accettata restano: sono loro la prova, non l'indirizzo di rete.
  //    Lo scrub è per `parents.id` (spazio-id corretto: è quello che scrive
  //    `api/parent/onboarding`), non per l'auth id.
  const provaConsensiScrubbate = await scrubProvaConsensi(supabase, parentId, op)

  // 6. La DOMANDA DI ISCRIZIONE (privacy F2) e il DOCUMENTO D'IDENTITÀ (F3).
  //    L'adulto si aggancia per codice fiscale o per percorso dell'allegato; i
  //    percorsi che la domanda restituisce si sommano a quello dell'anagrafica e
  //    si rimuovono in un blocco solo. Prima di oggi nessuna `.remove()` dello
  //    storage riguardava gli adulti: il file restava nel bucket per sempre.
  const iscr = await obliaIscrizioni(supabase, { codiciFiscali: [cfParent], documentoPaths: [docParent] }, at, op)
  const esitoFile = await rimuoviFileOblio(
    supabase,
    BUCKET_ISCRIZIONI,
    [docParent, ...iscr.documenti],
    op,
  )

  return {
    newsVisualizzazioniRimosse,
    segnalazioniBonificate,
    sospensioniBonificate,
    provaConsensiScrubbate,
    iscrizioniScrubbate: iscr.domandeScrubbate,
    fileRimossi: esitoFile.rimossi,
    fileNonRimossi: esitoFile.nonRimossi,
  }
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
  fileNonRimossi: number
  segnalazioniBonificate: number
  sospensioniBonificate: number
  iscrizioniScrubbate: number
  fotoRimosse: number
  fotoSganciate: number
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

  // 3g. Le FOTO del minore (warning privacy, ciclo 2). Va DOPO 3f-b, che si
  //     serve proprio di `galleria_media_v2` per trovare le segnalazioni da
  //     bonificare: cancellare prima i media renderebbe quel ramo cieco.
  const foto = await obliaFotoAlunno(supabase, alunno.id, op)

  // 4. La DOMANDA DI ISCRIZIONE (privacy F2) e i file PII.
  //    La domanda si aggancia per codice fiscale del minore o per percorso del
  //    suo allegato, e restituisce i `documento_path` che solo lei conosce.
  //    I file escono tutti insieme, con il conteggio dei NON rimossi: un oblio
  //    parziale deve essere visibile a chi l'ha eseguito, non finire in un
  //    `catch` muto come accadeva fino al 2026-07-31. Il bucket `fatture` resta
  //    escluso a monte (conservazione fiscale).
  const iscr = await obliaIscrizioni(
    supabase,
    { codiciFiscali: [alunno.codice_fiscale, alunno.fiscal_code], documentoPaths: [alunno.documento_path] },
    at,
    op,
  )
  const esitoFile = await rimuoviFileOblio(
    supabase,
    BUCKET_ISCRIZIONI,
    [alunno.documento_path, ...iscr.documenti],
    op,
  )

  return {
    riconciliazione,
    incassi,
    cassa,
    file: esitoFile.rimossi,
    fileNonRimossi: esitoFile.nonRimossi + foto.fileNonRimossi,
    segnalazioniBonificate,
    sospensioniBonificate,
    iscrizioniScrubbate: iscr.domandeScrubbate,
    fotoRimosse: foto.fotoRimosse,
    fotoSganciate: foto.fotoSganciate,
  }
}
