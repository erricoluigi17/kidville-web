import { NextResponse } from 'next/server'

import it from '../../../../messages/it/shared.json'
import { rifiutoSede } from '@/lib/auth/rifiuto-sede'
import { logEvento, type Valore } from '@/lib/logging/logger'
import {
  CHIAVI_MESSAGGIO_VIDEO,
  codiceMessaggioVideo,
  type CanaleVideo,
  type CodiceInternoVideo,
  type CodiceMostratoVideo,
} from '@/lib/media/video/contratto'

/**
 * COME UN ESITO DELLA PIPELINE VIDEO DIVENTA UNA RISPOSTA HTTP.
 *
 * ─── LE DUE METÀ, CHE NON SI SCAMBIANO FRA LORO ──────────────────────────────
 * Al CLIENT una frase comprensibile più un `codice` che il catalogo sa tradurre;
 * al LOG il codice INTERNO, che è l'unica cosa con cui si diagnostica. Sono due
 * pubblici diversi: `ORIGINAL_PATH_TAKEN` a chi ha caricato il video della recita
 * non dice niente, e `VIDEO_RIPROVA` a chi indaga non dice quale dei quindici
 * conflitti è scattato.
 *
 * ─── PERCHÉ QUESTO FILE E NON DUE COPIE NELLE ROUTE ──────────────────────────
 * Una risposta d'errore scritta due volte diverge alla prima modifica — è la
 * stessa ragione per cui `rifiutoSede` esiste, dopo che lo stesso diniego di sede
 * era stato scritto a mano in venti punti con sei frasi diverse. Qui le route
 * sono due e i verbi cinque: senza un posto solo, il `409` della `PATCH` e quello
 * della `POST` sarebbero già due numeri diversi entro un mese.
 *
 * ─── PERCHÉ IL `codice` È SEMPRE UN LETTERALE, ANCHE SE COSTA UNO `switch` ───
 * `__tests__/architecture/errori-con-codice.test.ts` legge il SORGENTE: un
 * `codice: unaVariabile` non lo sa verificare contro `CODICI_ERRORE` né contro i
 * due cataloghi, e la regola che lo scopre («un `codice` che il lock non sa
 * LEGGERE non passa inosservato») è nata proprio da un valore diventato invisibile.
 * Uno `switch` di quindici rami è il prezzo per restare dentro quella misura, e si
 * paga volentieri: l'alternativa è una funzione elegante che nessun lock guarda.
 *
 * ⚠️ `SEDE_DA_SPECIFICARE` NON è un codice di questo modulo: è quello che
 * `rifiutoSede` manda già da 137 route, e passa da lì. Inventarne un secondo per i
 * video vorrebbe dire due frasi diverse per lo stesso rifiuto.
 */

const CATALOGO_IT = it as Record<string, string>

/** La prosa italiana del codice: la STESSA stringa che legge un utente italiano. */
function prosa(codice: Exclude<CodiceMostratoVideo, 'SEDE_DA_SPECIFICARE'>): string {
  return CATALOGO_IT[CHIAVI_MESSAGGIO_VIDEO[codice]] ?? ''
}

/**
 * LO STATO HTTP DI OGNI CODICE DELLA PIPELINE, deciso uno per uno.
 *
 * È un `Record` TOTALE su `CodiceInternoVideo` apposta, come
 * `MAPPA_MESSAGGIO_VIDEO` nel contratto: aggiungere un ramo a `verifyVideoOutput`
 * o un `code` a una RPC senza decidere che numero esce non compila. La decisione
 * va presa, non rimandata a un `?? 500` che trasformerebbe un rifiuto legittimo
 * in un guasto del server — e quindi in una riga `error` persistita e in una
 * segnalazione notturna per qualcosa che ha funzionato come doveva.
 *
 * La distinzione che conta davvero è fra **409** e **500**: `INVALID_STATE` è
 * «l'intento non è nello stato giusto», cioè una richiesta arrivata tardi;
 * `BAD_INPUT` è «la route ha chiamato la RPC con argomenti che non reggono», cioè
 * un difetto NOSTRO. Mescolarli renderebbe illeggibile il contatore di entrambi.
 */
const STATO_HTTP_VIDEO: Record<CodiceInternoVideo, number> = {
  // ── Il file scelto: la persona può fare qualcosa, e il numero lo dice.
  INVALID_FILE_SIZE: 400,
  EMPTY_FILE: 400,
  FILE_TOO_LARGE: 413,
  VIDEO_TOO_LONG: 413,
  MISSING_VIDEO_STREAM: 415,
  ENCRYPTED_VIDEO: 415,
  UNSUPPORTED_CONTAINER: 415,
  UNSUPPORTED_VIDEO_CODEC: 415,
  UNKNOWN_AUDIO_CODEC: 415,

  // ── Il file non si lascia leggere: è il file, non il server.
  INVALID_PROBE: 422,
  UNKNOWN_DURATION: 422,
  DUPLICATE_STREAM_INDEX: 422,
  FFPROBE_ERROR: 422,

  // ── La verifica dell'uscita. Non escono da queste due route (le produce il
  //    worker e finiscono in `video_jobs.error_code`), ma la tabella è totale e
  //    il giorno in cui uscissero devono avere un numero già deciso: 422, perché
  //    la conversione è stata tentata e il risultato non è utilizzabile.
  INVALID_OUTPUT_SIZE: 422,
  OUTPUT_TOO_LARGE: 422,
  INVALID_DECODE_EVIDENCE: 422,
  OUTPUT_DECODE_FAILED: 422,
  OUTPUT_NO_DECODED_FRAMES: 422,
  INVALID_OUTPUT_PROBE: 422,
  OUTPUT_FFPROBE_ERROR: 422,
  OUTPUT_CONTAINER_INVALID: 422,
  OUTPUT_VIDEO_INVALID: 422,
  OUTPUT_ROTATION_INVALID: 422,
  OUTPUT_DIMENSIONS_INVALID: 422,
  OUTPUT_FPS_INVALID: 422,
  OUTPUT_DURATION_UNKNOWN: 422,
  OUTPUT_DURATION_MISMATCH: 422,
  OUTPUT_AUDIO_MISSING: 422,
  OUTPUT_AUDIO_UNEXPECTED: 422,
  OUTPUT_AUDIO_INVALID: 422,
  OUTPUT_NOT_SDR: 422,

  // ── Due processi si sono incrociati: 409, che è la definizione di conflitto.
  INTENT_CHANGED_RETRY: 409,
  FENCE_MISMATCH: 409,
  LEASE_ACTIVE: 409,
  LEASE_EXPIRED: 409,
  LEASE_MISMATCH: 409,
  OUTPUT_CONFLICT: 409,
  SOURCE_CONFLICT: 409,
  ERROR_CONFLICT: 409,
  UNIQUE_CONFLICT: 409,
  IDEMPOTENCY_CONFLICT: 409,
  REVISION_TAKEN: 409,
  REVISION_MISMATCH: 409,
  ORIGINAL_PATH_TAKEN: 409,
  TARGET_CONFLICT: 409,
  SCOPE_CHANGED: 409,

  // ── L'intento è finito, in un modo o nell'altro: la richiesta arriva tardi.
  INTENT_PUBLISHED: 409,
  INTENT_REVOKED: 409,
  INTENT_INACTIVE: 409,
  ALREADY_SUPERSEDED: 409,
  ALREADY_SENT: 409,

  // ── Si chiede di concludere qualcosa che non è ancora pronto: non è un errore,
  //    è un'attesa — ma è comunque un rifiuto, e 409 lo dice senza allarmare.
  JOBS_NOT_READY: 409,
  NOT_CONFIRMED: 409,
  NO_JOBS: 409,
  INVALID_STATE: 409,

  // ── Appartenenza e perimetro.
  NOT_FOUND: 404,
  OWNER_MISMATCH: 403,
  ORIGINAL_PATH_SCOPE: 403,
  SCOPE_REQUIRED: 400,

  // ── Difetti NOSTRI: la route ha chiamato la RPC nel modo sbagliato. 500, e la
  //    riga di `withRoute` che ne segue è quella che si vuole vedere.
  BAD_INPUT: 500,
  SINGLE_JOB_CHANNEL: 500,
  EMPTY_QUEUE: 500,

  // ── IL RUNNER. Questi dieci non escono MAI come stato di una risposta: nascono
  //    nella MicroVM, finiscono in `video_jobs.error_code` e una famiglia li vede
  //    come stato di un job dentro un 200, non come il codice della richiesta.
  //    Stanno qui perché il `Record` è totale — e il valore non è una formalità: se
  //    un giorno uno di loro finisse davvero in una risposta, questo numero decide
  //    se la riga di `withRoute` che ne segue è un guasto da guardare o un rifiuto
  //    ordinario da contare e basta. Sono tutti guasti nostri o della piattaforma,
  //    mai colpa di chi ha caricato: nessun 4xx.
  BUILD_DOWNLOAD_FAILED: 500,
  BUILD_HASH_MISMATCH: 500,
  BUILD_EXTRACT_FAILED: 500,
  BUILD_INCOMPLETE: 500,
  /** La MicroVM non si apre: è la piattaforma che non c'è, e torna da sola. */
  SANDBOX_UNAVAILABLE: 503,
  SOURCE_DOWNLOAD_FAILED: 500,
  PROBE_COMMAND_FAILED: 500,
  ENCODE_FAILED: 500,
  OUTPUT_UPLOAD_FAILED: 500,
  CONVERSION_TIMEOUT: 500,

  // ── Il bordo HTTP: l'app installata non sa parlare con questa pipeline.
  CLIENT_UPDATE_REQUIRED: 409,
}

/** Il numero che esce per un esito della pipeline; ciò che non si riconosce è un guasto. */
export function statoHttpVideo(codice: string | null | undefined): number {
  if (!codice) return 500
  const mappa = STATO_HTTP_VIDEO as Record<string, number | undefined>
  return mappa[codice] ?? 500
}

/**
 * La risposta da mostrare, a partire da un codice MOSTRABILE già deciso.
 *
 * Quindici rami e non una riga sola: vedi la testata. Il `default` non esiste —
 * `CodiceMostratoVideo` è un'unione chiusa, e TypeScript non lascia dimenticarne
 * uno.
 */
export function rispostaVideo(codice: CodiceMostratoVideo, stato: number): NextResponse {
  switch (codice) {
    case 'VIDEO_FILE_NON_VALIDO':
      return NextResponse.json({ error: prosa('VIDEO_FILE_NON_VALIDO'), codice: 'VIDEO_FILE_NON_VALIDO' }, { status: stato })
    case 'VIDEO_TROPPO_GRANDE':
      return NextResponse.json({ error: prosa('VIDEO_TROPPO_GRANDE'), codice: 'VIDEO_TROPPO_GRANDE' }, { status: stato })
    case 'VIDEO_TROPPO_LUNGO':
      return NextResponse.json({ error: prosa('VIDEO_TROPPO_LUNGO'), codice: 'VIDEO_TROPPO_LUNGO' }, { status: stato })
    case 'VIDEO_FORMATO_NON_SUPPORTATO':
      return NextResponse.json({ error: prosa('VIDEO_FORMATO_NON_SUPPORTATO'), codice: 'VIDEO_FORMATO_NON_SUPPORTATO' }, { status: stato })
    case 'VIDEO_PROTETTO':
      return NextResponse.json({ error: prosa('VIDEO_PROTETTO'), codice: 'VIDEO_PROTETTO' }, { status: stato })
    case 'VIDEO_NON_LEGGIBILE':
      return NextResponse.json({ error: prosa('VIDEO_NON_LEGGIBILE'), codice: 'VIDEO_NON_LEGGIBILE' }, { status: stato })
    case 'VIDEO_CONVERSIONE_NON_RIUSCITA':
      return NextResponse.json({ error: prosa('VIDEO_CONVERSIONE_NON_RIUSCITA'), codice: 'VIDEO_CONVERSIONE_NON_RIUSCITA' }, { status: stato })
    case 'VIDEO_RIPROVA':
      return NextResponse.json({ error: prosa('VIDEO_RIPROVA'), codice: 'VIDEO_RIPROVA' }, { status: stato })
    case 'VIDEO_GIA_CONCLUSO':
      return NextResponse.json({ error: prosa('VIDEO_GIA_CONCLUSO'), codice: 'VIDEO_GIA_CONCLUSO' }, { status: stato })
    case 'VIDEO_NON_ANCORA_PRONTO':
      return NextResponse.json({ error: prosa('VIDEO_NON_ANCORA_PRONTO'), codice: 'VIDEO_NON_ANCORA_PRONTO' }, { status: stato })
    case 'VIDEO_NON_TROVATO':
      return NextResponse.json({ error: prosa('VIDEO_NON_TROVATO'), codice: 'VIDEO_NON_TROVATO' }, { status: stato })
    case 'VIDEO_NON_AUTORIZZATO':
      return NextResponse.json({ error: prosa('VIDEO_NON_AUTORIZZATO'), codice: 'VIDEO_NON_AUTORIZZATO' }, { status: stato })
    case 'VIDEO_APP_DA_AGGIORNARE':
      return NextResponse.json({ error: prosa('VIDEO_APP_DA_AGGIORNARE'), codice: 'VIDEO_APP_DA_AGGIORNARE' }, { status: stato })
    case 'VIDEO_OPERAZIONE_NON_RIUSCITA':
      return NextResponse.json({ error: prosa('VIDEO_OPERAZIONE_NON_RIUSCITA'), codice: 'VIDEO_OPERAZIONE_NON_RIUSCITA' }, { status: stato })
    case 'SEDE_DA_SPECIFICARE':
      // La frase del diniego di sede nasce in un posto solo, e non è questo.
      return rifiutoSede('SEDE_DA_SPECIFICARE')
  }
}

/**
 * L'esito di una RPC della pipeline tradotto in risposta, con il codice INTERNO
 * che resta nel log e quello MOSTRABILE che esce.
 *
 * Il log è a livello `warn` e non `error`: un `REVISION_MISMATCH` è il protocollo
 * che funziona, non un guasto. Ma va visto — «nessuna riga» non deve significare
 * insieme «non succede mai» e «succede e non lo sappiamo».
 */
export function rispostaEsitoRpc(
  canale: CanaleVideo,
  operazione: string,
  rpc: string,
  codiceInterno: string | null | undefined,
  contesto: Record<string, Valore> = {},
): NextResponse {
  const stato = statoHttpVideo(codiceInterno)
  const mostrato = codiceMessaggioVideo(codiceInterno)
  logVideo(canale, stato >= 500 ? 'error' : 'warn', {
    operazione,
    esito: 'rpc-rifiutata',
    tipo: rpc,
    error_code: codiceInterno ?? 'SENZA_CODICE',
    stato,
    ...contesto,
  })
  return rispostaVideo(mostrato, stato)
}

/**
 * I DUE CODICI POSTGREST CHE DICONO «QUI LA PIPELINE NON C'È».
 *
 * Le due migrazioni video sono dichiarate `IN_CODA`: sul DB E2E della CI — e in
 * produzione finché non vengono applicate — le tabelle e le funzioni non esistono.
 * PostgREST non lancia: risponde `{ error }` con uno di questi codici, e senza
 * questa lettura la route restituirebbe 500 con lo stack di un guasto che non c'è,
 * facendo cadere la suite per un motivo che non è il suo.
 *
 * `42P01` è la tabella assente, `42883` la funzione; `PGRST202`/`PGRST205` sono i
 * due modi in cui PostgREST dice la stessa cosa a partire dalla propria cache
 * dello schema, cioè anche quando la migrazione È passata ma la cache non si è
 * ancora ricaricata.
 */
const PIPELINE_ASSENTE = new Set(['42P01', '42883', 'PGRST202', 'PGRST205'])

export function pipelineAssente(error: { code?: string } | null | undefined): boolean {
  return PIPELINE_ASSENTE.has(error?.code ?? '')
}

/**
 * La risposta quando la pipeline non è installata su questo impianto.
 *
 * Livello `error` e non `info`: AGENTS §4 — una configurazione mancante è un
 * incidente, non una nota a piè di pagina. E l'evento è `config`, non il canale:
 * qui non si sta dicendo che un video è andato storto, si sta dicendo che
 * l'ambiente non ha ciò che serve per provarci.
 */
export function rispostaPipelineAssente(
  operazione: string,
  passo: string,
  error: { code?: string; message?: string } | null | undefined,
): NextResponse {
  logEvento('config', 'error', {
    operazione,
    esito: 'pipeline-video-non-installata',
    tipo: passo,
    error_code: error?.code ?? 'SENZA_CODICE',
  })
  return rispostaVideo('VIDEO_OPERAZIONE_NON_RIUSCITA', 503)
}

/**
 * L'AREA DI LOG DEL CANALE, e perché due chiamate invece di una.
 *
 * `__tests__/architecture/eventi-log.test.ts` sorveglia il vocabolario di
 * `app_log.evento` leggendo il PRIMO argomento LETTERALE di `logEvento`. Un
 * `logEvento(area, …)` con la variabile non viene visto: uscirebbe dal
 * vocabolario sorvegliato senza che nessuno se ne accorga, ed è esattamente la
 * forma di silenzio che quel lock esiste per impedire (`galleria` accanto a
 * `gallery`, `pagamento` accanto a `pagamenti`).
 *
 * `galleria` e `news` sono entrambi in `EVENTI_PERSISTITI`, quindi anche gli
 * `info` arrivano in tabella: è ciò che rende rispondibile la domanda «ieri
 * qualcuno ha caricato un video, e in quale sede?».
 */
export function logVideo(
  canale: CanaleVideo,
  livello: 'info' | 'warn' | 'error',
  campi: Record<string, Valore>,
): void {
  if (canale === 'news') logEvento('news', livello, campi)
  else logEvento('galleria', livello, campi)
}
