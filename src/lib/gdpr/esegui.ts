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
import { percorsoNelBucket as percorsoDelBucket } from '@/lib/allegati/storage'
import { BUCKET_CHAT_ALLEGATI, normalizzaAllegatoChat } from '@/lib/chat/allegati'
import { rimuoviEVerifica, bloccanti } from '@/lib/storage/rimozione-verificata'
import { obliaFotoNewsAlunno } from '@/lib/news/permanenza-consenso'
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

/**
 * Svuota il CONTENUTO delle righe di `audit_scritture_docente` che riguardano
 * gli interessati indicati, lasciando in piedi la riga.
 *
 * PERCHÉ ESISTE (collaudo del 2026-08-01). Quella tabella conserva accanto a
 * «chi ha scritto cosa e quando» anche il valore prima/dopo, e da
 * `admin/iscrizioni` ci arrivava il record integrale del bambino: nome, codice
 * fiscale, indirizzo, allergie, note mediche. L'oblio non la toccava affatto.
 * L'unico rimedio era il job di retention a 12 mesi — ma una richiesta di
 * cancellazione va evasa «senza ingiustificato ritardo» (art. 17 GDPR), non
 * l'anno prossimo.
 *
 * Non si CANCELLA la riga: il registro deve continuare a dire che quel giorno
 * quella persona ha fatto quella modifica (art. 5 §2, responsabilizzazione).
 * Si toglie il contenuto, che è la parte che parla dell'interessato — esattamente
 * ciò che fa il job `audit_docente_retention_tick`, solo subito.
 *
 * Ritorna il numero di righe bonificate. Best-effort come il resto del modulo:
 * logga e prosegue, non fa fallire l'oblio.
 */
export async function bonificaAuditScritture(
  supabase: SupabaseClient,
  entitaIds: (string | null | undefined)[],
  op: string,
): Promise<number> {
  const ids = [...new Set(entitaIds.filter((v): v is string => typeof v === 'string' && v.length > 0))]
  // Nessun id ⇒ nessuna scrittura. Un `in` con lista vuota su PostgREST è un
  // filtro che non filtra: bonificherebbe l'INTERA tabella.
  if (ids.length === 0) return 0

  const { data, error } = await supabase
    .from('audit_scritture_docente')
    .update({ valore_prima: null, valore_dopo: null })
    .in('entita_id', ids)
    .select('id')
  if (error) {
    // PostgREST non lancia: ritorna `{ error }`. Un oblio parziale deve essere
    // VISIBILE a chi l'ha eseguito, non finire in un catch muto.
    if (!schemaAssente(error)) logErrore({ operazione: op, evento: 'oblio_audit_scritture' }, error)
    return 0
  }
  const n = (data ?? []).length
  logEvento('gdpr', 'info', { operazione: op, esito: 'audit-scritture-bonificate', n_righe: n })
  return n
}

/** Riga alunno minima necessaria all'anonimizzazione + bonifica finanziaria. */
export interface AlunnoOblio {
  id: string
  documento_path?: string | null
  codice_fiscale?: string | null
  fiscal_code?: string | null
}

/** Il bucket degli allegati del modulo d'iscrizione (documenti d'identità). */
export const BUCKET_ISCRIZIONI = 'form_attachments'

/** Le pagelle in PDF: valutazioni, comportamento, giudizio globale del minore. */
export const BUCKET_PAGELLE = 'pagelle'

/** I certificati medici che le famiglie caricano per il proprio figlio. */
export const BUCKET_CERTIFICATI_MEDICI = 'certificati-medici'

/** I PDF con le credenziali d'accesso — dentro c'è una password in chiaro. */
export const BUCKET_CREDENZIALI = 'credenziali'

// =============================================================================
// IL PASSAGGIO INVERSO — l'oblio si legge dall'elenco dei MAGAZZINI.
//
// Fino al 2026-08-02 questo modulo copriva DUE bucket su tredici:
// `form_attachments` e `gallery`. Non per una svista, ma per il METODO: ogni
// rilievo del collaudo («la domanda d'iscrizione», «il documento d'identità»,
// «le foto») è stato chiuso dentro il suo bucket, e nessuno ha mai fatto il giro
// contrario — prendere l'elenco dei magazzini e chiedere, uno per uno, «chi lo
// svuota quando la famiglia se ne va?».
//
// Risultato misurato in produzione: dopo un oblio restavano le pagelle del
// bambino (32 oggetti), gli allegati scambiati in chat con la scuola (27, dove
// «passano certificati medici, foto di bambini»), i PDF delle credenziali (8),
// il protocollo (2) e l'allegato di un avviso (1). Senza scadenza, e senza che
// nessuno lo sapesse.
//
// Questo registro è il giro contrario, scritto. Ogni bucket dello Storage sta
// qui: o è COPERTO — e allora si dice da quale canale e come — o è ESCLUSO, con
// la ragione accanto, come `fatture` lo era già. **Il terzo caso, «non
// nominato», è quello che ha prodotto il difetto** ed è proprio quello che il
// lock in `__tests__/lib/gdpr-oblio-completo.test.ts` rende impossibile: un
// bucket nuovo resta rosso finché qualcuno non dice chi lo svuota.
//
// Il registro non è la prova: il lock non si fida di questa tabella, esegue
// l'oblio su un client finto e guarda su quali bucket è finita una `remove()`.
// Un registro che dichiara e non fa sarebbe peggio del silenzio.
// =============================================================================

/** Chi può chiedere l'oblio, e quindi da quale funzione passa lo svuotamento. */
export type CanaleOblio = 'alunno' | 'genitore'

export type CoperturaBucket =
  | { stato: 'coperto'; canali: CanaleOblio[]; come: string }
  /**
   * Svuotato, ma NON da `anonimizzaAlunno`/`anonimizzaParent`: da un meccanismo
   * suo, che va nominato in `come` insieme a chi lo verifica.
   *
   * Questo terzo stato nasce il 2026-08-02 per `news` e non è una scappatoia:
   * senza, l'unica alternativa a «coperto» era «escluso», e un'esclusione è una
   * frase che dice «qui dentro non c'è niente di quella famiglia». Su `news` non
   * era vero, ed è così che una motivazione falsa ha superato il lock per due
   * giorni. Un bucket dichiarato qui NON è verificato da questo file: la prova
   * che il meccanismo svuoti davvero va scritta accanto al meccanismo, e per
   * `news` sta in `__tests__/lib/news/permanenza-consenso.test.ts`.
   */
  | { stato: 'coperto-fuori-oblio'; come: string }
  | { stato: 'escluso'; motivo: string }

export const REGISTRO_BUCKET_OBLIO: Record<string, CoperturaBucket> = {
  form_attachments: {
    stato: 'coperto',
    canali: ['alunno', 'genitore'],
    come: '`obliaIscrizioni` + `rimuoviFileOblio`: il documento d’identità del minore e quello degli adulti, agganciati per codice fiscale o per percorso dentro la domanda.',
  },
  gallery: {
    stato: 'coperto',
    canali: ['alunno'],
    come: '`obliaFotoAlunno`: foto del solo minore → riga e file via; foto di gruppo → si toglie il tag e il file resta, perché dentro c’è l’immagine di altri bambini.',
  },
  pagelle: {
    stato: 'coperto',
    canali: ['alunno'],
    come:
      '`obliaPagelleAlunno`: le pagelle sono agganciate a `pagelle.alunno_id`; se ne va la riga e se ne va il PDF. ' +
      'DA CONFERMARE DAL TITOLARE: se il documento di valutazione ricade in un obbligo di conservazione ' +
      'documentale (massimario di scarto del fascicolo dello studente), questa voce va spostata fra gli esclusi ' +
      'con la ragione scritta — come `fatture`. È una decisione legale, non tecnica, e il posto per prenderla è ' +
      'questa riga.',
  },
  'certificati-medici': {
    stato: 'coperto',
    canali: ['alunno'],
    come: '`obliaCertificatiMediciAlunno`: `certificati_medici.alunno_id` → il file e la riga, che porta anche `note` e `nota_validazione` in testo libero.',
  },
  'chat-allegati': {
    stato: 'coperto',
    canali: ['alunno', 'genitore'],
    come: '`obliaAllegatiChat`: i thread del minore (`chat_threads.student_id`) e quelli del genitore (`chat_threads.parent_id`, spazio-id `utenti`); esce il file ed esce il percorso da `chat_messages.attachment_url`.',
  },
  credenziali: {
    stato: 'coperto',
    canali: ['genitore'],
    come: '`obliaPdfCredenziali`: il nome del file è `<id>-<timestamp>.pdf`, si cercano i PDF di `parents.id` e dell’`auth_user_id` collegato.',
  },

  // ── esclusi, con la ragione scritta ────────────────────────────────────────
  fatture: {
    stato: 'escluso',
    motivo:
      'Documento fiscale: il Codice civile (art. 2220) e il DPR 600/1973 impongono dieci anni di conservazione, e l’art. 17 §3 lett. b GDPR fa cadere il diritto alla cancellazione davanti a un obbligo di legge. Era già l’unica esclusione dichiarata prima del 2026-08-02.',
  },
  'cassa-giustificativi': {
    stato: 'escluso',
    motivo:
      'Scontrini e giustificativi del registro di cassa: stessa natura contabile delle fatture e stesso obbligo di conservazione decennale. Il testo libero dei movimenti che cita il minore viene invece bonificato da `anonimizzaAlunno` (punto 3e), perché quello non è un obbligo di legge — è una descrizione scritta a mano.',
  },
  protocollo: {
    stato: 'escluso',
    motivo:
      'Registro di protocollo (DPR 445/2000): è un atto amministrativo che deve poter dire, anche fra anni, che quel documento è entrato o uscito quel giorno. Cancellarne il contenuto su richiesta di un interessato annullerebbe la funzione stessa del registro — art. 17 §3 lett. b GDPR, obbligo legale.',
  },
  avvisi_allegati: {
    stato: 'escluso',
    motivo:
      'Allegati delle comunicazioni che la scuola manda alle famiglie (circolari, moduli, calendari): sono documenti della scuola indirizzati a molti, non dati di un singolo interessato, e non esiste un aggancio fra il file e la persona che chiede l’oblio. Se un allegato contenesse l’elenco nominativo dei bambini sarebbe un difetto di quell’avviso, da correggere lì e non qui.',
  },
  task_allegati: {
    stato: 'escluso',
    motivo:
      'Allegati degli incarichi interni allo staff: riguardano l’organizzazione del lavoro fra colleghi, non la famiglia, e nessuna colonna li lega a un alunno o a un genitore. La cancellazione dell’account di un membro dello staff è un percorso diverso da questo, che è l’oblio dell’interessato-famiglia.',
  },
  news_bozze: {
    stato: 'escluso',
    motivo:
      'Area di sosta dei media di un articolo prima della pubblicazione: i file non sono legati a nessuna persona (nessuna colonna dice di chi è la foto), quindi non c’è niente da agganciare a una richiesta di oblio. Si svuota per SCADENZA, non per interessato — vedi `supabase/migrations/20260801130404_bucket_news_bozze.sql`.',
  },
  news: {
    stato: 'coperto',
    canali: ['alunno'],
    come:
      '`obliaFotoNewsAlunno` (`src/lib/news/permanenza-consenso.ts`), chiamata da `anonimizzaAlunno`: ' +
      'ritira gli articoli che dichiarano il minore fra i ritratti, toglie i loro file dal bucket e ' +
      'cancella il suo uuid dalla dichiarazione. Blog PUBBLICO, servito senza login — perciò, a ' +
      'differenza della galleria, esce il FILE e non solo il tag: lasciarlo vorrebbe dire lasciare ' +
      'online l’immagine di chi ha chiesto la cancellazione. Fino al 2026-08-02 questa voce diceva ' +
      '«escluso: ci vanno solo media editoriali, le foto dei bambini stanno in `gallery`» — frase FALSA, ' +
      'visto che `gate-consenso.ts` esiste apposta per autorizzare le foto di minori col consenso al ' +
      'canale «sito». Al ritiro sincrono si aggiunge la rete del tick, `verificaPermanenzaConsenso` ' +
      '(stesso modulo, ogni 10 minuti), che copre ciò che l’oblio non vede: la REVOCA senza ' +
      'cancellazione, e i post fermi in bozza. A monte vale la regola gemella — un media diventa ' +
      'pubblico solo dopo il gate (`promuoviMediaBozza`) — così la decisione del titolare del ' +
      '2026-07-31 («in `news` solo ciò che può stare pubblico») è fatta rispettare ai due capi.',
  },
}

// ─────────────────────────────────────────────────────────────────────────────
// Le funzioni che svuotano i bucket. Si appoggiano tutte a `rimuoviFileOblio`
// (definita più sotto in questo stesso file), che è il solo punto da cui una
// `remove()` di oblio passa e che a sua volta chiama `rimuoviEVerifica`: la
// regola su cosa significa un `remove()` incompleto vive in un posto solo.
//
// ─── REGOLA COMUNE: PRIMA IL FILE (VERIFICATO), POI LA RIGA ─────────────────
//
// Fino al 2026-08-02 era il contrario, motivato così: «se la DELETE non passa,
// un file tolto lascerebbe in tabella un indice che punta al vuoto». Il conto
// però non torna, e la retention delle iscrizioni — scritta lo stesso giorno,
// nello stesso repo — aveva già scelto l'ordine opposto con la ragione giusta:
//
//   · riga cancellata + file rimasto → il documento di un bambino resta
//     nell'archivio e NON c'è più nessuna riga che lo nomini: invisibile, non
//     cancellato, e senza niente da cui ripartire per toglierlo;
//   · file rimosso + riga rimasta → una scheda rotta a schermo. Un fastidio,
//     visibile e correggibile.
//
// Fra un guasto invisibile e uno visibile si sceglie il secondo. Quindi: si
// tolgono i file, si guarda lo STATO di quelli che non risultano usciti, e si
// cancellano soltanto le righe i cui file sono davvero fuori (o non c'erano
// già più). Le altre restano, e il conteggio dei bloccanti torna al chiamante.
//
// ─── E I PERCORSI CHE NON SI SANNO LEGGERE? ────────────────────────────────
//
// Sono bloccanti anche loro. Prima venivano scartati con un `.filter(p => p !==
// null)` e la riga si cancellava comunque: quel file non era né rimosso né
// contato — zero su zero, la forma perfetta del guasto invisibile. «Non so dove
// sia» non autorizza a distruggere l'unica traccia che dice che esiste.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Toglie i file di UN bucket agganciati all'interessato da UNA tabella-indice,
 * e cancella le righe che li indicizzavano.
 *
 * Sta in un posto solo apposta. `pagelle` e `certificati_medici` hanno la stessa
 * forma (una colonna con l'uuid dell'interessato, una colonna col percorso) e
 * due copie della stessa regola divergono: è già successo in questo repo, con
 * una regola valida per due strade scritta in due punti e corretta in uno.
 */
async function obliaFileDaTabella(
  supabase: SupabaseClient,
  opzioni: {
    tabella: string
    colonnaPercorso: string
    colonnaFiltro: string
    valoreFiltro: string
    bucket: string
    evento: string
    op: string
  },
): Promise<{ rimossi: number; nonRimossi: number; righe: number }> {
  const { tabella, colonnaPercorso, colonnaFiltro, valoreFiltro, bucket, evento, op } = opzioni
  const vuoto = { rimossi: 0, nonRimossi: 0, righe: 0 }
  if (!valoreFiltro) return vuoto

  const { data, error } = await supabase
    .from(tabella)
    .select(`id, ${colonnaPercorso}`)
    .eq(colonnaFiltro, valoreFiltro)
  if (error) {
    // PostgREST non lancia: ritorna `{ error }`. Sullo schema assente (DB E2E
    // della CI non migrato) si tace, su tutto il resto no.
    if (!schemaAssente(error)) logErrore({ operazione: op, evento: `${evento}_select` }, error)
    return vuoto
  }

  // La `select` è composta a runtime (il nome della colonna cambia da tabella a
  // tabella), quindi il tipo che PostgREST inferisce dal letterale non c'è: si
  // passa da `unknown`. Le due colonne lette sono comunque solo `id` e il
  // percorso — nessun campo di contenuto entra mai in memoria.
  const righe = (data ?? []) as unknown as Record<string, unknown>[]
  if (righe.length === 0) return vuoto

  // Ogni riga si porta dietro il SUO percorso fino alla fine: è ciò che permette
  // di trattenere una riga sola invece dell'intero lotto.
  const mappa = righe
    .map((r) => {
      const id = String(r.id ?? '')
      const grezzo = r[colonnaPercorso]
      const testo = typeof grezzo === 'string' ? grezzo.trim() : ''
      // «Nessun allegato» e «allegato che non so leggere» sono due cose diverse:
      // confonderle bloccherebbe l'oblio di ogni riga senza file.
      if (testo.length === 0) return { id, percorso: null, illeggibile: false }
      const p = percorsoDelBucket(bucket, testo)
      return { id, percorso: p, illeggibile: p === null }
    })
    .filter((m) => m.id.length > 0)
  if (mappa.length === 0) return vuoto

  const illeggibili = mappa.filter((m) => m.illeggibile).length
  if (illeggibili > 0) {
    // Mai il percorso nel log: è proprio il valore storto che non si sa leggere,
    // e potrebbe essere qualunque cosa. Solo il conteggio e la tabella.
    logEvento('gdpr', 'error', {
      operazione: op,
      esito: 'oblio-percorso-non-riconosciuto',
      bucket,
      n_file: illeggibili,
      msg: `${op}: ${illeggibili} percorsi di \`${tabella}\` non sono riconoscibili in questo archivio: le righe NON sono state cancellate`,
    })
  }

  // ── PRIMA I FILE ──
  const esito = await rimuoviFileOblio(
    supabase,
    bucket,
    mappa.map((m) => m.percorso),
    op,
  )

  // ── POI LE RIGHE, e solo quelle il cui file è davvero fuori ──
  const cancellabili = mappa.filter(
    (m) => !m.illeggibile && !(m.percorso !== null && esito.fermi.has(m.percorso)),
  )
  const nonRimossi = esito.nonRimossi + illeggibili
  if (cancellabili.length === 0) return { rimossi: esito.rimossi, nonRimossi, righe: 0 }

  const { error: errDel } = await supabase
    .from(tabella)
    .delete()
    .in('id', cancellabili.map((m) => m.id))
  if (errDel) {
    // I file sono già usciti: qui resta un indice che punta al vuoto — visibile,
    // e da correggere. Non si tace: `certificati_medici` porta anche `note` e
    // `nota_validazione`, testo libero scritto da un genitore.
    if (!schemaAssente(errDel)) logErrore({ operazione: op, evento: `${evento}_delete` }, errDel)
    return { rimossi: esito.rimossi, nonRimossi, righe: 0 }
  }
  return { rimossi: esito.rimossi, nonRimossi, righe: cancellabili.length }
}

/**
 * Le PAGELLE del minore: il PDF esce dal bucket e la riga che lo indicizza
 * sparisce. Dentro ci sono i giudizi per disciplina, il comportamento e il
 * giudizio globale — una descrizione del bambino, non un atto contabile.
 */
export async function obliaPagelleAlunno(
  supabase: SupabaseClient,
  alunnoId: string,
  op: string,
): Promise<{ rimossi: number; nonRimossi: number; righe: number }> {
  return obliaFileDaTabella(supabase, {
    tabella: 'pagelle',
    colonnaPercorso: 'file_url',
    colonnaFiltro: 'alunno_id',
    valoreFiltro: alunnoId,
    bucket: BUCKET_PAGELLE,
    evento: 'oblio_pagelle',
    op,
  })
}

/**
 * I CERTIFICATI MEDICI caricati per quel bambino: dato sanitario dell'art. 9,
 * di un minore. Via il file e via la riga, che porta anche `note` e
 * `nota_validazione` — testo libero scritto da un genitore e da chi valida.
 */
export async function obliaCertificatiMediciAlunno(
  supabase: SupabaseClient,
  alunnoId: string,
  op: string,
): Promise<{ rimossi: number; nonRimossi: number; righe: number }> {
  return obliaFileDaTabella(supabase, {
    tabella: 'certificati_medici',
    colonnaPercorso: 'file_path',
    colonnaFiltro: 'alunno_id',
    valoreFiltro: alunnoId,
    bucket: BUCKET_CERTIFICATI_MEDICI,
    evento: 'oblio_certificati_medici',
    op,
  })
}

/**
 * Gli ALLEGATI scambiati in chat nei thread indicati.
 *
 * Il messaggio resta: una conversazione è di due persone, e il testo scritto
 * dall'altra non è oggetto di questa richiesta. Sparisce l'allegato — il file
 * **e** il percorso, che non è un riferimento neutro: contiene l'uuid di chi ha
 * caricato e il nome del file scelto da chi l'ha mandato, che quasi sempre è il
 * nome di una persona o la parola «referto».
 */
export async function obliaAllegatiChat(
  supabase: SupabaseClient,
  threadIds: (string | null | undefined)[],
  op: string,
): Promise<{ rimossi: number; nonRimossi: number }> {
  const ids = [...new Set(threadIds.filter((v): v is string => typeof v === 'string' && v.length > 0))]
  // Nessun thread ⇒ nessuna scrittura: un `in` con lista vuota su PostgREST è un
  // filtro che non filtra, e qui svuoterebbe gli allegati dell'intera scuola.
  if (ids.length === 0) return { rimossi: 0, nonRimossi: 0 }

  const { data, error } = await supabase
    .from('chat_messages')
    .select('id, attachment_url')
    .in('thread_id', ids)
    .not('attachment_url', 'is', null)
  if (error) {
    if (!schemaAssente(error)) logErrore({ operazione: op, evento: 'oblio_chat_allegati_select' }, error)
    return { rimossi: 0, nonRimossi: 0 }
  }

  const righe = ((data ?? []) as { id: string; attachment_url?: string | null }[]).filter(
    (r) => (r.attachment_url ?? '').trim() !== '',
  )
  if (righe.length === 0) return { rimossi: 0, nonRimossi: 0 }

  // `normalizzaAllegatoChat` legge sia il percorso (la forma di oggi) sia gli
  // indirizzi firmati delle righe storiche: la stessa funzione che usa la chat
  // in lettura, non una seconda copia da tenere allineata. Chi non si riconosce
  // resta agganciato alla sua riga: vedi la regola in cima a questa sezione.
  const mappa = righe.map((r) => ({ id: r.id, percorso: normalizzaAllegatoChat(r.attachment_url) }))
  const illeggibili = mappa.filter((m) => m.percorso === null).length
  if (illeggibili > 0) {
    logEvento('gdpr', 'error', {
      operazione: op,
      esito: 'oblio-percorso-non-riconosciuto',
      bucket: BUCKET_CHAT_ALLEGATI,
      n_file: illeggibili,
      msg: `${op}: ${illeggibili} allegati di chat non sono riconoscibili in questo archivio: il percorso NON è stato azzerato`,
    })
  }

  // ── PRIMA I FILE ──
  const esito = await rimuoviFileOblio(
    supabase,
    BUCKET_CHAT_ALLEGATI,
    mappa.map((m) => m.percorso),
    op,
  )

  // ── POI IL PERCORSO IN TABELLA ── e solo per i messaggi il cui file è uscito.
  // Azzerarlo mentre il file resta lo renderebbe irraggiungibile e non
  // cancellato: dentro c'è l'uuid di chi ha caricato e il nome scelto da chi
  // l'ha mandato, che quasi sempre è il nome di una persona o «referto».
  const azzerabili = mappa.filter((m) => m.percorso !== null && !esito.fermi.has(m.percorso))
  const nonRimossi = esito.nonRimossi + illeggibili
  if (azzerabili.length === 0) return { rimossi: esito.rimossi, nonRimossi }

  const { error: errUpd } = await supabase
    .from('chat_messages')
    .update({ attachment_url: null, attachment_type: null })
    .in('id', azzerabili.map((m) => m.id))
  if (errUpd) {
    if (!schemaAssente(errUpd)) logErrore({ operazione: op, evento: 'oblio_chat_allegati_update' }, errUpd)
  }

  return { rimossi: esito.rimossi, nonRimossi }
}

/**
 * I PDF delle CREDENZIALI dell'interessato: dentro c'è una password in chiaro.
 *
 * Qui non c'è nessuna tabella-indice: `admin/regenerate-credentials` scrive il
 * file nella radice del bucket col nome `<id>-<timestamp>.pdf` e lo consegna via
 * link, senza salvarne il percorso da nessuna parte. L'unico modo di ritrovarlo
 * è elencare il bucket e confrontare il PREFISSO — non una sottostringa, che
 * toglierebbe le credenziali a una famiglia che non ha chiesto niente.
 */
export async function obliaPdfCredenziali(
  supabase: SupabaseClient,
  identita: (string | null | undefined)[],
  op: string,
): Promise<{ rimossi: number; nonRimossi: number }> {
  const ids = [...new Set(identita.filter((v): v is string => typeof v === 'string' && v.length > 0))]
  if (ids.length === 0) return { rimossi: 0, nonRimossi: 0 }

  const LIMITE = 1000
  const nomi = new Set<string>()
  for (const id of ids) {
    let elenco: { name?: string | null }[] = []
    try {
      const { data, error } = await supabase.storage
        .from(BUCKET_CREDENZIALI)
        .list('', { limit: LIMITE, search: id })
      if (error) {
        logEvento('storage', 'error', {
          operazione: op,
          esito: 'oblio-credenziali-elenco-non-letto',
          bucket: BUCKET_CREDENZIALI,
        }, error)
        // Non si sa che cosa ci fosse da togliere: l'oblio è potenzialmente
        // parziale e va detto al chiamante, non lasciato a 0 (che vorrebbe dire
        // «niente da fare», ed è l'ambiguità che questo modulo esiste per
        // togliere di mezzo).
        return { rimossi: 0, nonRimossi: ids.length }
      }
      elenco = (data ?? []) as { name?: string | null }[]
    } catch (e) {
      logEvento('storage', 'error', {
        operazione: op,
        esito: 'oblio-credenziali-elenco-non-letto',
        bucket: BUCKET_CREDENZIALI,
      }, e)
      return { rimossi: 0, nonRimossi: ids.length }
    }

    if (elenco.length >= LIMITE) {
      // Pagina piena = elenco troncato: qualche PDF potrebbe non essere stato
      // nemmeno guardato. Un troncamento silenzioso qui varrebbe un oblio
      // dichiarato e non fatto.
      logEvento('gdpr', 'warn', {
        operazione: op,
        esito: 'oblio-credenziali-elenco-troncato',
        bucket: BUCKET_CREDENZIALI,
        n_file: elenco.length,
      })
    }
    for (const o of elenco) {
      const nome = (o?.name ?? '').trim()
      if (nome && nome.startsWith(`${id}-`)) nomi.add(nome)
    }
  }

  return rimuoviFileOblio(supabase, BUCKET_CREDENZIALI, [...nomi], op)
}

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
/**
 * `consents_log` senza l'indirizzo di rete, oppure `undefined` se non c'è niente
 * da togliere — e la differenza fra le due cose è il punto.
 *
 * Ritornare `undefined` significa «non scrivere questa colonna». Serve perché le 93
 * domande raccolte prima dell'informativa hanno `consents_log IS NULL`
 * (migrazione `20260731165941`): sovrascriverle con `{}` cancellerebbe la
 * differenza fra «informativa mai accettata» e «accettata e poi ripulita dall'oblio»,
 * cioè proprio il fatto storico che quella migrazione esiste per conservare.
 *
 * Le chiavi sono quelle misurate in produzione il 2026-08-03:
 * `{ accettato_il, blocchi, ip, userAgent, versione_informativa }`.
 */
function consentsLogSenzaRete(valore: unknown): Record<string, unknown> | undefined {
  if (valore == null || typeof valore !== 'object' || Array.isArray(valore)) return undefined
  const log = valore as Record<string, unknown>
  if (!('ip' in log) && !('userAgent' in log) && !('user_agent' in log)) return undefined
  const fuori = new Set(['ip', 'userAgent', 'user_agent'])
  return Object.fromEntries(Object.entries(log).filter(([k]) => !fuori.has(k)))
}

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
  const candidate = new Map<string, { data: unknown; consentsLog: unknown }>()
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
      // `consents_log` si legge INSIEME a `data`: porta l'ip e lo user-agent della
      // famiglia, e fino al 2026-08-03 nessuno lo toglieva (rilievo `V1`, misurato:
      // 170 righe su 263 lo hanno, tutte e 170 con entrambi i campi).
      .select('id, data, consents_log')
      .contains('data', filtro)
    if (error) {
      if (!schemaAssente(error)) logErrore({ operazione: op, evento: 'oblio_iscrizioni_select' }, error)
      // Fermarsi al primo errore: se la tabella non è leggibile, insistere con
      // gli altri filtri produrrebbe solo altre righe di log identiche.
      return { domandeScrubbate: 0, documenti: [] }
    }
    for (const r of (data ?? []) as { id: string; data: unknown; consents_log?: unknown }[]) {
      if (!candidate.has(r.id)) candidate.set(r.id, { data: r.data, consentsLog: r.consents_log })
    }
  }

  let domandeScrubbate = 0
  const documenti: string[] = []
  for (const [id, riga] of candidate) {
    const scrub = scrubDomandaIscrizione(riga.data, soggetti, at)
    if (scrub.personeScrubbate === 0) continue
    const patch: Record<string, unknown> = { data: scrub.data, updated_at: at }
    // LA PROVA DEL CONSENSO RESTA, L'INDIRIZZO DI RETE NO.
    //
    // Si tolgono `ip` e `userAgent`; restano `accettato_il`, `versione_informativa`
    // e `blocchi`. Sono LORO la prova che l'informativa è stata accettata (art. 5 §2
    // e art. 7 §1 GDPR): l'indirizzo di rete non dimostra niente di più e identifica
    // una persona. È la stessa scelta già fatta per `consensi_accettazioni` in
    // `scrubProvaConsensi` — una regola valida per due archivi non può avere due
    // risposte diverse.
    //
    // Si scrive SOLO se c'era qualcosa da togliere: mettere `{}` dove c'era `null`
    // cancellerebbe la differenza fra «informativa mai accettata» e «accettata e poi
    // ripulita», cioè il fatto storico che la migrazione 20260731165941 esiste
    // apposta per conservare sulle 93 domande raccolte prima dell'informativa.
    const senzaRete = consentsLogSenzaRete(riga.consentsLog)
    if (senzaRete !== undefined) patch.consents_log = senzaRete
    const { error: errUpd } = await supabase
      .from('enrollment_submissions')
      .update(patch)
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
 * Rimuove dallo storage i file di un oblio e dice, percorso per percorso, su
 * quali l'obiettivo NON è raggiunto.
 *
 * ─── IL DIFETTO CHE QUESTA FUNZIONE AVEVA ADDOSSO (misurato il 2026-08-02) ───
 *
 * Fino a oggi guardava soltanto `error`, e nel ramo di successo ritornava
 * letteralmente `nonRimossi: 0`. Ma `supabase.storage.remove()` **non fallisce**
 * sui percorsi che non escono: risponde `error: null` e semplicemente non li
 * nomina. Peggio: quando `data` non era un array contava TUTTI i percorsi come
 * rimossi — cioè trattava «non so» come «fatto». Risultato misurato:
 * `/api/admin/gdpr/erase` rispondeva `n_file_non_rimossi: 0` mentre nell'archivio
 * non era uscito niente, il log `oblio-parziale` non scattava mai, e la riga che
 * indicizzava il documento del bambino era già stata cancellata un attimo prima.
 * Un dato non cancellato e nemmeno più raggiungibile, con «fatto» detto alla
 * famiglia.
 *
 * ─── PERCHÉ ORA È UN GUSCIO SOTTILE SOPRA `rimuoviEVerifica` ────────────────
 *
 * Perché la regola — «si verifica lo STATO, non il conteggio» — era già scritta,
 * in `src/lib/storage/rimozione-verificata.ts`, e agganciata alla SOLA retention
 * delle iscrizioni. Due copie della stessa regola in due file: la seconda diceva
 * il contrario della prima. Qui non se ne scrive una terza: si chiama quella.
 *
 * Nel log MAI il percorso: contiene l'uuid di chi ha caricato e il nome del file
 * scelto dalla famiglia, che quasi sempre è il nome di una persona.
 */
interface EsitoFileOblio {
  /** Usciti adesso dall'archivio. */
  rimossi: number
  /** Ancora presenti, o non verificabili: su questi l'obiettivo NON è raggiunto. */
  nonRimossi: number
  /** Gli stessi percorsi, per chi deve decidere quale riga NON cancellare. */
  fermi: Set<string>
}

/** La stessa normalizzazione di `rimuoviEVerifica`: trim, niente vuoti, niente doppioni. */
function percorsiUnici(percorsi: (string | null | undefined)[]): string[] {
  return [
    ...new Set(
      percorsi.map((p) => (typeof p === 'string' ? p.trim() : '')).filter((p) => p.length > 0),
    ),
  ]
}

async function rimuoviFileOblio(
  supabase: SupabaseClient,
  bucket: string,
  percorsi: (string | null | undefined)[],
  op: string,
): Promise<EsitoFileOblio> {
  const unici = percorsiUnici(percorsi)
  if (unici.length === 0) return { rimossi: 0, nonRimossi: 0, fermi: new Set() }

  const esito = await rimuoviEVerifica(supabase, bucket, unici, op)
  if (esito.erroreRimozione) {
    // `remove()` ha risposto con un errore (o ha lanciato): nessun file è uscito
    // e non c'è niente da verificare. `rimuoviEVerifica` ha già scritto la riga
    // nel canale degli errori — qui si traduce soltanto in «nessuno di questi
    // percorsi è a posto», che è ciò che serve a chi deve decidere se cancellare
    // la riga che li indicizza.
    return { rimossi: 0, nonRimossi: unici.length, fermi: new Set(unici) }
  }

  const fermi = new Set(bloccanti(esito))
  // Evento critico → si logga anche il SUCCESSO, con i conteggi separati: senza,
  // «nessun log» non distinguerebbe «tutto uscito» da «non è mai partito niente».
  logEvento('gdpr', 'info', {
    operazione: op,
    esito: 'oblio-file-rimossi',
    bucket,
    n_file: esito.rimossi.length,
    n_gia_assenti: esito.giaAssenti.length,
    n_bloccanti: fermi.size,
  })
  return { rimossi: esito.rimossi.length, nonRimossi: fermi.size, fermi }
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
  const daCancellare: { id: string; percorso: string | null; illeggibile: boolean }[] = []
  let fotoSganciate = 0

  for (const r of righe) {
    const tags = Array.isArray(r.tag_students) ? (r.tag_students as string[]) : []
    const altri = [...new Set(tags.filter((t) => t && t !== alunnoId))]
    if (altri.length === 0) {
      const testo = (r.file_url ?? '').trim()
      const p = testo.length > 0 ? percorsoNelBucket(testo) : null
      daCancellare.push({ id: r.id, percorso: p, illeggibile: testo.length > 0 && p === null })
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
    const illeggibili = daCancellare.filter((m) => m.illeggibile).length
    if (illeggibili > 0) {
      logEvento('gdpr', 'error', {
        operazione: op,
        esito: 'oblio-percorso-non-riconosciuto',
        bucket: BUCKET_GALLERIA,
        n_file: illeggibili,
        msg: `${op}: ${illeggibili} media della galleria non sono riconoscibili in questo archivio: le righe NON sono state cancellate`,
      })
    }

    // ── PRIMA IL FILE ── (dal 2026-08-02: era il contrario, e una riga cancellata
    // su una foto rimasta nell'archivio è la foto di un bambino che nessuno può
    // più ritrovare per toglierla).
    const esito = await rimuoviFileOblio(
      supabase,
      BUCKET_GALLERIA,
      daCancellare.map((m) => m.percorso),
      op,
    )
    fileNonRimossi = esito.nonRimossi + illeggibili

    // ── POI LA RIGA ──
    const cancellabili = daCancellare.filter(
      (m) => !m.illeggibile && !(m.percorso !== null && esito.fermi.has(m.percorso)),
    )
    if (cancellabili.length > 0) {
      const { error: errDel } = await supabase
        .from('galleria_media_v2')
        .delete()
        .in('id', cancellabili.map((m) => m.id))
      if (errDel) logErrore({ operazione: op, evento: 'oblio_galleria_delete' }, errDel)
      else fotoRimosse = cancellabili.length
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
  /** Dispositivi che smettono di ricevere le notifiche della scuola. */
  pushSubscriptionsRimosse: number
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

  // 3-bis. L'ISCRIZIONE PUSH DI OGNI DISPOSITIVO DI QUESTA IDENTITÀ.
  //
  // Misurato in produzione il 2026-08-03: `push_subscriptions` ha 77 righe, tutte e
  // 77 con lo `user_agent` valorizzato, su 4 utenti — e questo file non la nominava
  // da nessuna parte.
  //
  // È un archivio DIVERSO da quello del rilievo `V1`, che parlava di `consents_log`:
  // quello è una COLONNA jsonb di `enrollment_submissions` (170 righe su 263 con ip e
  // userAgent) e viene ripulito in `obliaIscrizioni`. Il rilievo era esatto; questa è
  // una seconda falla, trovata cercandolo, e nessun tester l'aveva vista.
  //
  // SI CANCELLA LA RIGA, non si scrubba il solo `user_agent`: la riga INTERA è un
  // identificatore. L'`endpoint` è il recapito di quel telefono ed è tutto ciò che
  // serve per continuare a mandargli notifiche. Lasciarla dopo un'anonimizzazione
  // vuol dire che il dispositivo di una famiglia che se n'è andata continua a
  // ricevere le comunicazioni della scuola, agganciato a un `utente_id` che nessuno
  // può più risolvere a una persona: il dato resta e la sua chiave di lettura no.
  //
  // Stessa classe di T17-F1 (il logout che non deregistrava la push): un'iscrizione
  // che sopravvive all'identità che l'ha creata. Lì il rimedio era per il dispositivo,
  // qui per la persona.
  //
  // SPAZIO-ID: `push_subscriptions.utente_id` è scritta con `auth.user.id`
  // (= `utenti.id`), non con `parents.id` — come `news_visualizzazioni` qui sopra.
  // Senza il ponte non si cancella niente: cancellare «a naso» toglierebbe il
  // telefono a un'altra famiglia.
  let pushSubscriptionsRimosse = 0
  if (authUserId) {
    const { data: pushDel, error: errPush } = await supabase
      .from('push_subscriptions')
      .delete()
      .in('utente_id', [authUserId])
      .select('id')
    if (errPush) {
      // PostgREST non lancia: ritorna `{ error }`. Un oblio che fallisce qui e tace
      // fa rispondere «fatto» a una famiglia mentre il suo telefono resta iscritto.
      if (!schemaAssente(errPush)) logErrore({ operazione: op, evento: 'oblio_push_subscriptions' }, errPush)
    } else {
      pushSubscriptionsRimosse = (pushDel ?? []).length
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

  // 6-bis. GLI ALTRI MAGAZZINI dell'adulto (privacy #2 del 2026-08-02).
  //
  //   · gli ALLEGATI DI CHAT dei suoi thread. `chat_threads.parent_id` è in
  //     spazio-id `utenti` (lo scrive la creazione del thread confrontandolo con
  //     `auth.user.id`), quindi si cerca per `authUserId` e NON per `parentId`:
  //     è lo stesso scambio di spazio-id che aveva reso cieco lo scrub delle
  //     segnalazioni, e senza il ponte il ramo si salta invece di filtrare su un
  //     id che in quella colonna non comparirà mai.
  //   · i PDF delle CREDENZIALI, che portano una password in chiaro. Il nome del
  //     file è `<id>-<timestamp>.pdf` e l'`id` può essere l'uno o l'altro dei due
  //     spazi (la route li accetta entrambi come destinatario): si cercano tutti
  //     e due.
  let allegatiChat = { rimossi: 0, nonRimossi: 0 }
  if (authUserId) {
    const { data: threadRows, error: errThread } = await supabase
      .from('chat_threads')
      .select('id')
      .eq('parent_id', authUserId)
    if (errThread) {
      if (!schemaAssente(errThread)) logErrore({ operazione: op, evento: 'oblio_chat_thread_parent' }, errThread)
    } else {
      const threadIds = ((threadRows ?? []) as { id: string }[]).map((t) => t.id)
      allegatiChat = await obliaAllegatiChat(supabase, threadIds, op)
    }
  }
  const credenziali = await obliaPdfCredenziali(supabase, [parentId, authUserId], op)

  // 7. Il REGISTRO DELLE SCRITTURE, per entrambi gli spazi-id dell'adulto:
  //    l'anagrafica (`parents.id`) e l'account (`utenti.id`, via `auth_user_id`).
  //    Chi scrive l'audit usa l'uno o l'altro a seconda del punto della
  //    codebase: cercarne uno solo lascerebbe indietro metà delle righe.
  await bonificaAuditScritture(supabase, [parentId, authUserId], op)

  return {
    newsVisualizzazioniRimosse,
    pushSubscriptionsRimosse,
    segnalazioniBonificate,
    sospensioniBonificate,
    provaConsensiScrubbate,
    iscrizioniScrubbate: iscr.domandeScrubbate,
    // Somma su tutti i bucket, come per l'alunno: il dettaglio per magazzino è
    // nel log di `rimuoviFileOblio`.
    fileRimossi: esitoFile.rimossi + allegatiChat.rimossi + credenziali.rimossi,
    fileNonRimossi: esitoFile.nonRimossi + allegatiChat.nonRimossi + credenziali.nonRimossi,
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

  // 3g-bis. Le foto del minore sul BLOG PUBBLICO. È l'unico bucket servito senza
  //     login: la galleria di 3g è privata, questo no. Fino al 2026-08-03 l'oblio
  //     non ci arrivava da qui — `obliaFotoNewsAlunno` era scritta, testata e non
  //     chiamata da nessuna parte in `src/` — e la copertura passava solo dal
  //     tick, che rilegge i consensi ogni dieci minuti. Dieci minuti sono poco
  //     per un archivio e tanto per una famiglia che ha appena esercitato un
  //     diritto su un indirizzo pubblico. Il tick resta (prende anche i casi che
  //     non passano di qui: la revoca senza oblio, i post fermi in bozza), ma non
  //     è più l'unica cosa.
  const fotoNews = await obliaFotoNewsAlunno(supabase, alunno.id, op)

  // 3h. GLI ALTRI MAGAZZINI (privacy #2 del 2026-08-02). Le pagelle, i
  //     certificati medici e gli allegati scambiati in chat: tre bucket che
  //     nessun canale di oblio aveva mai toccato. Vedi `REGISTRO_BUCKET_OBLIO`
  //     in cima al file — dove sta anche la ragione scritta dei bucket che
  //     restano fuori di proposito.
  //
  //     Gli allegati riusano i `threadIds` già letti al punto 3f-c: una sola
  //     lettura di `chat_threads`, e soprattutto un solo posto in cui è scritto
  //     che i thread di un bambino si trovano per `student_id`.
  const pagelle = await obliaPagelleAlunno(supabase, alunno.id, op)
  const certificati = await obliaCertificatiMediciAlunno(supabase, alunno.id, op)
  const allegatiChat = await obliaAllegatiChat(supabase, threadIds, op)

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

  // 5. Il REGISTRO DELLE SCRITTURE. Ci finisce il diff di ogni modifica fatta
  //    da docenti e segreteria su quel bambino — e, fino al 2026-08-01, il suo
  //    record integrale al momento dell'importazione. La riga resta (dice chi ha
  //    fatto cosa e quando), il contenuto no.
  await bonificaAuditScritture(supabase, [alunno.id], op)

  // I conteggi dei file sono UNA somma su tutti i bucket toccati: chi legge la
  // risposta deve poter chiedere «è uscito tutto?» una volta sola. Il dettaglio
  // per magazzino resta nel log, dove `rimuoviFileOblio` scrive `bucket` e
  // `n_file` a ogni passaggio.
  return {
    riconciliazione,
    incassi,
    cassa,
    file:
      esitoFile.rimossi +
      pagelle.rimossi +
      certificati.rimossi +
      allegatiChat.rimossi +
      fotoNews.fileRimossi,
    fileNonRimossi:
      esitoFile.nonRimossi +
      foto.fileNonRimossi +
      pagelle.nonRimossi +
      certificati.nonRimossi +
      allegatiChat.nonRimossi +
      fotoNews.fileNonRimossi,
    segnalazioniBonificate,
    sospensioniBonificate,
    iscrizioniScrubbate: iscr.domandeScrubbate,
    fotoRimosse: foto.fotoRimosse,
    fotoSganciate: foto.fotoSganciate,
  }
}
