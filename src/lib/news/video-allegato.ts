// =============================================================================
// IL VIDEO DIVENTA UN ALLEGATO DI BOZZA ORDINARIO — e la promozione non lo sa.
//
// ─── LA DECISIONE, E PERCHÉ COSTA UNA COPIA IN PIÙ (piano V09) ───────────────
//
// Un video di una News nasce fuori da qui: il telefono lo carica in
// `video_originals`, il runner lo converte in una MicroVM e deposita l'uscita in
// `video_processing`. Entrambi i bucket sono privati e nessuno dei due è il posto
// da cui una famiglia legge.
//
// Le strade erano due.
//
//  (1) Lasciare l'uscita dov'è e insegnare alla PUBBLICAZIONE a prenderla di là.
//      Costa zero byte in più e apre un ramo dentro `./media-bozza.ts` — il punto
//      in cui un file smette di essere privato e diventa leggibile da chiunque,
//      senza login, per sempre. È la superficie di privacy più delicata del
//      repository: ci passano le foto dei bambini, e la sua unica virtù è di non
//      avere casi particolari. Un `if (è un video)` lì dentro non aggiunge un
//      ramo: aggiunge un ramo A QUELLA funzione.
//
//  (2) Copiare l'uscita nell'area di sosta `news_bozze` AL MOMENTO DEL `ready`,
//      con la forma esatta che un allegato di bozza ha già —
//      `uploads/<proprietario>/<file>`. Da quell'istante il video è un allegato
//      come una foto: l'editor ne riceve un'anteprima firmata, il gate del
//      consenso lo vede, `promuoviMediaBozza` lo sposta nel bucket pubblico
//      insieme a tutto il resto, e revoca del consenso e diritto all'oblio lo
//      ritrovano dalla riga con le funzioni che già esistono.
//
// È implementata la (2). Il prezzo è una copia lato server in più per video (26
// al giorno, il volume atteso del piano); il ritorno è che il percorso che decide
// che cosa una famiglia vede resta **esattamente com'era**. Il legame è inchiodato
// da `__tests__/lib/news/video-allegato-promozione.test.ts`, che verifica sia il
// passaggio sia l'assenza di qualunque ramo sul video in `./media-bozza.ts`.
//
// ─── PERCHÉ AL `ready` E NON ALLA PUBBLICAZIONE ─────────────────────────────
//
// Perché dopo l'upload il telefono può chiudere l'app: fra la conversione e la
// pubblicazione possono passare giorni, e chi torna a scrivere l'articolo deve
// trovare l'allegato già lì. Consegnare alla pubblicazione vorrebbe dire copiare
// un video dentro la richiesta che sta anche verificando il consenso e scrivendo
// la riga — la più delicata delle tre — e farla fallire per un guasto dello
// Storage.
//
// ─── PERCHÉ `copy()` E NON `download()` + `upload()` ────────────────────────
//
// Perché i byte non devono passare da qui. Un'uscita di questa pipeline arriva a
// 2.000.000.000 byte: scaricarla dentro un'invocazione serverless per ricaricarla
// significa memoria che non c'è e un tetto di 300 secondi che non basta.
// `copy()` è una copia lato Storage: la richiesta parte e torna, i byte no.
// =============================================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { logErrore, logEvento } from '@/lib/logging/logger'
import { bloccanti, rimuoviEVerifica } from '@/lib/storage/rimozione-verificata'

import { NEWS_BUCKET_BOZZE, SCADENZA_ANTEPRIMA_SECONDI } from './media-bozza'

/**
 * L'unico tipo che l'uscita della pipeline può avere.
 *
 * Non è una preferenza: `buildVideoEncodeArgs` produce MP4/H.264 e il runner
 * carica l'uscita dichiarando `content-type: video/mp4`. Il valore è ripetuto qui
 * perché è anche ciò che i DUE bucket di dominio dichiarano di accettare
 * (`news_bozze` e `news`, entrambi con `allowed_mime_types` che elenca
 * `video/mp4`): la corrispondenza è verificata da un test, non data per buona.
 */
export const MIME_ALLEGATO_VIDEO_NEWS = 'video/mp4'

/** L'estensione dell'allegato. Sta accanto al mime perché descrive lo stesso file. */
const ESTENSIONE_ALLEGATO_VIDEO_NEWS = 'mp4'

/**
 * QUANTO PUÒ PESARE UN VIDEO CONVERTITO CHE ENTRA NELLE NEWS: 2 GB.
 *
 * ⚠️ NON è «il tetto delle News alzato». Chi carica un'immagine da
 * `news/upload:POST` passa da un altro controllo, che non cambia: questi 2 GB li
 * usa soltanto la copia LATO SERVER di un file già convertito, già verificato e
 * mai passato da un browser.
 *
 * Il numero non è scelto qui: è lo stesso che la pipeline si dà sull'ingresso
 * (`MAX_VIDEO_INPUT_BYTES`) e che il database impone all'uscita
 * (`video_jobs_output_chk`, `video_job_ready`), ed è quello che i DUE bucket di
 * dominio dichiarano dal 2026-09-18
 * (`supabase/migrations/20260918113000_bucket_news_tetto_video.sql`). La
 * coincidenza fra questa costante e la migrazione è verificata da un test, perché
 * un numero scritto in due posti diverge alla prima modifica — e qui la
 * divergenza ha una forma precisa: un'uscita accettata dal confronto in
 * TypeScript e respinta dallo Storage **dopo** che la conversione è stata pagata.
 */
export const TETTO_VIDEO_NEWS_BYTE = 2_000_000_000

/** Un uuid, e nient'altro: è ciò che finisce dentro un percorso dello Storage. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * I modi in cui una consegna può non riuscire. Vocabolario CHIUSO: il codice
 * finisce in un log su cui si risponde a «perché i video delle News non
 * compaiono?», e una stringa inventata al volo spezza quella domanda in silenzio.
 */
export const CODICI_CONSEGNA_VIDEO_NEWS = [
  /** Proprietario o job non sono uuid: non si costruisce nessun percorso. */
  'PERCORSO_NON_VALIDO',
  /** L'uscita non è nel bucket di lavorazione, o non si è potuto saperlo. */
  'USCITA_NON_TROVATA',
  /** L'uscita non è un `video/mp4` che l'area di sosta possa accettare. */
  'MIME_NON_AMMESSO',
  /** L'uscita supera il tetto dichiarato dal bucket di destinazione. */
  'USCITA_TROPPO_GRANDE',
  /** L'area di sosta non esiste su questo progetto: la migrazione non è arrivata. */
  'BUCKET_BOZZE_MANCANTE',
  /** Lo Storage ha rifiutato la copia per un altro motivo, o non ha risposto. */
  'COPIA_FALLITA',
  /** Copiato, ma senza anteprima: per chi scrive è indistinguibile da un guasto. */
  'ANTEPRIMA_NON_DISPONIBILE',
] as const
export type CodiceConsegnaVideoNews = (typeof CODICI_CONSEGNA_VIDEO_NEWS)[number]

export type EsitoConsegnaVideoNews =
  | {
      ok: true
      /** L'indirizzo FIRMATO e temporaneo che l'editor mette nella bozza. */
      url: string
      /** Il percorso dentro `news_bozze`, nella forma `uploads/<owner>/<file>`. */
      percorso: string
      /** `true` se il file era già di là: una consegna ripetuta non è un errore. */
      giaConsegnato: boolean
    }
  | { ok: false; codice: CodiceConsegnaVideoNews }

/** Il job convertito, ridotto a ciò che serve per consegnarlo. */
export interface JobVideoDaConsegnare {
  /** `video_jobs.id`. */
  id: string
  /** `video_jobs.owner_id`: chi ha caricato, e chi scriverà l'articolo. */
  ownerId: string
  /** `video_jobs.output_bucket`. */
  bucketUscita: string
  /** `video_jobs.output_path`. */
  percorsoUscita: string
}

/**
 * Il MIME senza il suffisso del codec, in minuscolo.
 *
 * ⚠️ IL SUFFISSO NON È UN CASO DI SCUOLA. `MediaRecorder` scrive
 * `video/mp4;codecs=avc1`, e in questo repository il difetto è già costato una
 * correzione: i confronti da sistemare erano DUE, non uno — quello applicativo e
 * quello dello Storage, che confronta la propria `allowed_mime_types` per
 * uguaglianza esatta e rifiuta con un messaggio che non nomina il suffisso.
 */
export function normalizzaMimeAllegato(valore: unknown): string {
  if (typeof valore !== 'string') return ''
  return valore.split(';')[0].trim().toLowerCase()
}

/**
 * Il percorso dell'allegato dentro `news_bozze`.
 *
 * ─── PERCHÉ IL PRIMO SEGMENTO È IL PROPRIETARIO, E NON IL JOB ───────────────
 *
 * Perché `uploads/<utente>/<file>` è l'UNICA traccia di proprietà che questi due
 * bucket portano con sé: `caricatoDa` (`./permanenza-consenso`) legge lì chi ha
 * caricato, e `mediaEstranei` usa quel nome per rifiutare un post che nomina il
 * file di un altro. Mettendoci l'id del job, il video risulterebbe «di nessuno» e
 * la creazione dell'articolo morirebbe con un 403 che nessuno saprebbe spiegare.
 *
 * ─── PERCHÉ IL NOME È L'ID DEL JOB ─────────────────────────────────────────
 *
 * Perché rende la consegna IDEMPOTENTE: ritentarla non produce un secondo file.
 * Un nome casuale, a ogni ritentativo, lascerebbe nell'area di sosta una copia in
 * più che nessuna riga nomina — cioè un orfano, che è la cosa che questa famiglia
 * di funzioni esiste per non produrre.
 *
 * `null` per qualunque valore che non sia un uuid: il percorso finisce dritto in
 * una `copy()` eseguita col service-role, e la forma è l'unica difesa contro un
 * `..` o una barra di troppo.
 */
export function percorsoAllegatoVideoNews(ownerId: unknown, jobId: unknown): string | null {
  if (typeof ownerId !== 'string' || !UUID.test(ownerId)) return null
  if (typeof jobId !== 'string' || !UUID.test(jobId)) return null
  return `uploads/${ownerId}/${jobId}.${ESTENSIONE_ALLEGATO_VIDEO_NEWS}`
}

/** `esiti/x/1/uscita.mp4` → `{ cartella: 'esiti/x/1', nome: 'uscita.mp4' }`. */
function scomponi(percorso: string): { cartella: string; nome: string } {
  const barra = percorso.lastIndexOf('/')
  if (barra < 0) return { cartella: '', nome: percorso }
  return { cartella: percorso.slice(0, barra), nome: percorso.slice(barra + 1) }
}

/** Il `content-type` con cui l'uscita è archiviata, o `null` se non si sa. */
async function mimeDellUscita(
  supabase: SupabaseClient,
  job: JobVideoDaConsegnare,
  operazione: string,
): Promise<{ mime: string; byte: number | null } | null> {
  const { cartella, nome } = scomponi(job.percorsoUscita)
  try {
    const { data, error } = await supabase.storage
      .from(job.bucketUscita)
      .list(cartella, { limit: 100, search: nome })
    if (error) {
      // Il corpo dell'errore dello Storage non si butta via: senza, resterebbe un
      // codice che non dice a nessuno perché un video convertito non è arrivato.
      logEvento(
        'storage',
        'error',
        { operazione, esito: 'uscita-non-trovata', bucket: job.bucketUscita, job_id: job.id },
        error,
      )
      return null
    }
    const riga = (Array.isArray(data) ? data : []).find(
      (o) => (o as { name?: unknown } | null)?.name === nome,
    ) as { metadata?: { mimetype?: unknown; size?: unknown } } | undefined
    if (!riga) {
      logEvento('storage', 'error', {
        operazione,
        esito: 'uscita-non-trovata',
        bucket: job.bucketUscita,
        job_id: job.id,
        msg: `${operazione}: l’uscita convertita non è nel bucket di lavorazione`,
      })
      return null
    }
    const mime = typeof riga.metadata?.mimetype === 'string' ? riga.metadata.mimetype : ''
    const byte = typeof riga.metadata?.size === 'number' ? riga.metadata.size : null
    return { mime, byte }
  } catch (e) {
    // Guasto di TRASPORTO: `list()` non ritorna, lancia. Stesso trattamento e
    // stessa visibilità dell'errore restituito — un catch muto qui sarebbe il
    // guasto invisibile che questo modulo esiste per impedire.
    logEvento(
      'storage',
      'error',
      { operazione, esito: 'uscita-non-trovata', bucket: job.bucketUscita, job_id: job.id },
      e,
    )
    return null
  }
}

/** `true` se il messaggio dello Storage dice «esiste già». */
function giaPresente(messaggio: string): boolean {
  return /already exists|duplicate|resource already exists/i.test(messaggio)
}

/**
 * Consegna l'uscita convertita nell'area di sosta di News, come allegato di bozza.
 *
 * Va chiamata quando il job passa a `ready` — cioè quando il runner ha finito e
 * `video_job_ready` ha scritto `output_bucket`/`output_path`. È IDEMPOTENTE:
 * ripeterla non produce un secondo file e non è un errore.
 *
 * In caso di esito negativo NON si scrive niente da nessuna parte e non resta
 * nessun file a metà strada: il chiamante può ritentare.
 */
export async function consegnaVideoInBozzaNews(
  supabase: SupabaseClient,
  job: JobVideoDaConsegnare,
  operazione: string,
): Promise<EsitoConsegnaVideoNews> {
  const percorso = percorsoAllegatoVideoNews(job.ownerId, job.id)
  if (percorso === null) {
    // Nel log solo gli uuid e i conteggi: mai il valore rifiutato, che arriva da
    // una riga di database e potrebbe essere qualunque cosa.
    logEvento('news', 'error', {
      operazione,
      esito: 'percorso-allegato-non-valido',
      msg: `${operazione}: proprietario o job non sono uuid, nessun allegato consegnato`,
    })
    return { ok: false, codice: 'PERCORSO_NON_VALIDO' }
  }

  const uscita = await mimeDellUscita(supabase, job, operazione)
  if (uscita === null) return { ok: false, codice: 'USCITA_NON_TROVATA' }

  // ─── IL PRIMO CONFRONTO: il gate applicativo, sul mime NORMALIZZATO ────────
  const normalizzato = normalizzaMimeAllegato(uscita.mime)
  if (normalizzato !== MIME_ALLEGATO_VIDEO_NEWS) {
    logEvento('news', 'error', {
      operazione,
      esito: 'mime-non-ammesso',
      bucket: job.bucketUscita,
      job_id: job.id,
      mime: uscita.mime,
      msg: `${operazione}: l’uscita convertita non è un ${MIME_ALLEGATO_VIDEO_NEWS}`,
    })
    return { ok: false, codice: 'MIME_NON_AMMESSO' }
  }

  // ─── IL SECONDO CONFRONTO: quello che fa lo STORAGE, e che nessuno vede ────
  // `copy()` porta con sé il `content-type` dell'oggetto di partenza, e
  // `news_bozze` confronta la propria `allowed_mime_types` per UGUAGLIANZA
  // ESATTA: `video/mp4;codecs=avc1` è contenuto valido e lista non ammessa. Se
  // passasse di qui, il guasto non si vedrebbe adesso ma alla PROMOZIONE — dopo
  // che il consenso è stato verificato — come un 503 opaco su un articolo pronto.
  // Perciò si rifiuta subito, a voce alta, col mime esatto: è un difetto di chi
  // ha scritto l'uscita, e va riparato là.
  if (uscita.mime.trim() !== normalizzato) {
    logEvento('news', 'error', {
      operazione,
      esito: 'mime-col-suffisso-codec',
      bucket: job.bucketUscita,
      job_id: job.id,
      mime: uscita.mime,
      msg: `${operazione}: l’uscita è archiviata con un suffisso di codec che l’area di sosta rifiuta`,
    })
    return { ok: false, codice: 'MIME_NON_AMMESSO' }
  }

  // ─── IL TETTO SI GUARDA PRIMA DI SPEDIRE, NON DOPO ────────────────────────
  // Lo Storage rifiuterebbe comunque — il bucket ha il suo `file_size_limit` — ma
  // lo farebbe alla fine del trasferimento, e con un 4xx opaco invece del codice
  // che dice esattamente cosa non va. `null` (dimensione ignota) non autorizza
  // niente: fa saltare il confronto, e la rete dello Storage resta più sotto.
  if (uscita.byte !== null && uscita.byte > TETTO_VIDEO_NEWS_BYTE) {
    logEvento('news', 'warn', {
      operazione,
      esito: 'uscita-oltre-il-tetto',
      bucket: NEWS_BUCKET_BOZZE,
      job_id: job.id,
      size: uscita.byte,
      limite: TETTO_VIDEO_NEWS_BYTE,
    })
    return { ok: false, codice: 'USCITA_TROPPO_GRANDE' }
  }

  let esitoCopia: { error?: unknown }
  try {
    esitoCopia = await supabase.storage
      .from(job.bucketUscita)
      .copy(job.percorsoUscita, percorso, { destinationBucket: NEWS_BUCKET_BOZZE })
  } catch (e) {
    // Il corpo dell'errore non si butta via nemmeno quando arriva come eccezione.
    logErrore({ operazione, evento: 'storage', stato: 503 }, e)
    return { ok: false, codice: 'COPIA_FALLITA' }
  }

  let giaConsegnato = false
  const errore = esitoCopia.error
  if (errore) {
    const messaggio = (errore as { message?: string }).message ?? ''
    if (giaPresente(messaggio)) {
      // Una consegna ripetuta (ritentativo, o un secondo giro del sorvegliante):
      // non è un errore, ma non è nemmeno silenzio.
      giaConsegnato = true
      logEvento('news', 'info', {
        operazione,
        esito: 'video-gia-consegnato',
        bucket: NEWS_BUCKET_BOZZE,
        job_id: job.id,
      })
    } else if (/bucket not found/i.test(messaggio)) {
      // ⚠️ NESSUN RIPIEGO SUL BUCKET PUBBLICO, e qui si diverge apposta da
      // `news/upload:POST`. Quella route, quando l'area di sosta manca, ricade sul
      // bucket `news` per non spegnere una funzione che esisteva già; qui il
      // ripiego metterebbe il video di un bambino a un indirizzo pubblico PRIMA
      // che qualcuno abbia verificato il consenso — cioè aprirebbe da zero la
      // falla che l'area di sosta esiste per chiudere. Configurazione mancante in
      // produzione = incidente: livello `error`, e col nome del bucket.
      logEvento(
        'storage',
        'error',
        {
          operazione,
          esito: 'bucket-bozze-mancante',
          bucket: NEWS_BUCKET_BOZZE,
          job_id: job.id,
          msg: `${operazione}: l’area di sosta non esiste su questo progetto, nessun allegato consegnato`,
        },
        errore,
      )
      return { ok: false, codice: 'BUCKET_BOZZE_MANCANTE' }
    } else if (/maximum allowed size|payload too large|exceeded the maximum/i.test(messaggio)) {
      // Il tetto del bucket di destinazione è più basso dell'uscita. Merita un
      // codice suo: senza, «i video lunghi non arrivano mai» resterebbe un
      // `COPIA_FALLITA` indistinguibile da un guasto di rete, e la riparazione
      // (alzare il limite dichiarato del bucket) non la troverebbe nessuno.
      logEvento(
        'storage',
        'error',
        {
          operazione,
          esito: 'uscita-oltre-il-tetto-del-bucket',
          bucket: NEWS_BUCKET_BOZZE,
          job_id: job.id,
          size: uscita.byte,
          msg: `${operazione}: l’uscita supera il tetto dichiarato da ${NEWS_BUCKET_BOZZE}`,
        },
        errore,
      )
      return { ok: false, codice: 'USCITA_TROPPO_GRANDE' }
    } else {
      logErrore({ operazione, evento: 'storage', stato: 503 }, errore)
      return { ok: false, codice: 'COPIA_FALLITA' }
    }
  }

  // All'editor serve un'anteprima: un indirizzo FIRMATO e temporaneo, come per
  // ogni altro allegato in sosta. Non finisce mai in `news_posts` — la promozione
  // lo sostituisce con quello definitivo.
  let firmato: string | null = null
  let erroreFirma: unknown
  try {
    const { data, error } = await supabase.storage
      .from(NEWS_BUCKET_BOZZE)
      .createSignedUrl(percorso, SCADENZA_ANTEPRIMA_SECONDI)
    erroreFirma = error
    firmato = data?.signedUrl ?? null
  } catch (e) {
    erroreFirma = e
  }

  if (!firmato) {
    logErrore({ operazione, evento: 'storage', stato: 503 }, erroreFirma)
    if (!giaConsegnato) {
      // La copia l'ha fatta QUESTA chiamata e nessuno la nomina: si annulla, e si
      // VERIFICA che sia uscita davvero (`rimuoviEVerifica`), mai con un `remove`
      // muto — «zero file rimossi su uno» passerebbe per un successo.
      await rimuoviEVerifica(supabase, NEWS_BUCKET_BOZZE, [percorso], operazione)
    }
    // Se invece il file era già di là, toglierlo cancellerebbe l'allegato di una
    // bozza che lo sta già usando: un guasto momentaneo della firma diventerebbe
    // la perdita del lavoro di chi scrive.
    return { ok: false, codice: 'ANTEPRIMA_NON_DISPONIBILE' }
  }

  // Evento critico → si logga anche il SUCCESSO: senza, «nessun log» non
  // distinguerebbe «consegnato» da «non è mai partita nessuna consegna».
  logEvento('news', 'info', {
    operazione,
    esito: 'video-allegato-in-sosta',
    bucket: NEWS_BUCKET_BOZZE,
    mime: MIME_ALLEGATO_VIDEO_NEWS,
    job_id: job.id,
    size: uscita.byte,
    gia_consegnato: giaConsegnato,
  })

  return { ok: true, url: firmato, percorso, giaConsegnato }
}

/**
 * Toglie dall'area di sosta gli allegati video di una bozza che non diventerà mai
 * un articolo — intento ritirato, singolo allegato annullato, oblio in corso.
 *
 * ─── PERCHÉ NON BASTA UN `remove()` ────────────────────────────────────────
 *
 * Perché `remove()` non fallisce sui percorsi che non esistono e restituisce solo
 * ciò che ha davvero tolto: guardare il solo `error` fa passare per successo «zero
 * file rimossi su tre». La regola sta in un posto solo — `rimuoviEVerifica` — e
 * dice di verificare lo STATO, non il conteggio: «non c'è più» è l'esito voluto,
 * «c'è ancora» è un guasto, «non si sa» pure.
 */
export async function ritiraAllegatiVideoNews(
  supabase: SupabaseClient,
  allegati: { ownerId: string; jobIds: string[] },
  operazione: string,
): Promise<{ ritirati: number; trattenuti: number }> {
  const percorsi = allegati.jobIds
    .map((jobId) => percorsoAllegatoVideoNews(allegati.ownerId, jobId))
    .filter((p): p is string => p !== null)
  if (percorsi.length === 0) return { ritirati: 0, trattenuti: 0 }

  const esito = await rimuoviEVerifica(supabase, NEWS_BUCKET_BOZZE, percorsi, operazione)
  if (esito.erroreRimozione) {
    // `rimuoviEVerifica` ha già gridato col corpo dell'errore. Qui si dice solo
    // che nulla è uscito, perché il chiamante decide su questi due numeri.
    return { ritirati: 0, trattenuti: percorsi.length }
  }

  const trattenuti = bloccanti(esito).length
  // `giaAssenti` NON è un guasto e non è nemmeno un mezzo successo: l'esito voluto
  // era già raggiunto (un ritiro precedente, o una consegna mai arrivata in fondo).
  // Contarlo fra i trattenuti bloccherebbe per sempre la pulizia di un lotto in cui
  // un solo file era già uscito — ed è esattamente il difetto che
  // `rimuoviEVerifica` esiste per non far rifare.
  const ritirati = esito.rimossi.length + esito.giaAssenti.length
  // Evento critico → si logga anche il successo: «nessun log» non deve poter
  // significare insieme «ritirati» e «il ritiro non è mai partito».
  logEvento('news', trattenuti > 0 ? 'warn' : 'info', {
    operazione,
    esito: 'allegati-video-ritirati',
    bucket: NEWS_BUCKET_BOZZE,
    n_file: ritirati,
    n_trattenuti: trattenuti,
  })

  return { ritirati, trattenuti }
}
